-- ===========================================================================
-- Ingestion channel 1 — programmatic ERP access (SRS v1.2 §"POST /v1/invoices",
-- v2.1 §1.2 "Direct ERP Connectors / REST APIs").
--
-- The other two channels are driven by a person holding a browser session. This
-- one is driven by a machine that has no browser, no second factor and no
-- password to rotate, so it needs a credential of its own.
-- ===========================================================================

CREATE TABLE api_keys (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name               VARCHAR(120) NOT NULL,

  -- The leading, non-secret segment of the token. Shown in the portal and in
  -- audit entries so an operator can tell two keys apart and revoke the right
  -- one; on its own it authenticates nothing.
  key_prefix         VARCHAR(32) NOT NULL,

  -- SHA-256 of the whole token. A password KDF would be the wrong tool: the
  -- slowness of Argon2 buys resistance to guessing a low-entropy human secret,
  -- and this is 256 bits from a CSPRNG. What it would buy instead is ~100ms on
  -- every request of an ingestion API whose entire purpose is throughput.
  token_hash         CHAR(64) NOT NULL UNIQUE,

  -- The permission names this key may exercise, a subset of the §5 matrix.
  -- Held per key rather than inherited from the creating user: a key that only
  -- posts invoices should not gain the ability to manage users because the
  -- accountant who created it can.
  scopes             TEXT[] NOT NULL CHECK (cardinality(scopes) > 0),

  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  last_used_at       TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ,
  revoked_at         TIMESTAMPTZ,
  revoked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Authentication is a lookup on this column and nothing else, on every request.
CREATE INDEX idx_api_keys_lookup ON api_keys (token_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_api_keys_tenant ON api_keys (tenant_id, created_at DESC);

CREATE TRIGGER trg_api_keys_updated
  BEFORE UPDATE ON api_keys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Idempotent submission
-- ---------------------------------------------------------------------------
--
-- An ERP that times out waiting for a response will retry, and the invoice it
-- is retrying may already have been filed. Filing the same invoice twice is a
-- penalty for the merchant, so a replayed request has to return the original
-- outcome rather than attempt the work again.
--
-- The stored response is the whole answer, not a pointer to it: the caller must
-- get back byte-for-byte what the first attempt returned, including the
-- validation findings of a rejection.

CREATE TABLE ingestion_requests (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  api_key_id      UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  idempotency_key VARCHAR(255) NOT NULL,

  -- SHA-256 of the request body. A caller who reuses a key for a *different*
  -- invoice has a bug, and returning the first invoice's receipt would hide it.
  request_hash    CHAR(64) NOT NULL,

  status_code     INT NOT NULL,
  response_body   JSONB NOT NULL,
  invoice_id      UUID REFERENCES invoices(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Scoped to the tenant, not global: two customers' ERPs both numbering their
  -- requests from 1 is not a collision.
  CONSTRAINT uq_ingestion_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX idx_ingestion_requests_created ON ingestion_requests (created_at);

-- ---------------------------------------------------------------------------
-- Who composed the document
-- ---------------------------------------------------------------------------
--
-- `invoices.created_by_user_id` references `users`, and a machine is not a
-- user. Rather than inventing a user row for every integration — which would
-- put a login-capable account on the platform for something that can never log
-- in — the machine author gets a column of its own. Exactly one of the two is
-- set on any document, and "which key filed this?" is then answerable in an
-- audit without joining through a fiction.

ALTER TABLE invoices
  ADD COLUMN created_by_api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL;

CREATE INDEX idx_invoices_api_key ON invoices (created_by_api_key_id)
  WHERE created_by_api_key_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Isolation and privileges
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_keys', 'ingestion_requests']
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

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO uae_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO uae_app;
REVOKE UPDATE, DELETE ON audit_trails FROM uae_app;

-- A revoked key is evidence of what a machine was once allowed to do, and the
-- ingestion log is what proves a duplicate filing was refused. Neither may be
-- deleted by the application; expiry is a housekeeping job run by an operator.
REVOKE DELETE ON api_keys, ingestion_requests FROM uae_app;
