import {
  validateInvoice,
  type StagedInvoice,
  type ValidationContext,
  type ValidationFinding,
} from '@uae/domain';
import { jsonb, type Tx } from '../../db/client.js';

/**
 * Shared staging logic, used by both the HTTP routes and the parse worker so
 * that a row validated during upload and the same row re-validated after an
 * inline edit go through identical code.
 */

export interface StagingRowRecord {
  id: string;
  tenant_id: string;
  batch_id: string;
  row_index: number;
  invoice_number: string;
  payload: StagedInvoice;
  findings: ValidationFinding[];
  submittable: boolean;
  invoice_id: string | null;
}

/**
 * Build the context the validator needs.
 *
 * `existingInvoiceNumbers` is the expensive part: it is every invoice number
 * this tenant has already filed. Loading only the numbers present in the batch
 * keeps it proportional to the upload rather than to the tenant's history.
 */
export async function buildValidationContext(
  tx: Tx,
  tenantId: string,
  invoiceNumbers: string[],
): Promise<ValidationContext> {
  const tenants = await tx<{ trn: string }[]>`
    SELECT trn FROM tenants WHERE id = ${tenantId}
  `;

  const candidates = [...new Set(invoiceNumbers.filter(Boolean))];
  const existing = candidates.length
    ? await tx<{ invoice_number: string }[]>`
        SELECT invoice_number FROM invoices
        WHERE tenant_id = ${tenantId}
          AND invoice_number = ANY(${candidates}::text[])
          -- A rejected invoice may legitimately be corrected and re-filed, so
          -- it must not count as a blocking duplicate.
          AND status <> 'REJECTED_BY_FTA'
      `
    : [];

  return {
    tenantTrn: tenants[0]?.trn ?? '',
    existingInvoiceNumbers: new Set(existing.map((r) => r.invoice_number)),
  };
}

/** Duplicate counts across a whole batch, for the in-upload duplicate rule. */
export async function batchInvoiceNumberCounts(
  tx: Tx,
  batchId: string,
  excludeRowId?: string,
): Promise<Map<string, number>> {
  const rows = await tx<{ invoice_number: string; count: string }[]>`
    SELECT invoice_number, count(*)::text AS count
    FROM staging_rows
    WHERE batch_id = ${batchId}
      AND invoice_number <> ''
      AND (${excludeRowId ?? null}::uuid IS NULL OR id <> ${excludeRowId ?? null}::uuid)
    GROUP BY invoice_number
  `;
  return new Map(rows.map((r) => [r.invoice_number, Number(r.count)]));
}

export function validateStagedRow(
  invoice: StagedInvoice,
  context: ValidationContext,
): { findings: ValidationFinding[]; submittable: boolean } {
  const result = validateInvoice(invoice, context);
  return { findings: result.findings, submittable: result.submittable };
}

/** Persist a validated row and mirror its findings into `validation_logs`. */
export async function persistRowValidation(
  tx: Tx,
  row: { id: string; tenantId: string },
  invoice: StagedInvoice,
  findings: ValidationFinding[],
  submittable: boolean,
): Promise<void> {
  await tx`
    UPDATE staging_rows SET
      payload        = ${jsonb(tx, invoice)},
      findings       = ${jsonb(tx, findings)},
      submittable    = ${submittable},
      invoice_number = ${invoice.invoiceNumber ?? ''}
    WHERE id = ${row.id}
  `;

  // The findings JSONB on the row drives the grid; validation_logs is the
  // durable per-rule record the audit and rule-frequency reporting read. Both
  // are needed, so the log is rewritten to match rather than appended to.
  await tx`DELETE FROM validation_logs WHERE staging_row_id = ${row.id}`;

  if (findings.length > 0) {
    await tx`
      INSERT INTO validation_logs ${tx(
        findings.map((f) => ({
          tenant_id: row.tenantId,
          staging_row_id: row.id,
          rule_code: f.ruleCode,
          severity: f.severity,
          json_path: f.jsonPath ?? null,
          excel_sheet_name: f.sheet,
          excel_cell_reference: f.cell,
          error_message: f.message,
        })),
      )}
    `;
  }
}

/** Recompute a batch's counters and status from its rows. */
export async function refreshBatchCounters(tx: Tx, batchId: string): Promise<void> {
  await tx`
    UPDATE batch_uploads b SET
      total_records     = s.total,
      valid_records     = s.valid,
      invalid_records   = s.total - s.valid,
      submitted_records = s.submitted,
      status = CASE
        WHEN s.total = 0 THEN 'VALIDATED'::batch_status
        WHEN s.submitted = s.total THEN 'COMPLETED'::batch_status
        WHEN s.submitted > 0 THEN 'PROCESSING'::batch_status
        WHEN s.valid < s.total THEN 'STAGED_WITH_ERRORS'::batch_status
        ELSE 'VALIDATED'::batch_status
      END
    FROM (
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE submittable)::int AS valid,
        count(*) FILTER (WHERE invoice_id IS NOT NULL)::int AS submitted
      FROM staging_rows WHERE batch_id = ${batchId}
    ) s
    WHERE b.id = ${batchId}
  `;
}
