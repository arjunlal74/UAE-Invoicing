-- ===========================================================================
-- SRS v2.7 — new enum labels for the dual-module (AR / AP) platform
-- ===========================================================================
-- PostgreSQL will not let a value added by ALTER TYPE ... ADD VALUE be *used*
-- in the transaction that adds it, and the migration runner wraps each file in
-- one transaction. So the labels arrive here, alone, and 0006 is free to
-- reference them in defaults, CHECKs and seeded rows.

-- --- Document lifecycle ----------------------------------------------------
-- v2.1 modelled a single arc: prepared -> filed -> cleared or refused. v2.7 has
-- two more stages after clearance, both driven by the *buyer* rather than by
-- the tax authority, plus a pre-clearance DRAFT state for documents composed in
-- the browser that have not been handed to anyone yet.

ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'DRAFT' BEFORE 'INGESTED';
ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'DELIVERED_TO_BUYER' AFTER 'ACCEPTED_BY_FTA';
ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'ACKNOWLEDGED' AFTER 'DELIVERED_TO_BUYER';
ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'UNDER_QUERY' AFTER 'ACKNOWLEDGED';
ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'ACCEPTED_BY_BUYER' AFTER 'UNDER_QUERY';
ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'REJECTED_TECHNICAL' AFTER 'ACCEPTED_BY_BUYER';
ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'REJECTED_COMMERCIAL' AFTER 'REJECTED_TECHNICAL';

-- --- Ingestion channels ----------------------------------------------------
-- §1.3 names three outbound channels and §12.1 adds the inbound one. The ERP
-- connectors are listed separately from REST_API because "which connector sent
-- this" is the question the AR reverse-push in §10.6 has to answer.

ALTER TYPE ingestion_source ADD VALUE IF NOT EXISTS 'MANUAL_IN_APP_ENTRY';
ALTER TYPE ingestion_source ADD VALUE IF NOT EXISTS 'INBOUND_PEPPOL_AS4';
ALTER TYPE ingestion_source ADD VALUE IF NOT EXISTS 'SAP_CONNECTOR';
ALTER TYPE ingestion_source ADD VALUE IF NOT EXISTS 'ORACLE_CONNECTOR';
ALTER TYPE ingestion_source ADD VALUE IF NOT EXISTS 'DYNAMICS_CONNECTOR';
ALTER TYPE ingestion_source ADD VALUE IF NOT EXISTS 'NETSUITE_CONNECTOR';
