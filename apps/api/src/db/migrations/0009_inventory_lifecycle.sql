-- ===========================================================================
-- The multi-tier data bundle inventory lifecycle — SRS v2.8 §15.
--
-- v2.7 metered the retail half of this: a tenant holds a bundle, a partner
-- carves slices from a master bundle, and filing an invoice deducts from both.
-- What it never modelled is where the host's units come from, which meant the
-- platform administrator could sell a hundred thousand units it had not bought.
-- An inventory that only counts what leaves is not an inventory.
--
-- v2.8 closes the supply chain: the host procures wholesale from an accredited
-- provider, sells or allocates downstream, and every tier watches an absolute
-- floor rather than a percentage of whatever it last bought.
-- ===========================================================================

CREATE TYPE alert_severity AS ENUM ('WARNING', 'CRITICAL');

-- ---------------------------------------------------------------------------
-- §15.1 Wholesale procurement
-- ---------------------------------------------------------------------------
--
-- Not tenant-scoped and deliberately outside row-level security: these are the
-- host's own purchase contracts with its provider, and no tenant has any
-- business seeing what the platform paid per unit.

CREATE TABLE asp_bundle_procurements (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  asp_provider_name   VARCHAR(100) NOT NULL,
  contract_reference  VARCHAR(100) NOT NULL UNIQUE,
  total_units         INT NOT NULL CHECK (total_units > 0),
  -- Four decimal places because wholesale pricing is quoted in fils per unit
  -- and rounding it to two would lose the difference on a million-unit contract.
  cost_per_unit_aed   NUMERIC(10, 4) NOT NULL CHECK (cost_per_unit_aed >= 0),
  total_cost_aed      NUMERIC(14, 2) NOT NULL CHECK (total_cost_aed >= 0),
  purchase_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  expiry_date         DATE,
  notes               TEXT,
  created_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT procurement_expiry_after_purchase
    CHECK (expiry_date IS NULL OR expiry_date >= purchase_date)
);

CREATE INDEX idx_procurements_date ON asp_bundle_procurements (purchase_date DESC);

-- ---------------------------------------------------------------------------
-- §15.2 What a sold bundle was cut from, and the floor it must not fall below
-- ---------------------------------------------------------------------------
--
-- The v2.8 DDL names a `tenant_bundle_allocations` table with generated balance
-- columns. `data_bundles` already is that table under an older name — same
-- grain, same parent/slice relationship, already carrying every foreign key and
-- policy in the system — so the columns are added here rather than a second
-- table introduced to hold the same rows twice.

ALTER TABLE data_bundles
  -- Which wholesale contract this bundle was sold out of. Null on the bundles
  -- that predate procurement tracking, and on a partner's slice — a slice comes
  -- from the partner's master pool, and the master pool is what came from a
  -- contract.
  ADD COLUMN asp_procurement_id UUID REFERENCES asp_bundle_procurements(id) ON DELETE SET NULL,
  -- §15.3: an absolute floor the account holder sets, distinct from the
  -- 80/90/100% warnings v2.7 already sends. A tenant that files four thousand
  -- invoices a month does not care that it has used 80% of a bundle; it cares
  -- that fewer than two thousand units remain, because that is a week.
  ADD COLUMN minimum_buffer_units INT NOT NULL DEFAULT 0
    CHECK (minimum_buffer_units >= 0),
  -- Set when the floor alert went out, cleared when a top-up lifts the balance
  -- back above it. Without this the sweep would send Template G every time it
  -- runs, which is how an alert becomes something people filter to a folder.
  ADD COLUMN buffer_alerted_at TIMESTAMPTZ;

CREATE INDEX idx_bundles_procurement ON data_bundles (asp_procurement_id)
  WHERE asp_procurement_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- §15.5 tier 1: the host's own floor
