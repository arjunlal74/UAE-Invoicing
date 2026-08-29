-- ===========================================================================
-- The platform owner's own company.
--
-- Every tenant on this system has a legal identity on file — name in both
-- languages, TRN, registered address — and the operator of the platform has
-- had none. It is a company too: it invoices tenants for bundles, it appears
-- on the correspondence the system sends, and "who is running this" is a
-- question a regulator asks. Until now the answer was a PLATFORM_NAME
-- environment variable, which is a deployment setting, not a record.
--
-- Not a row in `tenants`. A tenant is a filing entity — RLS scopes to it, its
-- users belong to it, its invoices hang off it — and inventing a tenant for the
-- host would put a company that never files into every tenant-shaped query on
-- the system. One row of its own says the same thing without the blast radius.
-- ===========================================================================

CREATE TABLE platform_company (
  -- Singleton, the same way `platform_inventory_settings` is: a primary key
  -- that can only hold TRUE makes "there is exactly one" the database's
  -- opinion rather than the application's.
  id                 BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  legal_name_en      VARCHAR(255) NOT NULL DEFAULT '',
  legal_name_ar      VARCHAR(255) NOT NULL DEFAULT '',
  trading_name       VARCHAR(255),
  -- Nullable, unlike a tenant's: the record exists from the first migration
  -- and is filled in by whoever sets the platform up, so it must be able to
  -- be incomplete without being invalid.
  trn                VARCHAR(15) CHECK (trn IS NULL OR trn ~ '^1[0-9]{14}$'),
  registered_address JSONB NOT NULL DEFAULT '{}'::jsonb,
  contact_email      VARCHAR(255),
  contact_phone      VARCHAR(50),
  website            VARCHAR(255),
  -- The logo lives here rather than in object storage. It is one small file
  -- read on nearly every page, and the archive bucket it would otherwise share
  -- is under Object Lock retention — where a logo could be written once and
  -- never replaced, which is the opposite of what a brand asset needs.
  logo_bytes         BYTEA,
  logo_mime          VARCHAR(64),
  logo_file_name     VARCHAR(255),
  logo_updated_at    TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Either all three logo columns are set or none is. A half-written logo is
  -- bytes nobody can serve, or a content type describing nothing.
  CONSTRAINT logo_all_or_nothing CHECK (
    (logo_bytes IS NULL AND logo_mime IS NULL)
    OR (logo_bytes IS NOT NULL AND logo_mime IS NOT NULL)
  )
);

INSERT INTO platform_company (id) VALUES (TRUE);

CREATE TRIGGER trg_platform_company_updated
  BEFORE UPDATE ON platform_company
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Isolation
-- ---------------------------------------------------------------------------
--
-- Platform-only for writes and for reading the record, the same as the host's
-- other settings. The logo alone is served publicly by an endpoint that reads
-- it over the platform connection — it is branding, it goes on correspondence
-- and it is meant to be looked at, but that is the API's decision to make and
-- not a hole in the table's policy.

ALTER TABLE platform_company ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_company FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON platform_company AS RESTRICTIVE
  USING (has_platform_access()) WITH CHECK (has_platform_access());
CREATE POLICY company_all ON platform_company FOR ALL USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON platform_company TO uae_app;

-- One row, forever. Deleting it would leave the platform with no identity and
-- nothing to recreate it from.
REVOKE DELETE ON platform_company FROM uae_app;
