-- ===========================================================================
-- The accredited provider master.
--
-- v2.8 §15.1 has the host registering purchases against "asp_provider_name",
-- free text. Two contracts keyed "Accredited ASP UAE" and "accredited asp uae"
-- are then two providers as far as any cost report is concerned, which defeats
-- the point of recording the cost. The MoF publishes a finite list of accredited
-- providers; a platform deals with one or two of them, and they belong in a
-- table rather than being retyped on every contract.
--
-- Procurement-side only. `tenant_asp_configs` records which provider *routes* a
-- given tenant's invoices, which is a per-tenant connection with credentials and
-- an endpoint — a different question from who the host buys units from, even
-- when the answer is the same company.
-- ===========================================================================

CREATE TABLE asp_providers (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                      VARCHAR(120) NOT NULL UNIQUE,
  -- The provider's entry on the MoF's published accreditation list. Recorded
  -- because "are they still accredited" is a question with a due-diligence
  -- answer, and the reference is where you go to check.
  accreditation_reference   VARCHAR(100),
  contact_name              VARCHAR(150),
  contact_email             VARCHAR(255),
  contact_phone             VARCHAR(50),
  website                   VARCHAR(255),
  -- Pre-fills the rate on a new contract. Only a default: the rate actually
  -- paid lives on the procurement row, because it is what the contract says.
  default_cost_per_unit_aed NUMERIC(10, 4) CHECK (default_cost_per_unit_aed >= 0),
  is_active                 BOOLEAN NOT NULL DEFAULT TRUE,
  notes                     TEXT,
  created_by_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER trg_asp_providers_updated
  BEFORE UPDATE ON asp_providers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Normalise the contracts onto it
-- ---------------------------------------------------------------------------
--
-- Backfilled from the names already recorded, so an existing platform keeps
-- every contract and gets a master seeded from its own history rather than an
-- empty table and a set of orphaned rows.

INSERT INTO asp_providers (name)
SELECT DISTINCT trim(asp_provider_name)
FROM asp_bundle_procurements
WHERE trim(coalesce(asp_provider_name, '')) <> ''
ON CONFLICT (name) DO NOTHING;

ALTER TABLE asp_bundle_procurements
  ADD COLUMN asp_provider_id UUID REFERENCES asp_providers(id) ON DELETE RESTRICT;

UPDATE asp_bundle_procurements p
SET asp_provider_id = v.id
FROM asp_providers v
WHERE v.name = trim(p.asp_provider_name);

-- Every row is linked by now: the master was built from these very names.
ALTER TABLE asp_bundle_procurements
  ALTER COLUMN asp_provider_id SET NOT NULL;

-- The name is the master's to hold. Leaving a copy behind would let the two
-- drift, and the copy is the one a report would read by accident.
ALTER TABLE asp_bundle_procurements DROP COLUMN asp_provider_name;

CREATE INDEX idx_procurements_provider ON asp_bundle_procurements (asp_provider_id);

-- `ON DELETE RESTRICT` above, and no delete offered in the API: a provider that
-- has sold the platform units is part of the audit trail of where its capacity
-- came from. Retiring one is `is_active = FALSE`, which takes it out of the
-- picker and leaves its contracts legible.

-- ---------------------------------------------------------------------------
-- Isolation and privileges
-- ---------------------------------------------------------------------------
--
-- Platform-only, for the same reason as the contracts themselves: what the host
-- pays per unit and who it buys from is its commercial position, and the correct
-- number of tenants who can read it is zero.

ALTER TABLE asp_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE asp_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON asp_providers AS RESTRICTIVE
  USING (has_platform_access()) WITH CHECK (has_platform_access());
CREATE POLICY providers_all ON asp_providers FOR ALL USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO uae_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO uae_app;
REVOKE UPDATE, DELETE ON audit_trails FROM uae_app;
REVOKE DELETE ON api_keys, ingestion_requests FROM uae_app;
REVOKE UPDATE, DELETE ON sftp_deliveries FROM uae_app;
REVOKE UPDATE, DELETE ON asp_bundle_procurements FROM uae_app;
REVOKE UPDATE, DELETE ON inventory_alerts_log FROM uae_app;

-- A provider record is editable — contacts change, accreditation lapses — but
-- never deleted, because contracts point at it.
REVOKE DELETE ON asp_providers FROM uae_app;