-- ---------------------------------------------------------------------------
--
-- One row, enforced by the primary key. The alternative — a general settings
-- table of string keys — would make "what is the host buffer?" a question with
-- a typo-shaped failure mode, and this is the number that decides whether the
-- whole platform can keep filing.

CREATE TABLE platform_inventory_settings (
  id                   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  -- Zero, meaning the alert is off until an operator sets it. A live default
  -- would fire on the first sweep after this migration on any deployment that
  -- has filed invoices but not yet backfilled its purchase contracts — which
  -- is every deployment, and an alert that is wrong the first time it fires is
  -- one people learn to ignore.
  minimum_buffer_units INT NOT NULL DEFAULT 0 CHECK (minimum_buffer_units >= 0),
  buffer_alerted_at    TIMESTAMPTZ,
  updated_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO platform_inventory_settings (id) VALUES (TRUE);

CREATE TRIGGER trg_platform_inventory_updated
  BEFORE UPDATE ON platform_inventory_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- §15.5 the alert record
-- ---------------------------------------------------------------------------
--
-- `tenant_id` is nullable because tier 1 is the host, which is not a tenant.
-- The log exists so that "you never told us we were running out" has an answer,
-- so it records the figures as they stood rather than pointing at rows that
-- will have moved by the time anyone reads it.

CREATE TABLE inventory_alerts_log (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id               UUID REFERENCES tenants(id) ON DELETE CASCADE,
  bundle_id               UUID REFERENCES data_bundles(id) ON DELETE SET NULL,
  alert_tier              tenant_type NOT NULL,
  threshold_units         INT NOT NULL,
  units_remaining         INT NOT NULL,
  severity                alert_severity NOT NULL DEFAULT 'WARNING',
  -- Estimated from the last 30 days of the usage ledger, so the recipient can
  -- tell "two weeks left" from "two days left" without doing the division.
  daily_run_rate          NUMERIC(10, 2),
  notification_dispatched BOOLEAN NOT NULL DEFAULT FALSE,
  dispatched_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_inventory_alerts_tenant
  ON inventory_alerts_log (tenant_id, dispatched_at DESC);

-- ---------------------------------------------------------------------------
-- Isolation and privileges
-- ---------------------------------------------------------------------------
--
-- `inventory_alerts_log` is tenant-scoped so an account holder can see the
-- warnings it was sent. `asp_bundle_procurements` and
-- `platform_inventory_settings` are not: they are the host's commercial
-- position, and the correct number of tenants who can read them is zero.

ALTER TABLE inventory_alerts_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_alerts_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_alerts_log AS RESTRICTIVE
  USING (tenant_id IS NULL OR tenant_id = current_tenant_id() OR has_platform_access())
  WITH CHECK (tenant_id IS NULL OR tenant_id = current_tenant_id() OR has_platform_access());
CREATE POLICY tenant_all ON inventory_alerts_log FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE asp_bundle_procurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE asp_bundle_procurements FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON asp_bundle_procurements AS RESTRICTIVE
  USING (has_platform_access()) WITH CHECK (has_platform_access());
CREATE POLICY procurements_all ON asp_bundle_procurements FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE platform_inventory_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_inventory_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON platform_inventory_settings AS RESTRICTIVE
  USING (has_platform_access()) WITH CHECK (has_platform_access());
CREATE POLICY settings_all ON platform_inventory_settings FOR ALL USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO uae_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO uae_app;
REVOKE UPDATE, DELETE ON audit_trails FROM uae_app;
REVOKE DELETE ON api_keys, ingestion_requests FROM uae_app;
REVOKE UPDATE, DELETE ON sftp_deliveries FROM uae_app;

-- A procurement contract is what the host's stock figure is derived from, and
-- the alert log is the evidence a warning was sent. Neither is the
-- application's to rewrite; correcting a mis-keyed contract is a new row.
REVOKE UPDATE, DELETE ON asp_bundle_procurements FROM uae_app;
REVOKE UPDATE, DELETE ON inventory_alerts_log FROM uae_app;
