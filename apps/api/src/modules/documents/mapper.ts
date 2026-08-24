import type {
  ApPostingStatus,
  DocumentListItem,
  ErpSyncStatus,
  InvoiceDirection,
  InvoiceListItem,
  InvoiceStatus,
  InvoiceTypeDb,
  RejectionReasonCode,
  ResponseStatusCode,
  ReversalMode,
} from '@uae/contracts';

/**
 * One shape for a document row, whichever module it belongs to.
 *
 * v2.7 has two desks reading the same table from opposite sides (SRS §1.2). The
 * alternative — an AR row type and an AP row type — would mean two SELECT lists
 * and two mappers that drift apart the first time a column is added, and both
 * desks genuinely do show most of the same fields.
 */
export interface DocumentRow {
  id: string;
  tenant_id: string;
  direction: InvoiceDirection;
  invoice_number: string;
  invoice_type: InvoiceTypeDb;
  issue_date: Date;
  issue_time: string;
  buyer_name: string;
  buyer_trn: string | null;
  buyer_emirate: string | null;
  seller_trn: string;
  seller_name: string;
  currency_code: string;
  exchange_rate: string;
  payable_amount: string;
  payable_amount_aed: string;
  line_extension_amount: string;
  tax_exclusive_amount: string;
  tax_inclusive_amount: string;
  vat_total_amount: string;
  status: InvoiceStatus;
  batch_upload_id: string | null;
  peppol_uuid: string;
  qr_code_data: string | null;
  ubl_xml_s3_uri: string | null;
  ubl_xml_sha256: string | null;
  fta_rejection_reason: string | null;
  fta_irn: string | null;
  fta_cryptographic_stamp: string | null;
  mls_status: string | null;
  approval_note: string | null;
  approved_at: Date | null;
  submitted_at: Date | null;
  cleared_at: Date | null;
  po_reference: string | null;
  grn_reference: string | null;
  customer_id: string | null;
  supplier_id: string | null;
  referenced_invoice_id: string | null;
  referenced_invoice_number: string | null;
  referenced_fta_irn: string | null;
  credit_note_reason_code: RejectionReasonCode | null;
  credit_note_reversal_mode: ReversalMode | null;
  credit_note_notes: string | null;
  latest_response_code: ResponseStatusCode | null;
  latest_response_reason_code: RejectionReasonCode | null;
  latest_response_comment: string | null;
  is_commercial_dispute: boolean;
  dispute_opened_at: Date | null;
  dispute_resolved: boolean;
  dispute_resolved_at: Date | null;
  corrective_credit_note_id: string | null;
  ap_posting_status: ApPostingStatus;
  ap_reviewed_at: Date | null;
  erp_reverse_sync_status: ErpSyncStatus;
  erp_reverse_synced_at: Date | null;
  created_at: Date;
  // --- Joined labels, supplied by the SELECT lists below --------------------
  created_by_name: string | null;
  approved_by_name: string | null;
  ap_reviewed_by_name: string | null;
  supplier_name_en: string | null;
  supplier_is_provisional: boolean | null;
  corrective_credit_note_number: string | null;
}

/**
 * The joins every document query needs.
 *
 * Scalar subqueries rather than LEFT JOINs: the caller's WHERE clause names
 * bare columns of `invoices`, and joining `users` twice plus `suppliers` would
 * make `tenant_id`, `created_at` and `status` ambiguous in every one of them.
 */
export const DOCUMENT_SELECT = `
  invoices.*,
  (SELECT full_name FROM users u WHERE u.id = invoices.created_by_user_id) AS created_by_name,
  (SELECT full_name FROM users u WHERE u.id = invoices.approved_by_user_id) AS approved_by_name,
  (SELECT full_name FROM users u WHERE u.id = invoices.ap_reviewed_by_user_id) AS ap_reviewed_by_name,
  (SELECT s.supplier_name_en FROM suppliers s WHERE s.id = invoices.supplier_id) AS supplier_name_en,
  (SELECT s.is_provisional FROM suppliers s WHERE s.id = invoices.supplier_id) AS supplier_is_provisional,
  (SELECT c.invoice_number FROM invoices c WHERE c.id = invoices.corrective_credit_note_id)
    AS corrective_credit_note_number
`;

const iso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

/**
 * The counterparty is whoever is on the other end of the transaction.
 *
 * On an AR document that is the buyer, whose name the invoice carries directly.
 * On an AP document the "buyer" columns hold *us*, and the party that matters
 * is the supplier — which is why `seller_name` is read for the inbound case.
 */
export function counterpartyOf(row: DocumentRow): { name: string; trn: string | null } {
  if (row.direction === 'INBOUND_PURCHASE_AP') {
    return { name: row.supplier_name_en ?? row.seller_name, trn: row.seller_trn || null };
  }
  return { name: row.buyer_name, trn: row.buyer_trn };
}

export function toDocumentListItem(row: DocumentRow): DocumentListItem {
  const counterparty = counterpartyOf(row);
  return {
    id: row.id,
    direction: row.direction,
    invoiceNumber: row.invoice_number,
    invoiceType: row.invoice_type,
    issueDate: row.issue_date.toISOString().slice(0, 10),
    counterpartyName: counterparty.name,
    counterpartyTrn: counterparty.trn,
    currencyCode: row.currency_code,
    payableAmount: row.payable_amount,
    payableAmountAed: row.payable_amount_aed,
    status: row.status,
    ftaIrn: row.fta_irn,
    poReference: row.po_reference,
    grnReference: row.grn_reference,
    apPostingStatus: row.ap_posting_status,
    latestResponseCode: row.latest_response_code,
    latestResponseReasonCode: row.latest_response_reason_code,
    isCommercialDispute: row.is_commercial_dispute,
    disputeResolved: row.dispute_resolved,
    disputeOpenedAt: iso(row.dispute_opened_at),
    correctiveCreditNoteId: row.corrective_credit_note_id,
    supplierIsProvisional: row.supplier_is_provisional === true,
    createdAt: row.created_at.toISOString(),
  };
}

/** The AR list shape kept from v2.1, so existing screens do not have to move. */
export function toInvoiceListItem(row: DocumentRow): InvoiceListItem {
  return {
    id: row.id,
    direction: row.direction,
    invoiceNumber: row.invoice_number,
    invoiceType: row.invoice_type,
    issueDate: row.issue_date.toISOString().slice(0, 10),
    buyerName: row.buyer_name,
    buyerTrn: row.buyer_trn,
    currencyCode: row.currency_code,
    payableAmount: row.payable_amount,
    payableAmountAed: row.payable_amount_aed,
    status: row.status,
    batchId: row.batch_upload_id,
    createdByName: row.created_by_name,
    approvedByName: row.approved_by_name,
    isCommercialDispute: row.is_commercial_dispute,
    disputeResolved: row.dispute_resolved,
    ftaIrn: row.fta_irn,
    createdAt: row.created_at.toISOString(),
  };
}
