import {
  PatchStagedRowRequest,
  SubmitBatchRequest,
  type StagedRow,
} from '@uae/contracts';
import {
  INVOICE_TYPES,
  VAT_CATEGORIES,
  autoFix,
  emptyLine,
  recalcInvoice,
  type InvoiceTypeCode,
  type StagedInvoice,
  type StagedLine,
  type VatCategoryCode,
} from '@uae/domain';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { jsonb, withTenant, type Tx } from '../../db/client.js';
import { EDITOR_ROLES, READER_ROLES, requireContext, requireRole } from '../../http/context.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { SUBMIT_JOB_OPTIONS, invoiceSubmitQueue } from '../../queue/queues.js';
import { BATCH_SELECT, toBatchSummary, type BatchRow } from '../batches/routes.js';
import {
  batchInvoiceNumberCounts,
  buildValidationContext,
  persistRowValidation,
  refreshBatchCounters,
  validateStagedRow,
  type StagingRowRecord,
} from './service.js';

function toStagedRow(row: StagingRowRecord): StagedRow {
  return {
    id: row.id,
    invoice: row.payload,
    findings: row.findings,
    submittable: row.submittable,
    status: null,
    invoiceId: row.invoice_id,
  };
}

async function loadRow(tx: Tx, batchId: string, rowId: string): Promise<StagingRowRecord> {
  const rows = await tx<StagingRowRecord[]>`
    SELECT * FROM staging_rows WHERE id = ${rowId} AND batch_id = ${batchId}
  `;
  if (!rows[0]) throw notFound('Staged row');
  return rows[0];
}

/** Re-run validation for one row, including cross-row duplicate detection. */
async function revalidateRow(
  tx: Tx,
  tenantId: string,
  row: StagingRowRecord,
  invoice: StagedInvoice,
): Promise<{ findings: StagedRow['findings']; submittable: boolean }> {
  const context = await buildValidationContext(tx, tenantId, [invoice.invoiceNumber]);
  context.batchInvoiceNumbers = await batchInvoiceNumberCounts(tx, row.batch_id, row.id);

  // The row's own number has to be counted too, or a duplicate pair would each
  // see only the other and neither would trip the rule after an edit.
  if (invoice.invoiceNumber) {
    const counts = context.batchInvoiceNumbers;
    counts.set(invoice.invoiceNumber, (counts.get(invoice.invoiceNumber) ?? 0) + 1);
  }

  const result = validateStagedRow(invoice, context);
  await persistRowValidation(tx, { id: row.id, tenantId }, invoice, result.findings, result.submittable);
  return result;
}

