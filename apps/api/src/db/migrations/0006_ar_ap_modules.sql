-- ===========================================================================
-- SRS v2.7 §1.2 — the dual-module platform
-- ===========================================================================
-- Everything until now assumed one direction of travel: the tenant is the
-- seller, the document is theirs, and the only counterparty that matters is the
-- FTA. v2.7 splits the platform in two:
--
--   Module 1 (Outbound / AR) — sales invoices, simplified invoices and credit
--     notes the tenant issues, cleared with the FTA and then judged by BUYERS
--     who may accept, query or reject them.
--   Module 2 (Inbound / AP)  — purchase invoices SUPPLIERS issue against the
--     tenant, received off the network and judged by the tenant's own AP desk.
--
-- Both are the same document shape with the arrow reversed, so they share one
-- `invoices` table discriminated by `direction` rather than living in two
-- near-identical tables that would need every query, index and report written
-- twice.

-- --- Direction -------------------------------------------------------------

CREATE TYPE invoice_direction AS ENUM ('OUTBOUND_SALES_AR', 'INBOUND_PURCHASE_AP');

ALTER TABLE invoices
  ADD COLUMN direction invoice_direction NOT NULL DEFAULT 'OUTBOUND_SALES_AR';

-- The invoice number of a purchase bill belongs to the SUPPLIER's numbering
-- series, not ours, so it can legitimately collide with one of our own sales
-- invoices. Uniqueness therefore has to be per direction; keeping the old
-- constraint would make a supplier's INV-0001 unreceivable because we happen to
-- have issued an INV-0001 ourselves.
ALTER TABLE invoices DROP CONSTRAINT uq_tenant_invoice_num;
ALTER TABLE invoices
  ADD CONSTRAINT uq_tenant_invoice_dir UNIQUE (tenant_id, direction, invoice_number);

CREATE INDEX invoices_tenant_direction_status_idx
  ON invoices (tenant_id, direction, status, created_at DESC);

-- ===========================================================================
-- §6 Customer Master Directory (Module 1 — AR)
-- ===========================================================================
-- Persistent buyer profiles so the in-app invoice builder can fill a whole
-- party block from one search box, and so B2B/B2C — which decides 380 vs 388 —
-- is a property of the customer rather than a per-invoice guess.

CREATE TYPE party_type AS ENUM ('B2B', 'B2C');

CREATE TABLE customers (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_code         VARCHAR(50),
  customer_name_en      VARCHAR(255) NOT NULL,
  customer_name_ar      VARCHAR(255),
  customer_type         party_type NOT NULL DEFAULT 'B2B',
  trn                   VARCHAR(15) CHECK (trn IS NULL OR trn ~ '^1[0-9]{14}$'),
  emirate               VARCHAR(50) NOT NULL,
  street_address        TEXT NOT NULL DEFAULT '',
  building              VARCHAR(255),
  postal_code           VARCHAR(20),
  contact_name          VARCHAR(150),
  contact_email         VARCHAR(255),
  contact_phone         VARCHAR(50),
  default_payment_means VARCHAR(5),
  notes                 TEXT,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- §6: a B2B buyer must carry the 15-digit TRN that ends up in
  -- cac:AccountingCustomerParty/cbc:CompanyID. A B2C individual has none, and
  -- that absence is what makes the document a 388.
  CONSTRAINT customer_b2b_requires_trn
    CHECK (customer_type <> 'B2B' OR trn IS NOT NULL)
);

-- Partial indexes rather than plain UNIQUE constraints: both the code and the
-- TRN are optional, and a plain UNIQUE would admit unlimited NULL rows while
-- still reporting a uniqueness failure to the user when a real value collides.
CREATE UNIQUE INDEX uq_tenant_customer_code
  ON customers (tenant_id, customer_code) WHERE customer_code IS NOT NULL;
CREATE UNIQUE INDEX uq_tenant_customer_trn
  ON customers (tenant_id, trn) WHERE trn IS NOT NULL;

