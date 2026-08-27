-- ===========================================================================
-- The SFTP limb of ingestion channel 1 (SRS v2.1 §1.2: "REST APIs, webhooks,
-- and SFTP listeners for cloud or on-premise ERPs").
--
-- The on-premise half of the channel. An ERP old enough to have no outbound
-- HTTP client at all — or locked behind a firewall that will not permit one —
-- can still export a file on a schedule, and this is the door it uses.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A drop directory is an API key with a different transport
-- ---------------------------------------------------------------------------
--
-- Binding the SFTP account to a key rather than giving it an authority of its
-- own means the whole model built for the REST endpoint applies unchanged: the
-- same scope list decides whether a dropped file may be filed or only prepared,
-- revoking the key closes the directory, and the audit trail names the same
-- actor whichever way the document arrived. One authority, two doors.

ALTER TABLE api_keys
  ADD COLUMN sftp_username VARCHAR(32) UNIQUE
    CHECK (sftp_username IS NULL OR sftp_username ~ '^[a-z][a-z0-9_-]{2,31}$');

COMMENT ON COLUMN api_keys.sftp_username IS
  'The drop directory this key owns under SFTP_ROOT. Globally unique because it is a filesystem path, not a per-tenant name.';

-- ---------------------------------------------------------------------------
-- A machine can upload a workbook too
-- ---------------------------------------------------------------------------
--
-- Same reasoning as `invoices.created_by_api_key_id` in 0007: the uploader
-- column references `users`, and inventing a login-capable account per
-- integration to satisfy a foreign key would be worse than adding a column.

ALTER TABLE batch_uploads
  ADD COLUMN uploaded_by_api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- What arrived, and what we did with it
-- ---------------------------------------------------------------------------
--
-- The receipt the platform writes back into the drop directory is a courtesy —
-- a file on a share, which anyone can delete. This table is the record. It is
-- also the deduplication: an ERP whose scheduler fires twice, or whose operator
-- re-uploads yesterday's export by hand, must not file the same invoices again.

CREATE TYPE sftp_delivery_status AS ENUM ('ACCEPTED', 'PARTIAL', 'REJECTED', 'DUPLICATE');

CREATE TABLE sftp_deliveries (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  api_key_id       UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  sftp_username    VARCHAR(32) NOT NULL,

  file_name        TEXT NOT NULL,
  file_hash_sha256 CHAR(64) NOT NULL,
  size_bytes       BIGINT NOT NULL,

  status           sftp_delivery_status NOT NULL,
  -- The receipt exactly as it was written back, so support can answer "what did
  -- you tell my ERP?" without needing the file that was handed to it.
  receipt          JSONB NOT NULL,

  -- Set for a workbook drop, which becomes a batch for the staging grid.
  batch_id         UUID REFERENCES batch_uploads(id) ON DELETE SET NULL,
  invoice_count    INT NOT NULL DEFAULT 0,

  received_at      TIMESTAMPTZ NOT NULL,
  processed_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Byte-identical content is never legitimately sent twice: the invoice
  -- numbers inside it are the same, so the second delivery could only ever be a
  -- duplicate filing or a rejection. Refusing it at the door is clearer than
  -- letting it fail invoice by invoice further in.
  CONSTRAINT uq_sftp_delivery_content UNIQUE (tenant_id, file_hash_sha256)
);

CREATE INDEX idx_sftp_deliveries_tenant ON sftp_deliveries (tenant_id, processed_at DESC);

-- ---------------------------------------------------------------------------
-- Isolation and privileges
-- ---------------------------------------------------------------------------

ALTER TABLE sftp_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE sftp_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sftp_deliveries AS RESTRICTIVE
  USING (tenant_id = current_tenant_id() OR has_platform_access())
  WITH CHECK (tenant_id = current_tenant_id() OR has_platform_access());
CREATE POLICY tenant_all ON sftp_deliveries FOR ALL USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO uae_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO uae_app;
REVOKE UPDATE, DELETE ON audit_trails FROM uae_app;
REVOKE DELETE ON api_keys, ingestion_requests FROM uae_app;

-- The delivery log answers "did you receive our file, and what did you do with
-- it" — a question asked when an ERP and a tax return disagree. Append-only.
REVOKE UPDATE, DELETE ON sftp_deliveries FROM uae_app;