export function registerStagingRoutes(app: FastifyInstance) {
  // --- The grid's data -----------------------------------------------------
  app.get(
    '/api/v1/batches/:id/staging',
    { preHandler: requireRole(...READER_ROLES) },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const query = request.query as { page?: string; pageSize?: string; errorsOnly?: string };
      const page = Math.max(1, Number(query.page ?? 1));
      const pageSize = Math.min(500, Math.max(1, Number(query.pageSize ?? 100)));
      const errorsOnly = query.errorsOnly === 'true';

      const result = await withTenant(ctx.tenantId, async (tx) => {
        const batches = await tx.unsafe<BatchRow[]>(
          `SELECT ${BATCH_SELECT}
           FROM batch_uploads b
           LEFT JOIN users u ON u.id = b.uploaded_by_user_id
           WHERE b.id = $1`,
          [id],
        );
        if (!batches[0]) throw notFound('Batch');

        const rows = await tx<StagingRowRecord[]>`
          SELECT * FROM staging_rows
          WHERE batch_id = ${id}
            AND (${errorsOnly} = FALSE OR submittable = FALSE)
          ORDER BY row_index
          LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
        `;

        const counted = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM staging_rows
          WHERE batch_id = ${id} AND (${errorsOnly} = FALSE OR submittable = FALSE)
        `;

        return { batch: batches[0], rows, total: Number(counted[0]!.count) };
      });

      return reply.send({
        batch: toBatchSummary(result.batch),
        rows: result.rows.map(toStagedRow),
        total: result.total,
        page,
        pageSize,
      });
    },
  );

  // --- Inline cell edit ----------------------------------------------------
  app.patch(
    '/api/v1/batches/:id/staging/:rowId',
    { preHandler: requireRole(...EDITOR_ROLES) },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id, rowId } = request.params as { id: string; rowId: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const body = PatchStagedRowRequest.parse(request.body);

      const { updated, changes } = await withTenant(ctx.tenantId, async (tx) => {
        const row = await loadRow(tx, id, rowId);

        // Once a row has become an invoice it is no longer staging data. The
        // filed document is immutable; a correction is a credit note.
        if (row.invoice_id) {
          throw conflict(
            'This invoice has already been submitted and can no longer be edited. Issue a credit note to correct it.',
          );
        }

        const before = row.payload;
        const next: StagedInvoice = {
          ...before,
          ...body.invoice,
          id: before.id,
          lines: before.lines.map((l) => ({ ...l })),
        };

        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const [key, value] of Object.entries(body.invoice ?? {})) {
          const previous = (before as unknown as Record<string, unknown>)[key];
          if (value !== undefined && previous !== value) {
            changes[key] = { from: previous, to: value };
          }
        }

        if (body.lines) {
          for (const [lineId, patch] of Object.entries(body.lines)) {
            const index = next.lines.findIndex((l) => l.id === lineId);
            if (index === -1) continue;

            if (patch === null) {
              changes[`lines.${lineId}`] = { from: next.lines[index], to: null };
              next.lines.splice(index, 1);
              continue;
            }

            const current = next.lines[index]!;
            for (const [key, value] of Object.entries(patch)) {
              const previous = (current as unknown as Record<string, unknown>)[key];
              if (value !== undefined && previous !== value) {
                changes[`lines.${lineId}.${key}`] = { from: previous, to: value };
              }
            }
            next.lines[index] = { ...current, ...patch, id: current.id } as StagedLine;
          }
        }

        if (body.addLines?.length) {
          for (const addition of body.addLines) {
            const line: StagedLine = {
              ...emptyLine(randomUUID(), next.lines.length + 1),
              ...addition,
              id: randomUUID(),
              sourceRow: null,
            };
            next.lines.push(line);
            changes[`lines.${line.id}`] = { from: null, to: line };
          }
        }

        if (Object.keys(changes).length === 0) {
          return { updated: toStagedRow(row), changes };
        }

        const recalculated = recalcInvoice(next);
        const result = await revalidateRow(tx, ctx.tenantId!, row, recalculated);
        await refreshBatchCounters(tx, id);

        return {
          updated: {
            id: row.id,
            invoice: recalculated,
            findings: result.findings,
            submittable: result.submittable,
            status: null,
            invoiceId: null,
          } satisfies StagedRow,
          changes,
        };
      });

      if (Object.keys(changes).length > 0) {
        // Every cell edit is recorded. The uploaded workbook stays untouched in
        // WORM storage, so this trail is the only record of what a person
        // changed between what they sent and what was filed.
        await audit(actorFromContext(ctx), {
          action: 'STAGING_ROW_EDITED',
          resourceType: 'STAGING_ROW',
          resourceId: rowId,
          tenantId: ctx.tenantId,
          changes,
        });
      }

      return reply.send(updated);
    },
  );

  // --- Re-validate the whole batch ----------------------------------------
  app.post(
    '/api/v1/batches/:id/revalidate',
    { preHandler: requireRole(...EDITOR_ROLES) },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const summary = await withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx<StagingRowRecord[]>`
          SELECT * FROM staging_rows WHERE batch_id = ${id} AND invoice_id IS NULL
          ORDER BY row_index
        `;

        const context = await buildValidationContext(
          tx,
          ctx.tenantId!,
          rows.map((r) => r.payload.invoiceNumber),
        );
        context.batchInvoiceNumbers = await batchInvoiceNumberCounts(tx, id);

        let valid = 0;
        for (const row of rows) {
          const invoice = recalcInvoice(row.payload);
          const result = validateStagedRow(invoice, context);
          if (result.submittable) valid++;
          await persistRowValidation(
            tx,
            { id: row.id, tenantId: ctx.tenantId! },
            invoice,
            result.findings,
            result.submittable,
          );
        }

        await refreshBatchCounters(tx, id);
        return { checked: rows.length, valid, invalid: rows.length - valid };
      });

      await audit(actorFromContext(ctx), {
        action: 'BATCH_REVALIDATED',
        resourceType: 'BATCH',
        resourceId: id,
        tenantId: ctx.tenantId,
        changes: summary,
      });

      return reply.send(summary);
    },
  );

  // --- Auto-fix common defaults -------------------------------------------
  app.post(
    '/api/v1/batches/:id/autofix',
    { preHandler: requireRole(...EDITOR_ROLES) },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const outcome = await withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx<StagingRowRecord[]>`
          SELECT * FROM staging_rows WHERE batch_id = ${id} AND invoice_id IS NULL
          ORDER BY row_index
        `;

        const { invoices, changes } = autoFix(rows.map((r) => r.payload));

        const byInvoiceId = new Map(invoices.map((inv) => [inv.id, inv]));
        const rowByInvoiceId = new Map(rows.map((r) => [r.payload.id, r]));

        const context = await buildValidationContext(
          tx,
          ctx.tenantId!,
          invoices.map((i) => i.invoiceNumber),
        );
        context.batchInvoiceNumbers = await batchInvoiceNumberCounts(tx, id);

        const touched = new Set(changes.map((c) => c.invoiceId));
        for (const invoiceId of touched) {
          const row = rowByInvoiceId.get(invoiceId);
          const invoice = byInvoiceId.get(invoiceId);
          if (!row || !invoice) continue;

          const result = validateStagedRow(invoice, context);
          await persistRowValidation(
            tx,
            { id: row.id, tenantId: ctx.tenantId! },
            invoice,
            result.findings,
            result.submittable,
          );
        }

        await refreshBatchCounters(tx, id);

        return {
          changed: touched.size,
          changes: changes.map((c) => ({
            rowId: rowByInvoiceId.get(c.invoiceId)?.id ?? '',
            invoiceNumber: byInvoiceId.get(c.invoiceId)?.invoiceNumber ?? '',
            field: c.field,
            from: c.from,
            to: c.to,
            reason: c.reason,
          })),
        };
      });

      if (outcome.changed > 0) {
        await audit(actorFromContext(ctx), {
          action: 'BATCH_AUTOFIXED',
          resourceType: 'BATCH',
          resourceId: id,
          tenantId: ctx.tenantId,
          changes: { rowsChanged: outcome.changed, edits: outcome.changes },
        });
      }

      return reply.send(outcome);
    },
  );

  // --- Delete a staged row -------------------------------------------------
  app.delete(
    '/api/v1/batches/:id/staging/:rowId',
    { preHandler: requireRole(...EDITOR_ROLES) },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id, rowId } = request.params as { id: string; rowId: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      await withTenant(ctx.tenantId, async (tx) => {
        const row = await loadRow(tx, id, rowId);
        if (row.invoice_id) {
          throw conflict('This invoice has already been submitted and cannot be removed.');
        }
        await tx`DELETE FROM staging_rows WHERE id = ${rowId}`;
        await refreshBatchCounters(tx, id);
      });

      await audit(actorFromContext(ctx), {
        action: 'STAGING_ROW_DELETED',
        resourceType: 'STAGING_ROW',
        resourceId: rowId,
        tenantId: ctx.tenantId,
      });

      return reply.status(204).send();
    },
  );

  // --- Submit --------------------------------------------------------------
  app.post(
    '/api/v1/batches/:id/submit',
    { preHandler: requireRole(...EDITOR_ROLES) },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const body = SubmitBatchRequest.parse(request.body ?? {});

      const outcome = await withTenant(ctx.tenantId, async (tx) => {
        const tenants = await tx<{ status: string }[]>`
          SELECT status FROM tenants WHERE id = ${ctx.tenantId}
        `;
        if (tenants[0]?.status !== 'ACTIVE') {
          throw badRequest(
            'Your account is not yet active with our network provider, so invoices cannot be submitted. Corrections you make now are saved.',
          );
        }

        const configs = await tx<{ status: string }[]>`
          SELECT status FROM tenant_asp_configs WHERE tenant_id = ${ctx.tenantId} AND is_active
        `;
        if (configs[0]?.status !== 'ACTIVE') {
          throw badRequest(
            'Your provider connection is not active. Invoices cannot be submitted until it is.',
          );
        }

        const rows = await tx<StagingRowRecord[]>`
          SELECT * FROM staging_rows
          WHERE batch_id = ${id}
            AND invoice_id IS NULL
            AND (${body.rowIds ?? null}::uuid[] IS NULL OR id = ANY(${body.rowIds ?? null}::uuid[]))
          ORDER BY row_index
        `;

        const reasons: { rowId: string; reason: string }[] = [];
        const queued: { invoiceId: string }[] = [];

        for (const row of rows) {
          if (!row.submittable) {
            reasons.push({ rowId: row.id, reason: 'Row still has validation errors.' });
            continue;
          }

          const invoice = recalcInvoice(row.payload);
          const typeSpec = INVOICE_TYPES[invoice.invoiceType as InvoiceTypeCode];

          const inserted = await tx<{ id: string }[]>`
            INSERT INTO invoices (
              tenant_id, batch_upload_id, staging_row_id, source_channel, excel_row_index,
              invoice_number, invoice_type, issue_date, issue_time, currency_code, exchange_rate,
              seller_trn, seller_name, buyer_trn, buyer_name, buyer_emirate,
              po_reference, preceding_invoice_id, payment_means,
              line_extension_amount, tax_exclusive_amount, tax_inclusive_amount,
              vat_total_amount, payable_amount, payable_amount_aed,
              status, raw_payload_json
            ) VALUES (
              ${ctx.tenantId}, ${id}, ${row.id}, 'EXCEL_UPLOAD', ${invoice.sourceRow},
              ${invoice.invoiceNumber},
              ${typeSpec?.dbValue ?? 'TAX_INVOICE'}::invoice_type,
              ${invoice.issueDate}::date, ${invoice.issueTime}::time,
              ${invoice.currency}, ${invoice.fxRate || '1.000000'},
              ${invoice.supplierTrn}, ${invoice.supplierName},
              ${invoice.buyerTrn || null}, ${invoice.buyerName}, ${invoice.buyerEmirate},
              ${invoice.poReference || null}, ${invoice.precedingInvoiceId || null},
              ${invoice.paymentMeans || null},
              ${invoice.lineExtensionAmount}, ${invoice.taxExclusiveAmount},
              ${invoice.taxInclusiveAmount}, ${invoice.vatTotalAmount},
              ${invoice.payableAmount}, ${invoice.payableAmountAed},
              'VALIDATED', ${jsonb(tx, invoice)}
            )
            RETURNING id
          `;

          const invoiceId = inserted[0]!.id;

          await tx`
            INSERT INTO invoice_line_items ${tx(
              invoice.lines.map((line, index) => ({
                tenant_id: ctx.tenantId!,
                invoice_id: invoiceId,
                line_number: Number(line.lineNumber) || index + 1,
                item_name: line.description,
                hs_code: line.hsCode || null,
                quantity: line.quantity,
                unit_of_measure: line.uom,
                unit_price: line.unitPrice,
                discount_amount: line.lineDiscount || '0',
                vat_category:
                  VAT_CATEGORIES[line.vatCategory as VatCategoryCode]?.dbValue ?? 'STANDARD',
                vat_rate: line.vatRate,
                vat_amount: line.vatAmount,
                net_amount: line.netAmount,
                total_amount: line.lineTotal,
              })),
            )}
          `;

          await tx`UPDATE staging_rows SET invoice_id = ${invoiceId} WHERE id = ${row.id}`;
          queued.push({ invoiceId });
        }

        await refreshBatchCounters(tx, id);
        return { queued, reasons, skipped: reasons.length };
      });

      // Enqueued after the transaction commits. Doing it inside would let a
      // worker pick up an invoice id that a rollback then erased.
      for (const item of outcome.queued) {
        await invoiceSubmitQueue().add(
          'submit',
          { invoiceId: item.invoiceId, tenantId: ctx.tenantId, actorUserId: ctx.userId },
          { ...SUBMIT_JOB_OPTIONS, jobId: `submit-${item.invoiceId}` },
        );
      }

      await audit(actorFromContext(ctx), {
        action: 'BATCH_SUBMITTED',
        resourceType: 'BATCH',
        resourceId: id,
        tenantId: ctx.tenantId,
        changes: { queued: outcome.queued.length, skipped: outcome.skipped },
      });

      return reply.send({
        queued: outcome.queued.length,
        skipped: outcome.skipped,
        reasons: outcome.reasons,
      });
    },
  );
}
