-- ===========================================================================
-- UAE FTA E-Invoicing Middleware — initial schema
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- --- Enums -----------------------------------------------------------------

CREATE TYPE tenant_status AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED');

CREATE TYPE ingestion_source AS ENUM (
  'REST_API', 'EXCEL_UPLOAD', 'CSV_UPLOAD', 'SFTP', 'POS_CONNECTOR'
);

CREATE TYPE batch_status AS ENUM (
  'UPLOADED', 'PARSING', 'STAGED_WITH_ERRORS', 'VALIDATED',
  'PROCESSING', 'COMPLETED', 'FAILED'
);

CREATE TYPE invoice_type AS ENUM (
  'TAX_INVOICE', 'SIMPLIFIED_TAX_INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE'
);

CREATE TYPE invoice_status AS ENUM (
  'INGESTED', 'VALIDATED', 'VALIDATION_FAILED',
  'SUBMITTED_TO_ASP', 'ACCEPTED_BY_FTA', 'REJECTED_BY_FTA', 'ARCHIVED'
);

CREATE TYPE validation_severity AS ENUM ('INFO', 'WARNING', 'ERROR', 'FATAL');

CREATE TYPE vat_category AS ENUM ('STANDARD', 'ZERO_RATED', 'EXEMPT', 'OUT_OF_SCOPE');

CREATE TYPE user_role AS ENUM (
  'PLATFORM_ADMIN', 'PLATFORM_SUPPORT',
  'TENANT_ADMIN', 'FINANCE_USER', 'DATA_ENTRY_CLERK', 'AUDITOR'
);

CREATE TYPE asp_provider_type AS ENUM ('MOCK', 'GENERIC_REST', 'NATIVE_AS4');

CREATE TYPE asp_connection_status AS ENUM (
  'NOT_CONFIGURED', 'PENDING_REGISTRATION', 'ACTIVE', 'DISABLED'
);

CREATE TYPE transmission_status AS ENUM (
  'PENDING', 'SENT', 'ACKNOWLEDGED', 'ACCEPTED', 'REJECTED', 'FAILED', 'DEAD_LETTERED'
);

-- --- updated_at trigger ----------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- --- Tenants ---------------------------------------------------------------

CREATE TABLE tenants (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_code       VARCHAR(50)  NOT NULL UNIQUE,
  legal_name_en      VARCHAR(255) NOT NULL,
  legal_name_ar      VARCHAR(255) NOT NULL,
  trn                VARCHAR(15)  NOT NULL UNIQUE CHECK (trn ~ '^1[0-9]{14}$'),
  is_vat_group       BOOLEAN      NOT NULL DEFAULT FALSE,
  vat_group_trn      VARCHAR(15)  CHECK (vat_group_trn IS NULL OR vat_group_trn ~ '^1[0-9]{14}$'),
  registered_address JSONB        NOT NULL,
  status             tenant_status NOT NULL DEFAULT 'PENDING',
  status_reason      TEXT,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- A VAT group member must name the group it belongs to; without this the
  -- is_vat_group flag carries no usable information.
  CONSTRAINT vat_group_requires_trn
    CHECK (is_vat_group = FALSE OR vat_group_trn IS NOT NULL)
);

CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Users -----------------------------------------------------------------

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- NULL for platform staff, who are not scoped to any tenant.
  tenant_id      UUID REFERENCES tenants(id) ON DELETE CASCADE,
  email          VARCHAR(255) NOT NULL,
  full_name      VARCHAR(200) NOT NULL,
  role           user_role    NOT NULL,
  password_hash  TEXT,
  mfa_secret     TEXT,
  mfa_enabled    BOOLEAN      NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
  last_login_at  TIMESTAMPTZ,
  failed_logins  INT          NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT users_email_unique UNIQUE (email),
  -- Platform roles must not be tenant-scoped and tenant roles must be. Getting
  -- this wrong produces an account that either sees everything or nothing.
  CONSTRAINT role_matches_scope CHECK (
    (role IN ('PLATFORM_ADMIN', 'PLATFORM_SUPPORT') AND tenant_id IS NULL)
    OR
    (role NOT IN ('PLATFORM_ADMIN', 'PLATFORM_SUPPORT') AND tenant_id IS NOT NULL)
  )
);

