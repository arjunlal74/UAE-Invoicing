-- ===========================================================================
-- Outbound mail accounts
-- ===========================================================================
-- Until now the only way to deliver an invitation was for an administrator to
-- copy the link out of the response and pass it on by hand. These tables hold
-- the SMTP account the platform sends from, configured through the portal
-- rather than through environment variables: the people who need to change a
-- mail password are administrators, not whoever can redeploy the containers.

CREATE TYPE mail_encryption AS ENUM ('NONE', 'STARTTLS', 'SSL');

CREATE TABLE mail_accounts (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Identity as it appears to the recipient: "Your Name" <from_address>.
  display_name     TEXT NOT NULL,
  from_address     TEXT NOT NULL,
  reply_to         TEXT,

  smtp_host        TEXT NOT NULL,
  smtp_port        INTEGER NOT NULL CHECK (smtp_port BETWEEN 1 AND 65535),
  encryption       mail_encryption NOT NULL DEFAULT 'STARTTLS',

  -- A relay on a private network (a dev inbox, or an internal smarthost) takes
  -- no credentials at all, so authentication is optional rather than assumed.
  auth_required    BOOLEAN NOT NULL DEFAULT TRUE,
  username         TEXT,
  password_cipher  TEXT,

  -- Which provider preset (if any) produced these settings. Kept so the portal
  -- can show provider-specific guidance — an app password for Gmail, for
  -- instance — long after the wizard that detected it has closed.
  provider_key     TEXT,

  is_default       BOOLEAN NOT NULL DEFAULT FALSE,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,

  last_tested_at   TIMESTAMPTZ,
  last_test_ok     BOOLEAN,
  last_test_result TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Authentication without a username is a configuration that can only fail at
  -- send time, which is the worst moment to discover it.
  CONSTRAINT mail_auth_needs_username CHECK (NOT auth_required OR username IS NOT NULL)
);

-- Exactly one account can be the default sender. A partial unique index rather
-- than application logic, so two concurrent "make this the default" requests
-- cannot both win.
CREATE UNIQUE INDEX mail_accounts_single_default ON mail_accounts (is_default)
  WHERE is_default;

CREATE TRIGGER mail_accounts_updated_at BEFORE UPDATE ON mail_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Delivery log
-- ---------------------------------------------------------------------------
-- "Did the invitation actually go out?" is the first question an administrator
-- asks, and a queue that has already drained cannot answer it. One row per
-- attempt, so a bounce is visible in the portal instead of only in the logs.

CREATE TABLE mail_deliveries (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mail_account_id UUID REFERENCES mail_accounts(id) ON DELETE SET NULL,

  kind            TEXT NOT NULL,
  to_address      TEXT NOT NULL,
  subject         TEXT NOT NULL,

  status          TEXT NOT NULL DEFAULT 'QUEUED',
  error           TEXT,
  message_id      TEXT,

  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at         TIMESTAMPTZ,

  CONSTRAINT mail_delivery_status CHECK (status IN ('QUEUED', 'SENT', 'FAILED'))
);

CREATE INDEX mail_deliveries_created_idx ON mail_deliveries (created_at DESC);
CREATE INDEX mail_deliveries_user_idx ON mail_deliveries (user_id);

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
-- Neither table is tenant-scoped, so the tenant_isolation policy used elsewhere
-- does not apply. They are still not readable under a tenant connection: the
-- SMTP password is encrypted at rest, but the host, username and the address
-- list in the delivery log should not be reachable from a merchant session
-- even if a query somewhere forgets to filter.

ALTER TABLE mail_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY mail_accounts_platform_only ON mail_accounts AS RESTRICTIVE
  USING (has_platform_access()) WITH CHECK (has_platform_access());
CREATE POLICY mail_accounts_all ON mail_accounts FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE mail_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY mail_deliveries_platform_only ON mail_deliveries AS RESTRICTIVE
  USING (has_platform_access()) WITH CHECK (has_platform_access());
CREATE POLICY mail_deliveries_all ON mail_deliveries FOR ALL USING (true) WITH CHECK (true);
