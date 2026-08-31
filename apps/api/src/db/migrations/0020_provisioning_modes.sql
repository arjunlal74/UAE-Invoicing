-- ---------------------------------------------------------------------------
-- SRS §3 — the two ways a managed sub-tenant is provisioned
-- ---------------------------------------------------------------------------
--
-- Collaborative: the client's own administrator is invited by activation link
-- and works in the portal themselves. That is what every sub-tenant onboarded
-- before this migration was, so it is the default and the backfill is correct
-- by construction rather than by guess.
--
-- Fully managed custody: the partner — usually an auditing firm — holds the
-- account. No activation link is sent, the client has no login of its own, and
-- the partner's own staff sign in and act for it. That last part is why this
-- migration adds a table rather than only a column: "the partner may act for
-- this client" is not a fact about the partner, it is a fact about which named
-- members of its staff were authorised, by whom, and with what authority
-- inside the client's books.

CREATE TYPE provisioning_mode AS ENUM ('COLLABORATIVE', 'FULLY_MANAGED_CUSTODY');

ALTER TABLE tenants
  ADD COLUMN provisioning_mode provisioning_mode NOT NULL DEFAULT 'COLLABORATIVE';

-- Custody is a relationship with a parent, so it is only meaningful for a
-- managed sub-tenant. An enterprise tenant or a partner in custody of itself
-- would be a row nothing in the application knows how to read.
ALTER TABLE tenants ADD CONSTRAINT custody_is_for_sub_tenants
  CHECK (provisioning_mode = 'COLLABORATIVE' OR tenant_type = 'MANAGED_SUB_TENANT');

-- ---------------------------------------------------------------------------
-- Who may act for a custody client
-- ---------------------------------------------------------------------------
--
-- One row per (client, member of partner staff), carrying the role that person
-- holds *inside that client*. The role is on the grant rather than taken from
-- the partner user's own role for two reasons: a partner admin is not
-- automatically entitled to file another company's tax returns, and an auditing
-- firm routinely wants its juniors preparing invoices while only a signatory
-- may submit them — which is exactly the distinction ACCOUNTANT and
-- TAX_APPROVER_CFO already draw inside a tenant.
--
-- Revocation is a timestamp, not a delete: "who was allowed into this client's
-- books last March" is a question an auditor of the auditor will ask.

CREATE TABLE partner_custody_grants (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- The custody sub-tenant whose books this grant opens.
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- The partner's own staff member. Their home tenant is the partner, which is
  -- checked in the application against tenants.parent_tenant_id.
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role               user_role NOT NULL,
  granted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at         TIMESTAMPTZ,
  -- The authority a person can be given inside a client. Deliberately not
  -- GLOBAL_ADMIN or PARTNER_ADMIN: neither means anything inside somebody
  -- else's books, and a grant is not a route to the platform console.
  CONSTRAINT custody_grant_role CHECK (
    role IN ('COMPANY_ADMIN', 'ACCOUNTANT', 'TAX_APPROVER_CFO', 'AUDITOR')
  )
);

-- One live grant per person per client. A change of authority is a revoke and
-- a new grant, which keeps the history readable in the order it happened.
CREATE UNIQUE INDEX partner_custody_grants_live_idx
  ON partner_custody_grants (tenant_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX partner_custody_grants_user_idx ON partner_custody_grants (user_id);

-- ---------------------------------------------------------------------------
-- Custody sessions survive a token refresh
-- ---------------------------------------------------------------------------
--
-- A custody session is a real session whose tenant is the client rather than
-- the partner. Without this column the fifteen-minute access token would expire
-- and the refresh would silently hand back a partner-scoped session — the user
-- would still appear to be working in the client's books while every request
-- had quietly moved back to the partner's. Recording the acting tenant on the
-- refresh row is what makes the refresh give back the session it was given.
ALTER TABLE refresh_tokens
  ADD COLUMN acting_tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Isolation and privileges
-- ---------------------------------------------------------------------------
--
-- Scoped to the client the grant is about, so a custody session can read the
-- authorisations covering the books it is in, and the partner console reaches
-- them the way it reaches everything about its clients: through platform
-- access, filtered on parent_tenant_id.

ALTER TABLE partner_custody_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_custody_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON partner_custody_grants AS RESTRICTIVE
  USING (tenant_id = current_tenant_id() OR has_platform_access())
  WITH CHECK (tenant_id = current_tenant_id() OR has_platform_access());
CREATE POLICY tenant_all ON partner_custody_grants FOR ALL USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO uae_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO uae_app;
REVOKE UPDATE, DELETE ON audit_trails FROM uae_app;
