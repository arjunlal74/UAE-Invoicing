import { randomUUID } from 'node:crypto';
import { recalcInvoice, type StagedInvoice } from '@uae/domain';
import { SYSTEM_ACTOR, audit } from '../audit/audit.js';
import { jsonb, withTenant } from '../db/client.js';
import { config } from '../config.js';
import { WorkbookParseError, parseWorkbook } from '../excel/parse.js';
import { logger } from '../logger.js';
import {
  buildValidationContext,
  persistRowValidation,
  refreshBatchCounters,
  validateStagedRow,
} from '../modules/staging/service.js';
import { getObject, keyFromUri } from '../storage/objectStore.js';
import type { ParseBatchJob } from '../queue/queues.js';

/**
 * Turn an uploaded workbook into staged, validated rows.
 *
 * A parse failure is a normal outcome, not an exception: the user gets a batch
 * marked FAILED with an explanation they can act on, rather than a job that
 * silently retries forever.
 */
export async function parseBatchJob(job: ParseBatchJob): Promise<void> {
  const { batchId, tenantId } = job;
  const log = logger.child({ batchId, tenantId });

  const batch = await withTenant(tenantId, async (tx) => {
    const rows = await tx<{ id: string; file_s3_uri: string; status: string }[]>`
      SELECT id, file_s3_uri, status FROM batch_uploads WHERE id = ${batchId}
    `;
    if (!rows[0]) throw new Error(`Batch ${batchId} not found`);

    await tx`UPDATE batch_uploads SET status = 'PARSING', parse_error = NULL WHERE id = ${batchId}`;
    return rows[0];
  });

  try {
    const buffer = await getObject(keyFromUri(batch.file_s3_uri));
    const parsed = await parseWorkbook(buffer, { maxRows: config().UPLOAD_MAX_ROWS });

    log.info(
      { invoices: parsed.invoices.length, orphans: parsed.orphanLines.length },
      'workbook parsed',
    );

    await withTenant(tenantId, async (tx) => {
      // Re-parsing replaces previous staging state entirely. Rows already
      // promoted to invoices are protected by the guard below.
      const promoted = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM staging_rows
        WHERE batch_id = ${batchId} AND invoice_id IS NOT NULL
      `;
      if (Number(promoted[0]!.count) > 0) {
        throw new Error('Refusing to re-parse a batch that already has submitted invoices.');
      }
      await tx`DELETE FROM staging_rows WHERE batch_id = ${batchId}`;

      const context = await buildValidationContext(
        tx,
        tenantId,
        parsed.invoices.map((i) => i.invoiceNumber),
      );

      const counts = new Map<string, number>();
      for (const invoice of parsed.invoices) {
        const key = invoice.invoiceNumber?.trim();
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      context.batchInvoiceNumbers = counts;

      // Lines that reference a missing header are attached to a synthetic row
      // so the user can see and fix them. Dropping them would mean a line item
      // silently vanished between their spreadsheet and their filing.
      const invoices: StagedInvoice[] = [...parsed.invoices];
      if (parsed.orphanLines.length > 0) {
        const grouped = new Map<string, typeof parsed.orphanLines>();
        for (const orphan of parsed.orphanLines) {
          const list = grouped.get(orphan.invoiceNumber) ?? [];
          list.push(orphan);
          grouped.set(orphan.invoiceNumber, list);
        }

        for (const [invoiceNumber, orphans] of grouped) {
          invoices.push(
            recalcInvoice({
              id: randomUUID(),
              invoiceNumber,
              invoiceType: '',
              issueDate: '',
              issueTime: '',
              currency: 'AED',
              fxRate: '1.000000',
              supplierTrn: '',
              supplierName: '',
              buyerTrn: '',
              buyerName: '',
              buyerEmirate: '',
              poReference: '',
              precedingInvoiceId: '',
              paymentMeans: '',
              lines: orphans.map((o) => o.line),
              lineExtensionAmount: '',
              taxExclusiveAmount: '',
              vatTotalAmount: '',
              taxInclusiveAmount: '',
              payableAmount: '',
              payableAmountAed: '',
              sourceRow: null,
            }),
          );
        }
      }

      for (const [index, raw] of invoices.entries()) {
        // Validate what the user actually supplied, then store the
        // recalculated version. Validating the recalculated shape would hide
        // exactly the mistakes the staging grid exists to surface: a VAT rate
        // that contradicts its category, or hand-typed values in the template's
        // locked formula columns.
        const result = validateStagedRow(raw, context);
        const display = recalcInvoice(raw);

        const inserted = await tx<{ id: string }[]>`
          INSERT INTO staging_rows (tenant_id, batch_id, row_index, invoice_number, payload, findings, submittable)
          VALUES (
            ${tenantId}, ${batchId}, ${index}, ${raw.invoiceNumber ?? ''},
            ${jsonb(tx, display)}, ${jsonb(tx, [])}, ${result.submittable}
          )
          RETURNING id
        `;

        await persistRowValidation(
          tx,
          { id: inserted[0]!.id, tenantId },
          display,
          result.findings,
          result.submittable,
        );
      }

      await refreshBatchCounters(tx, batchId);
    });

    await audit(SYSTEM_ACTOR, {
      action: 'BATCH_PARSED',
      resourceType: 'BATCH',
      resourceId: batchId,
      tenantId,
      changes: {
        invoices: parsed.invoices.length,
        orphanLines: parsed.orphanLines.length,
        warnings: parsed.warnings,
      },
    });
  } catch (err) {
    const message =
      err instanceof WorkbookParseError
        ? err.message
        : `The file could not be processed: ${(err as Error).message}`;

    log.error({ err }, 'batch parse failed');

    await withTenant(
      tenantId,
      (tx) => tx`
        UPDATE batch_uploads SET status = 'FAILED', parse_error = ${message} WHERE id = ${batchId}
      `,
    );

    // A workbook problem is the user's to fix, so the job must not retry;
    // anything else may be transient and is allowed to.
    if (err instanceof WorkbookParseError) return;
    throw err;
  }
}