CREATE INDEX users_tenant_idx ON users (tenant_id);

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_invites (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  CHAR(64) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX user_invites_user_idx ON user_invites (user_id);

-- Refresh tokens are stored hashed so a database disclosure does not hand over
-- live sessions, and individually so that a single session can be revoked.
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  CHAR(64) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  user_agent  TEXT,
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- --- ASP configuration -----------------------------------------------------

CREATE TABLE tenant_asp_configs (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_type       asp_provider_type NOT NULL DEFAULT 'MOCK',
  display_name        VARCHAR(100) NOT NULL,
  api_endpoint        TEXT NOT NULL DEFAULT '',
  -- AES-256-GCM ciphertext. Swap this column's producer for a KMS/Secrets
  -- Manager reference in production; nothing else needs to change.
  credentials_cipher  TEXT,
  provider_account_id VARCHAR(255),
  webhook_secret_hash CHAR(64),
  status              asp_connection_status NOT NULL DEFAULT 'NOT_CONFIGURED',
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  phase_version       VARCHAR(10) NOT NULL DEFAULT 'PHASE_1',
  notes               TEXT,
  last_tested_at      TIMESTAMPTZ,
  last_test_result    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Only ONE ACTIVE config per tenant. The SRS specified UNIQUE (tenant_id,
-- is_active), which also caps a tenant at one *inactive* row and so makes
-- keeping a history of retired providers impossible. A partial index says what
-- was actually meant.
CREATE UNIQUE INDEX tenant_asp_configs_one_active
  ON tenant_asp_configs (tenant_id) WHERE is_active;

CREATE INDEX tenant_asp_configs_tenant_idx ON tenant_asp_configs (tenant_id);

CREATE TRIGGER tenant_asp_configs_updated_at BEFORE UPDATE ON tenant_asp_configs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Batch uploads ---------------------------------------------------------

CREATE TABLE batch_uploads (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reference          VARCHAR(64) NOT NULL,
  file_name          VARCHAR(255) NOT NULL,
  file_s3_uri        VARCHAR(512) NOT NULL,
  file_hash_sha256   CHAR(64) NOT NULL,
  file_size_bytes    BIGINT NOT NULL DEFAULT 0,
  source             ingestion_source NOT NULL DEFAULT 'EXCEL_UPLOAD',
  total_records      INT NOT NULL DEFAULT 0,
  valid_records      INT NOT NULL DEFAULT 0,
  invalid_records    INT NOT NULL DEFAULT 0,
  submitted_records  INT NOT NULL DEFAULT 0,
  status             batch_status NOT NULL DEFAULT 'UPLOADED',
  parse_error        TEXT,
  uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT batch_reference_unique UNIQUE (tenant_id, reference)
);

CREATE INDEX batch_uploads_tenant_created_idx
  ON batch_uploads (tenant_id, created_at DESC);

CREATE TRIGGER batch_uploads_updated_at BEFORE UPDATE ON batch_uploads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Staging ---------------------------------------------------------------
-- Staged rows are held as JSONB rather than normalised. They are transient
-- working state that the user edits cell by cell, and the shape is exactly the
-- StagedInvoice the grid and the validator both operate on. Normalising here
-- would mean translating on every keystroke-driven re-validation for no gain;
-- the authoritative normalised copy is written to `invoices` on submission.

CREATE TABLE staging_rows (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_id       UUID NOT NULL REFERENCES batch_uploads(id) ON DELETE CASCADE,
  row_index      INT NOT NULL,
  invoice_number VARCHAR(100) NOT NULL DEFAULT '',
  payload        JSONB NOT NULL,
  findings       JSONB NOT NULL DEFAULT '[]'::jsonb,
  submittable    BOOLEAN NOT NULL DEFAULT FALSE,
  -- Set once the row has been promoted into `invoices`.
  invoice_id     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT staging_row_unique UNIQUE (batch_id, row_index)
);

CREATE INDEX staging_rows_batch_idx ON staging_rows (batch_id, row_index);
CREATE INDEX staging_rows_batch_invalid_idx
  ON staging_rows (batch_id) WHERE NOT submittable;

CREATE TRIGGER staging_rows_updated_at BEFORE UPDATE ON staging_rows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Invoices --------------------------------------------------------------

CREATE TABLE invoices (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  batch_upload_id       UUID REFERENCES batch_uploads(id) ON DELETE SET NULL,
  staging_row_id        UUID,
  source_channel        ingestion_source NOT NULL DEFAULT 'EXCEL_UPLOAD',
  excel_row_index       INT,
  peppol_uuid           UUID NOT NULL DEFAULT uuid_generate_v4(),
  invoice_number        VARCHAR(100) NOT NULL,
  invoice_type          invoice_type NOT NULL DEFAULT 'TAX_INVOICE',
  issue_date            DATE NOT NULL,
  issue_time            TIME NOT NULL,
  currency_code         CHAR(3) NOT NULL DEFAULT 'AED',
  exchange_rate         NUMERIC(12, 6) NOT NULL DEFAULT 1.000000,
  seller_trn            VARCHAR(15) NOT NULL,
  seller_name           VARCHAR(255) NOT NULL,
  buyer_trn             VARCHAR(15),
  buyer_name            VARCHAR(255) NOT NULL,
  buyer_emirate         VARCHAR(50),
  po_reference          VARCHAR(100),
  preceding_invoice_id  VARCHAR(100),
  payment_means         VARCHAR(5),
  line_extension_amount NUMERIC(15, 2) NOT NULL,
  tax_exclusive_amount  NUMERIC(15, 2) NOT NULL,
  tax_inclusive_amount  NUMERIC(15, 2) NOT NULL,
  vat_total_amount      NUMERIC(15, 2) NOT NULL,
  payable_amount        NUMERIC(15, 2) NOT NULL,
  payable_amount_aed    NUMERIC(15, 2) NOT NULL,
  status                invoice_status NOT NULL DEFAULT 'INGESTED',
  qr_code_data          TEXT,
  ubl_xml_s3_uri        VARCHAR(512),
  ubl_xml_sha256        CHAR(64),
  raw_payload_json      JSONB,
  fta_rejection_reason  TEXT,
  submitted_at          TIMESTAMPTZ,
  cleared_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The single most important constraint in the schema. Filing the same
  -- invoice number twice with the FTA is a penalty for the merchant, so
  -- uniqueness is enforced by the database rather than by application logic
  -- that a retry could race past.
  CONSTRAINT uq_tenant_invoice_num UNIQUE (tenant_id, invoice_number)
);

CREATE INDEX invoices_tenant_status_idx ON invoices (tenant_id, status);
CREATE INDEX invoices_tenant_issue_date_idx ON invoices (tenant_id, issue_date DESC);
CREATE INDEX invoices_batch_idx ON invoices (batch_upload_id);
CREATE INDEX invoices_buyer_trn_idx ON invoices (tenant_id, buyer_trn);
CREATE INDEX invoices_peppol_uuid_idx ON invoices (peppol_uuid);

-- Free-text search across the fields a finance user actually searches by.
CREATE INDEX invoices_search_idx ON invoices USING GIN (
  to_tsvector('simple',
    coalesce(invoice_number, '') || ' ' ||
    coalesce(buyer_name, '') || ' ' ||
    coalesce(buyer_trn, '') || ' ' ||
    coalesce(po_reference, '')
  )
);

CREATE TRIGGER invoices_updated_at BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE invoice_line_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id      UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_number     INT NOT NULL,
  item_name       TEXT NOT NULL,
  hs_code         VARCHAR(20),
  quantity        NUMERIC(12, 4) NOT NULL,
  unit_of_measure VARCHAR(10) NOT NULL DEFAULT 'PCE',
  unit_price      NUMERIC(15, 4) NOT NULL,
  discount_amount NUMERIC(15, 2) NOT NULL DEFAULT 0,
  vat_category    vat_category NOT NULL DEFAULT 'STANDARD',
  vat_rate        NUMERIC(5, 2) NOT NULL DEFAULT 5.00,
  vat_amount      NUMERIC(15, 2) NOT NULL,
  net_amount      NUMERIC(15, 2) NOT NULL,
  total_amount    NUMERIC(15, 2) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_invoice_line UNIQUE (invoice_id, line_number)
);

CREATE INDEX invoice_line_items_invoice_idx ON invoice_line_items (invoice_id);

-- --- Validation & transmission logs ---------------------------------------

CREATE TABLE validation_logs (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id           UUID REFERENCES invoices(id) ON DELETE CASCADE,
  staging_row_id       UUID REFERENCES staging_rows(id) ON DELETE CASCADE,
  rule_code            VARCHAR(50) NOT NULL,
  severity             validation_severity NOT NULL DEFAULT 'ERROR',
  json_path            VARCHAR(255),
  excel_sheet_name     VARCHAR(100),
  excel_cell_reference VARCHAR(10),
  error_message        TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX validation_logs_invoice_idx ON validation_logs (invoice_id);
CREATE INDEX validation_logs_tenant_rule_idx ON validation_logs (tenant_id, rule_code);

CREATE TABLE transmission_logs (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id            UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  asp_provider          VARCHAR(50) NOT NULL,
  transmission_reference VARCHAR(255),
  attempt               INT NOT NULL DEFAULT 1,
  http_status_code      INT,
  request_headers       JSONB,
  response_payload      JSONB,
  status                transmission_status NOT NULL DEFAULT 'PENDING',
  error_message         TEXT,
  latency_ms            INT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX transmission_logs_invoice_idx ON transmission_logs (invoice_id, created_at DESC);
CREATE INDEX transmission_logs_reference_idx ON transmission_logs (transmission_reference);
CREATE INDEX transmission_logs_tenant_status_idx ON transmission_logs (tenant_id, status);

-- --- Audit -----------------------------------------------------------------
-- Append-only. No updated_at, no UPDATE grant for the app role (see below).

CREATE TABLE audit_trails (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID REFERENCES tenants(id) ON DELETE SET NULL,
  actor_id      UUID,
  actor_type    VARCHAR(50) NOT NULL,
  actor_name    VARCHAR(200),
  action        VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id   VARCHAR(255),
  ip_address    INET,
  user_agent    TEXT,
  changes       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX audit_trails_tenant_created_idx ON audit_trails (tenant_id, created_at DESC);
CREATE INDEX audit_trails_resource_idx ON audit_trails (resource_type, resource_id);
CREATE INDEX audit_trails_actor_idx ON audit_trails (actor_id, created_at DESC);

-- Webhook deliveries are recorded before processing so a replayed delivery is
-- recognised as a duplicate rather than applied twice.
CREATE TABLE webhook_deliveries (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID REFERENCES tenants(id) ON DELETE CASCADE,
  provider       VARCHAR(50) NOT NULL,
  delivery_id    VARCHAR(255) NOT NULL,
  payload        JSONB NOT NULL,
  signature_ok   BOOLEAN NOT NULL,
  processed_at   TIMESTAMPTZ,
  result         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT webhook_delivery_unique UNIQUE (provider, delivery_id)
);

-- ===========================================================================
-- Row-Level Security
-- ===========================================================================
-- Every tenant-scoped table is restricted to the tenant id set on the
-- connection for the duration of a transaction, with an explicit escape hatch
-- for platform staff. Policies are RESTRICTIVE so they AND with anything added
-- later rather than being bypassed by a permissive policy.

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::UUID;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION has_platform_access() RETURNS BOOLEAN AS $$
  SELECT coalesce(current_setting('app.platform_access', true), 'off') = 'on';
$$ LANGUAGE sql STABLE;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'batch_uploads', 'staging_rows', 'invoices', 'invoice_line_items',
    'validation_logs', 'transmission_logs', 'tenant_asp_configs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE
         USING (tenant_id = current_tenant_id() OR has_platform_access())
         WITH CHECK (tenant_id = current_tenant_id() OR has_platform_access())',
      t
    );
    EXECUTE format('CREATE POLICY tenant_all ON %I FOR ALL USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- The audit trail is readable under the same rule but must never be mutated.
ALTER TABLE audit_trails ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_trails FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_trails AS RESTRICTIVE
  USING (tenant_id IS NULL OR tenant_id = current_tenant_id() OR has_platform_access())
  WITH CHECK (true);
CREATE POLICY audit_all ON audit_trails FOR ALL USING (true) WITH CHECK (true);

-- ===========================================================================
-- Privileges for the runtime role
-- ===========================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO uae_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO uae_app;

-- Audit rows are evidence. The application can add to the trail and read it
-- back, and that is all — no UPDATE, no DELETE, enforced by the database
-- rather than by convention.
REVOKE UPDATE, DELETE ON audit_trails FROM uae_app;