CREATE INDEX customers_tenant_name_idx ON customers (tenant_id, customer_name_en);
CREATE INDEX customers_search_idx ON customers USING GIN (
  to_tsvector('simple',
    coalesce(customer_name_en, '') || ' ' || coalesce(customer_name_ar, '') || ' ' ||
    coalesce(trn, '') || ' ' || coalesce(customer_code, '')
  )
);

CREATE TRIGGER customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- §12.1 Supplier Master Directory (Module 2 — AP)
-- ===========================================================================
-- The inbound mirror of the customer directory, plus the things you only need
-- about someone you PAY: bank details and payment terms.

CREATE TABLE suppliers (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  supplier_code      VARCHAR(50),
  supplier_name_en   VARCHAR(255) NOT NULL,
  supplier_name_ar   VARCHAR(255),
  trn                VARCHAR(15) CHECK (trn IS NULL OR trn ~ '^1[0-9]{14}$'),
  emirate            VARCHAR(50) NOT NULL,
  street_address     TEXT NOT NULL DEFAULT '',
  postal_code        VARCHAR(20),
  bank_name          VARCHAR(150),
  bank_iban          VARCHAR(34),
  payment_terms_days INT NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  contact_name       VARCHAR(150),
  contact_email      VARCHAR(255),
  contact_phone      VARCHAR(50),
  notes              TEXT,
  -- Set when a purchase invoice arrives from a TRN we have never seen. §12.1's
  -- "New Supplier Detected" workflow is this flag plus a filter on the desk:
  -- the bill is still received and reviewable, it is simply marked unvetted
  -- rather than being rejected for the clerical sin of being new.
  is_provisional     BOOLEAN NOT NULL DEFAULT FALSE,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX uq_tenant_supplier_code
  ON suppliers (tenant_id, supplier_code) WHERE supplier_code IS NOT NULL;
CREATE UNIQUE INDEX uq_tenant_supplier_trn
  ON suppliers (tenant_id, trn) WHERE trn IS NOT NULL;

CREATE INDEX suppliers_tenant_name_idx ON suppliers (tenant_id, supplier_name_en);
CREATE INDEX suppliers_search_idx ON suppliers USING GIN (
  to_tsvector('simple',
    coalesce(supplier_name_en, '') || ' ' || coalesce(supplier_name_ar, '') || ' ' ||
    coalesce(trn, '') || ' ' || coalesce(supplier_code, '')
  )
);

CREATE TRIGGER suppliers_updated_at BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- §11 / §12.3 Peppol Invoice Response (IMR) codes
-- ===========================================================================
-- One pair of enums used in both directions: the codes a buyer sends us about
-- our sales invoice are the same codes we send a supplier about their purchase
-- invoice. OTH is not in the SRS list but Peppol permits it, and a response
-- carrying an unmapped reason must be storable rather than dropped.

CREATE TYPE response_status_code AS ENUM ('AB', 'IP', 'UQ', 'CA', 'AP', 'RE');
CREATE TYPE rejection_reason_code AS ENUM ('REF', 'PRI', 'QTY', 'ITM', 'DEL', 'NON', 'OTH');

-- ===========================================================================
-- Credit notes, disputes and the AP posting state
-- ===========================================================================

CREATE TYPE reversal_mode AS ENUM ('FULL_CANCELLATION', 'PARTIAL_ADJUSTMENT');
CREATE TYPE ap_posting_status AS ENUM ('NOT_POSTED', 'POSTED', 'BLOCKED', 'ON_HOLD');
CREATE TYPE erp_sync_status AS ENUM ('NOT_APPLICABLE', 'PENDING', 'SENT', 'FAILED');

ALTER TABLE invoices
  -- Directory links. Nullable on purpose: an Excel batch names a buyer by TRN
  -- without necessarily matching a directory row, and refusing those uploads
  -- would turn the directory into mandatory data entry rather than a
  -- convenience for the people who want it.
  ADD COLUMN customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,

  -- §10.6 clearance identifiers.
  ADD COLUMN fta_irn VARCHAR(255),
  ADD COLUMN fta_cryptographic_stamp TEXT,
  ADD COLUMN mls_status VARCHAR(50),

  -- §8.2 credit-note linkage. The row reference gives referential integrity
  -- inside our own database; the number and IRN are copied because they are
  -- what goes into cac:BillingReference and must survive even if the preceding
  -- invoice row is later archived out.
  ADD COLUMN referenced_invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  ADD COLUMN referenced_invoice_number VARCHAR(100),
  ADD COLUMN referenced_fta_irn VARCHAR(255),
  ADD COLUMN credit_note_reason_code rejection_reason_code,
  ADD COLUMN credit_note_reversal_mode reversal_mode,
  ADD COLUMN credit_note_notes TEXT,

  -- §11 dispute state, projected from invoice_responses below.
  ADD COLUMN latest_response_code response_status_code,
  ADD COLUMN latest_response_reason_code rejection_reason_code,
  ADD COLUMN latest_response_comment TEXT,
  ADD COLUMN is_commercial_dispute BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN dispute_opened_at TIMESTAMPTZ,
  ADD COLUMN dispute_resolved BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN dispute_resolved_at TIMESTAMPTZ,
  ADD COLUMN corrective_credit_note_id UUID REFERENCES invoices(id) ON DELETE SET NULL,

  -- §12 inbound-only columns.
  ADD COLUMN grn_reference VARCHAR(100),
  ADD COLUMN supplier_pdf_s3_uri VARCHAR(512),
  ADD COLUMN ap_posting_status ap_posting_status NOT NULL DEFAULT 'NOT_POSTED',
  ADD COLUMN ap_reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN ap_reviewed_at TIMESTAMPTZ,

  -- §10.6 reverse push back to the originating ERP.
  ADD COLUMN erp_reverse_sync_status erp_sync_status NOT NULL DEFAULT 'NOT_APPLICABLE',
  ADD COLUMN erp_reverse_synced_at TIMESTAMPTZ,

  -- §10.5. A connector that re-posts the same document after a timeout must not
  -- produce a second filing or a second quota deduction.
  ADD COLUMN idempotency_key VARCHAR(128);

CREATE UNIQUE INDEX uq_invoice_idempotency
  ON invoices (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- The dispute desk's only query: open disputes, oldest first (§13.1 aging).
CREATE INDEX invoices_open_disputes_idx
  ON invoices (tenant_id, dispute_opened_at)
  WHERE is_commercial_dispute AND NOT dispute_resolved;

CREATE INDEX invoices_customer_idx ON invoices (tenant_id, customer_id);
CREATE INDEX invoices_supplier_idx ON invoices (tenant_id, supplier_id);
CREATE INDEX invoices_referenced_idx ON invoices (referenced_invoice_id);
CREATE INDEX invoices_fta_irn_idx ON invoices (fta_irn);

-- ===========================================================================
-- §11 / §12.3 Invoice responses — the bidirectional IMR log
-- ===========================================================================
-- Every ApplicationResponse that crosses the boundary, in either direction,
-- appended here. The columns added to `invoices` above are a denormalised
-- "latest" projection of this table for the sake of list queries; this is the
-- record the audit reads.

CREATE TYPE response_direction AS ENUM ('INBOUND_FROM_BUYER', 'OUTBOUND_TO_SUPPLIER');

CREATE TABLE invoice_responses (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id              UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  response_direction      response_direction NOT NULL,
  peppol_response_uuid    UUID NOT NULL DEFAULT uuid_generate_v4(),
  response_code           response_status_code NOT NULL,
  status_reason_code      rejection_reason_code,
  -- §12.3 splits rejection into technical (bad XML, wrong TRN) and commercial
  -- (a disagreement about the trade). Both travel as the same RE code and are
  -- distinguishable only by intent, so the distinction is recorded explicitly.
  is_technical            BOOLEAN NOT NULL DEFAULT FALSE,
  comments                TEXT,
  raw_response_xml_s3_uri VARCHAR(512),
  transmitted_at          TIMESTAMPTZ,
  transmission_error      TEXT,
  created_by_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  received_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX invoice_responses_lookup_idx
  ON invoice_responses (tenant_id, invoice_id, received_at DESC);
CREATE INDEX invoice_responses_reason_idx
  ON invoice_responses (tenant_id, status_reason_code, received_at DESC);

-- ===========================================================================
-- §15 Data usage bundles and the metering ledger
-- ===========================================================================
-- Two tiers. A channel partner buys one large master bundle and carves slices
-- out of it for its sub-tenants; a sub-tenant's consumption is deducted from
-- BOTH its own slice and the partner's master pool ("dual-deducted", §2). A
-- direct enterprise tenant simply holds its own bundle with no parent.

CREATE TYPE bundle_status AS ENUM ('ACTIVE', 'EXHAUSTED', 'EXPIRED', 'SUSPENDED');

CREATE TABLE data_bundles (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- The partner master bundle this slice was carved from. NULL for a bundle
  -- sold directly by the host.
  parent_bundle_id  UUID REFERENCES data_bundles(id) ON DELETE RESTRICT,
  reference         VARCHAR(64) NOT NULL,
  purchased_units   INT NOT NULL CHECK (purchased_units > 0),
  consumed_units    INT NOT NULL DEFAULT 0 CHECK (consumed_units >= 0),
  status            bundle_status NOT NULL DEFAULT 'ACTIVE',
  -- §15: a hard cap stops filing when the pool runs dry; a soft cap lets it run
  -- past the purchased figure and bills the overage. Which one applies is a
  -- commercial decision per bundle, not a platform-wide policy.
  allow_overage     BOOLEAN NOT NULL DEFAULT FALSE,
  valid_from        DATE NOT NULL DEFAULT CURRENT_DATE,
  expires_at        DATE,
  -- Highest threshold (80/90/100) already notified, so the 80% warning is sent
  -- once rather than on every invoice filed above that line.
  alerted_threshold INT NOT NULL DEFAULT 0,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_bundle_reference UNIQUE (tenant_id, reference)
);

CREATE INDEX data_bundles_tenant_status_idx ON data_bundles (tenant_id, status);
CREATE INDEX data_bundles_parent_idx ON data_bundles (parent_bundle_id);

CREATE TRIGGER data_bundles_updated_at BEFORE UPDATE ON data_bundles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE usage_ledger (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bundle_id        UUID REFERENCES data_bundles(id) ON DELETE SET NULL,
  invoice_id       UUID REFERENCES invoices(id) ON DELETE SET NULL,
  direction        invoice_direction NOT NULL,
  -- Why the units were taken. Zero-unit rows are written too: "this technical
  -- rejection cost nothing" is an answer a tenant disputing a bill will want.
  reason           VARCHAR(50) NOT NULL,
  units            INT NOT NULL,
  -- Whether this row is the tenant's own deduction or the mirrored deduction
  -- from the channel partner's master pool.
  is_parent_mirror BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Idempotency for the meter. A retried submission job re-enters this path, and
-- charging twice for one filing is the failure a tenant notices immediately.
CREATE UNIQUE INDEX uq_usage_per_invoice_reason
  ON usage_ledger (invoice_id, reason, is_parent_mirror)
  WHERE invoice_id IS NOT NULL;

CREATE INDEX usage_ledger_tenant_idx ON usage_ledger (tenant_id, created_at DESC);

-- ===========================================================================
-- Row-Level Security for the new tenant-scoped tables
-- ===========================================================================

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'customers', 'suppliers', 'invoice_responses', 'data_bundles', 'usage_ledger'
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

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO uae_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO uae_app;
REVOKE UPDATE, DELETE ON audit_trails FROM uae_app;
