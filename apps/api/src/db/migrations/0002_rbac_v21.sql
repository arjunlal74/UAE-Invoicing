-- ===========================================================================
-- SRS v2.1 — tenancy hierarchy, role model and the CFO approval gate
-- ===========================================================================
-- v2.1 replaces the flat platform/tenant split with a four-tier hierarchy and
-- renames the role set. The rename is destructive (the old enum values stop
-- existing), so the mapping below is the one place that records what each
-- legacy role became.

-- --- Tenancy tiers ---------------------------------------------------------

CREATE TYPE tenant_type AS ENUM (
  'HOST', 'ENTERPRISE_TENANT', 'CHANNEL_PARTNER', 'MANAGED_SUB_TENANT'
);

ALTER TABLE tenants
  ADD COLUMN tenant_type      tenant_type NOT NULL DEFAULT 'ENTERPRISE_TENANT',
  ADD COLUMN parent_tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX tenants_parent_idx ON tenants (parent_tenant_id);

-- Only a managed sub-tenant sits under a parent. An enterprise tenant with a
-- parent would be billed through a partner it has no relationship with.
ALTER TABLE tenants ADD CONSTRAINT tenant_parent_matches_type CHECK (
  (tenant_type = 'MANAGED_SUB_TENANT' AND parent_tenant_id IS NOT NULL)
  OR
  (tenant_type <> 'MANAGED_SUB_TENANT' AND parent_tenant_id IS NULL)
);

-- The SRS makes tenants.trn nullable outright. That would let a company that
-- actually files invoices be onboarded without the number those invoices are
-- filed under. Nullable only for the tiers that never appear as a seller.
ALTER TABLE tenants ALTER COLUMN trn DROP NOT NULL;
ALTER TABLE tenants ADD CONSTRAINT tenant_trn_required_for_filers CHECK (
  tenant_type IN ('HOST', 'CHANNEL_PARTNER') OR trn IS NOT NULL
);

-- A CHECK cannot look at another row, so the parent's tier is enforced here.
CREATE OR REPLACE FUNCTION assert_tenant_hierarchy() RETURNS trigger AS $$
DECLARE
  parent_type tenant_type;
BEGIN
  IF NEW.parent_tenant_id IS NOT NULL THEN
    IF NEW.parent_tenant_id = NEW.id THEN
      RAISE EXCEPTION 'A tenant cannot be its own parent';
    END IF;
    SELECT t.tenant_type INTO parent_type FROM tenants t WHERE t.id = NEW.parent_tenant_id;
    IF parent_type IS DISTINCT FROM 'CHANNEL_PARTNER' THEN
      RAISE EXCEPTION 'A managed sub-tenant must sit under a channel partner';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenants_hierarchy_check
  BEFORE INSERT OR UPDATE OF parent_tenant_id, tenant_type ON tenants
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_hierarchy();

-- --- Roles -----------------------------------------------------------------
-- v1 role                v2.1 role
-- ---------------------  -----------------------------------------------------
-- PLATFORM_ADMIN         GLOBAL_ADMIN
-- PLATFORM_SUPPORT       GLOBAL_ADMIN      (v2.1 has no read-only platform tier)
-- TENANT_ADMIN           COMPANY_ADMIN
-- FINANCE_USER           TAX_APPROVER_CFO  (the v1 role that could submit)
-- DATA_ENTRY_CLERK       ACCOUNTANT
-- AUDITOR                AUDITOR

ALTER TABLE users DROP CONSTRAINT role_matches_scope;

CREATE TYPE user_role_v21 AS ENUM (
  'GLOBAL_ADMIN', 'PARTNER_ADMIN', 'COMPANY_ADMIN',
  'ACCOUNTANT', 'TAX_APPROVER_CFO', 'AUDITOR'
);

ALTER TABLE users
  ALTER COLUMN role TYPE user_role_v21
  USING (
    CASE role::text
      WHEN 'PLATFORM_ADMIN'   THEN 'GLOBAL_ADMIN'
      WHEN 'PLATFORM_SUPPORT' THEN 'GLOBAL_ADMIN'
      WHEN 'TENANT_ADMIN'     THEN 'COMPANY_ADMIN'
      WHEN 'FINANCE_USER'     THEN 'TAX_APPROVER_CFO'
      WHEN 'DATA_ENTRY_CLERK' THEN 'ACCOUNTANT'
      ELSE 'AUDITOR'
    END
  )::user_role_v21;

DROP TYPE user_role;
ALTER TYPE user_role_v21 RENAME TO user_role;

-- GLOBAL_ADMIN is the only tier-1 role and is not scoped to a tenant. Every
-- other role — including PARTNER_ADMIN — belongs to exactly one tenant row.
ALTER TABLE users ADD CONSTRAINT role_matches_scope CHECK (
  (role = 'GLOBAL_ADMIN' AND tenant_id IS NULL)
  OR
  (role <> 'GLOBAL_ADMIN' AND tenant_id IS NOT NULL)
);

-- A partner administrator's authority comes from the partner tenant it hangs
-- off; attached to an ordinary company it would grant sub-tenant powers that
-- have no sub-tenants to apply to.
CREATE OR REPLACE FUNCTION assert_partner_admin_scope() RETURNS trigger AS $$
DECLARE
  owning_type tenant_type;
BEGIN
  IF NEW.role = 'PARTNER_ADMIN' THEN
    SELECT t.tenant_type INTO owning_type FROM tenants t WHERE t.id = NEW.tenant_id;
    IF owning_type IS DISTINCT FROM 'CHANNEL_PARTNER' THEN
      RAISE EXCEPTION 'A partner administrator must belong to a channel partner tenant';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_partner_admin_scope
  BEFORE INSERT OR UPDATE OF role, tenant_id ON users
  FOR EACH ROW EXECUTE FUNCTION assert_partner_admin_scope();

-- --- CFO approval gate -----------------------------------------------------
-- Only a TAX_APPROVER_CFO may file with the FTA. Everyone else's submission
-- parks the invoice here instead of handing it to the ASP.

ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'PENDING_CFO_APPROVAL'
  BEFORE 'SUBMITTED_TO_ASP';

ALTER TABLE invoices
  ADD COLUMN created_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN approved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN approved_at         TIMESTAMPTZ,
  ADD COLUMN approval_note       TEXT;

-- Drives the approval queue. Deliberately not a partial index on the new enum
-- value: PostgreSQL will not accept that literal in the transaction that adds
-- it, and (tenant_id, status) is what every queue query filters on anyway.
CREATE INDEX invoices_tenant_status_created_idx
  ON invoices (tenant_id, status, created_at DESC);
