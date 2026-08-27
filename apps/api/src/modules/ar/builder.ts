import {
  PrepareCreditNoteRequest,
  SaveDraftRequest,
  type CreditNotePreparation,
  type DraftResponse,
  type InvoiceStatus,
  type RejectionReasonCode,
  type ReversalMode,
  type StagedInvoiceDto,
} from '@uae/contracts';
import {
  INVOICE_TYPES,
  buildCreditNote,
  recalcInvoice,
  type InvoiceTypeCode,
  type StagedInvoice,
} from '@uae/domain';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { jsonb, withTenant, type Tx } from '../../db/client.js';
import { ctxCan, requireContext, requirePermission } from '../../http/context.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import {
  applyCustomer,
  applySeller,
  assertCanFile,
  insertDocument,
  nextNumber,
  queueSubmission,
  validateDocument,
  writeLines,
} from './documents.js';

/**
 * The in-app authoring suite — SRS v2.7 §7 (Invoice Builder) and §8 (Credit
 * Note Builder).
 *
 * This is the third ingestion channel (§1.3): no spreadsheet, no ERP, just a
 * person composing a document in the browser. It reuses the staging pipeline
 * wholesale — same `StagedInvoice` payload, same validator, same XML builder,
 * same CFO gate — because a compliance rule that applies to an uploaded invoice
 * has to apply identically to a typed one, and two implementations of "is this
 * invoice legal" is one too many.
 *
 * Drafts live in `invoices` at status DRAFT rather than in a table of their own.
 * That gives them the invoice-number uniqueness constraint for free (two
 * accountants cannot both reserve INV-2026-00950), keeps the credit note's
 * foreign key to its preceding document honest, and means "submit" is a status
 * transition rather than a copy between tables.
 */

interface DraftRow {
  id: string;
  invoice_number: string;
  status: InvoiceStatus;
  customer_id: string | null;
  raw_payload_json: StagedInvoice | null;
  referenced_invoice_id: string | null;
  referenced_invoice_number: string | null;
  referenced_fta_irn: string | null;
  credit_note_reason_code: RejectionReasonCode | null;
  credit_note_reversal_mode: ReversalMode | null;
  credit_note_notes: string | null;
  created_at: Date;
}

function toDraftResponse(
  row: DraftRow,
  findings: DraftResponse['findings'],
  submittable: boolean,
): DraftResponse {
  const invoice = row.raw_payload_json!;
  const isCreditNote = INVOICE_TYPES[invoice.invoiceType as InvoiceTypeCode]?.requiresPrecedingInvoice;

  return {
    id: row.id,
    invoice: invoice as unknown as StagedInvoiceDto,
    customerId: row.customer_id,
    status: row.status,
    findings,
    submittable,
    creditNote: isCreditNote
      ? {
          referencedInvoiceId: row.referenced_invoice_id,
          referencedInvoiceNumber: row.referenced_invoice_number,
          referencedFtaIrn: row.referenced_fta_irn,
          reversalMode: row.credit_note_reversal_mode,
          reasonCode: row.credit_note_reason_code,
          notes: row.credit_note_notes,
        }
      : null,
  };
}

async function loadDraft(tx: Tx, id: string): Promise<DraftRow> {
  const rows = await tx<DraftRow[]>`
    SELECT id, invoice_number, status, customer_id, raw_payload_json,
           referenced_invoice_id, referenced_invoice_number, referenced_fta_irn,
           credit_note_reason_code, credit_note_reversal_mode, credit_note_notes, created_at
    FROM invoices WHERE id = ${id}
  `;
  const row = rows[0];
  if (!row) throw notFound('Draft');
  if (row.status !== 'DRAFT') {
    throw conflict(
      'This document has already been submitted and can no longer be edited. Issue a credit note to correct it.',
    );
  }
  if (!row.raw_payload_json) throw badRequest('This draft has no content to edit.');
  return row;
}

export function registerArBuilderRoutes(app: FastifyInstance) {
  // --- Suggested document number -------------------------------------------
  app.get(
    '/api/v1/ar/next-number',
    { preHandler: requirePermission('invoice.edit') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const { type } = request.query as { type?: string };
      const invoiceNumber = await withTenant(ctx.tenantId, (tx) =>
        nextNumber(tx, ctx.tenantId!, type ?? '380'),
      );
      return reply.send({ invoiceNumber });
    },
  );

  // --- List drafts ---------------------------------------------------------
  app.get(
    '/api/v1/ar/drafts',
    { preHandler: requirePermission('invoice.read') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const rows = await withTenant(
        ctx.tenantId,
        (tx) => tx<
          {
            id: string;
            invoice_number: string;
            invoice_type: string;
            issue_date: Date;
            buyer_name: string;
            payable_amount: string;
            currency_code: string;
            referenced_invoice_number: string | null;
            created_by_name: string | null;
            updated_at: Date;
          }[]
        >`
          SELECT i.id, i.invoice_number, i.invoice_type, i.issue_date, i.buyer_name,
                 i.payable_amount, i.currency_code, i.referenced_invoice_number, i.updated_at,
                 (SELECT full_name FROM users u WHERE u.id = i.created_by_user_id) AS created_by_name
          FROM invoices i
          WHERE i.tenant_id = ${ctx.tenantId}
            AND i.direction = 'OUTBOUND_SALES_AR'
            AND i.status = 'DRAFT'
          ORDER BY i.updated_at DESC
          LIMIT 200
        `,
      );

      return reply.send({
        items: rows.map((row) => ({
          id: row.id,
          invoiceNumber: row.invoice_number,
          invoiceType: row.invoice_type,
          issueDate: row.issue_date.toISOString().slice(0, 10),
          buyerName: row.buyer_name,
          payableAmount: row.payable_amount,
          currencyCode: row.currency_code,
          referencedInvoiceNumber: row.referenced_invoice_number,
          createdByName: row.created_by_name,
          updatedAt: row.updated_at.toISOString(),
        })),
      });
    },
  );

  // --- Open one draft ------------------------------------------------------
  app.get(
    '/api/v1/ar/drafts/:id',
    { preHandler: requirePermission('invoice.read') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const result = await withTenant(ctx.tenantId, async (tx) => {
        const row = await loadDraft(tx, id);
        const validation = await validateDraft(tx, ctx.tenantId!, row);
        return { row, validation };
      });

      return reply.send(
        toDraftResponse(result.row, result.validation.findings, result.validation.submittable),
      );
    },
  );

  // --- Create or save ------------------------------------------------------
  app.post(
    '/api/v1/ar/drafts',
    { preHandler: requirePermission('invoice.edit') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const body = SaveDraftRequest.parse(request.body);
      const result = await saveDraft(ctx.tenantId, ctx.userId, body, null);

      await audit(actorFromContext(ctx), {
        action: 'DRAFT_SAVED',
        resourceType: 'INVOICE',
        resourceId: result.id,
        tenantId: ctx.tenantId,
        changes: {
          invoiceNumber: result.invoice.invoiceNumber,
          type: result.invoice.invoiceType,
          created: true,
        },
      });

      return reply.status(201).send(result.response);
    },
  );

  app.put(
    '/api/v1/ar/drafts/:id',
    { preHandler: requirePermission('invoice.edit') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const body = SaveDraftRequest.parse(request.body);
      const result = await saveDraft(ctx.tenantId, ctx.userId, body, id);

      await audit(actorFromContext(ctx), {
        action: 'DRAFT_SAVED',
        resourceType: 'INVOICE',
        resourceId: id,
        tenantId: ctx.tenantId,
        changes: { invoiceNumber: result.invoice.invoiceNumber, created: false },
      });

      return reply.send(result.response);
    },
  );

  // --- Discard -------------------------------------------------------------
  app.delete(
    '/api/v1/ar/drafts/:id',
    { preHandler: requirePermission('invoice.edit') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const number = await withTenant(ctx.tenantId, async (tx) => {
        const row = await loadDraft(tx, id);
        // A draft has never been filed, so it can genuinely be deleted rather
        // than archived. This is the one document state where that is true.
        await tx`DELETE FROM invoices WHERE id = ${id}`;
        return row.invoice_number;
      });

      await audit(actorFromContext(ctx), {
        action: 'DRAFT_DISCARDED',
        resourceType: 'INVOICE',
        resourceId: id,
        tenantId: ctx.tenantId,
        changes: { invoiceNumber: number },
      });

      return reply.status(204).send();
    },
  );

  // --- Pre-flight validation (§8.1 "Pre-Flight Saxon-JS Validation") -------
  app.post(
    '/api/v1/ar/drafts/:id/validate',
    { preHandler: requirePermission('invoice.read') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const result = await withTenant(ctx.tenantId, async (tx) => {
        const row = await loadDraft(tx, id);
        return { row, validation: await validateDraft(tx, ctx.tenantId!, row) };
      });

      return reply.send(
        toDraftResponse(result.row, result.validation.findings, result.validation.submittable),
      );
    },
  );

  // --- Submit --------------------------------------------------------------
  app.post(
    '/api/v1/ar/drafts/:id/submit',
    { preHandler: requirePermission('invoice.submit_for_approval', 'invoice.submit') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      // §8.2 feature 6, and §16 for ordinary invoices: the accountant composes
      // and validates, the tax approver releases. Same gate as the batch path.
      const files = ctxCan(ctx, 'invoice.submit');

      const outcome = await withTenant(ctx.tenantId, async (tx) => {
        const row = await loadDraft(tx, id);

        // The same gate the Excel channel and the ERP API pass through.
        await assertCanFile(tx, ctx.tenantId!);

        const validation = await validateDraft(tx, ctx.tenantId!, row);
        if (!validation.submittable) {
          throw badRequest(
            'This document still has validation errors. Correct them before submitting.',
            validation.findings.filter((f) => f.severity === 'ERROR' || f.severity === 'FATAL'),
          );
        }

        const invoice = recalcInvoice(row.raw_payload_json!);

        await tx`
          UPDATE invoices SET
            status              = ${files ? 'VALIDATED' : 'PENDING_CFO_APPROVAL'}::invoice_status,
            approved_by_user_id = ${files ? ctx.userId : null},
            approved_at         = ${files ? new Date() : null},
            raw_payload_json    = ${jsonb(tx, invoice)},
            erp_reverse_sync_status = 'NOT_APPLICABLE'
          WHERE id = ${id}
        `;

        return { invoiceNumber: row.invoice_number, invoice };
      });

      if (files) {
        await queueSubmission(id, ctx.tenantId!, ctx.userId);
      }

      await audit(actorFromContext(ctx), {
        action: files ? 'DRAFT_SUBMITTED' : 'DRAFT_SENT_FOR_APPROVAL',
        resourceType: 'INVOICE',
        resourceId: id,
        tenantId: ctx.tenantId,
        changes: { invoiceNumber: outcome.invoiceNumber },
      });

      return reply.send({
        id,
        queued: files,
        pendingApproval: !files,
        message: files
          ? 'Submitted to the tax authority.'
          : 'Sent to your tax approver for clearance.',
      });
    },
  );

  // --- §8.2 feature 1: prepare a credit note from a disputed invoice --------
  app.post(
    '/api/v1/ar/credit-notes/prepare',
    { preHandler: requirePermission('invoice.edit') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const body = PrepareCreditNoteRequest.parse(request.body);

      const preparation = await withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx<
          {
            id: string;
            invoice_number: string;
            issue_date: Date;
            status: InvoiceStatus;
            fta_irn: string | null;
            payable_amount: string;
            currency_code: string;
            raw_payload_json: StagedInvoice | null;
            latest_response_reason_code: RejectionReasonCode | null;
            latest_response_comment: string | null;
            dispute_resolved: boolean;
            corrective_credit_note_id: string | null;
            customer_id: string | null;
          }[]
        >`
          SELECT id, invoice_number, issue_date, status, fta_irn, payable_amount, currency_code,
                 raw_payload_json, latest_response_reason_code, latest_response_comment,
                 dispute_resolved, corrective_credit_note_id, customer_id
          FROM invoices
          WHERE id = ${body.referencedInvoiceId}
            AND direction = 'OUTBOUND_SALES_AR'
        `;

        const original = rows[0];
        if (!original) throw notFound('Invoice');

        // §8: a credit note corrects a document that is already legally out
        // there. Crediting something that was never filed would produce a
        // BillingReference pointing at nothing.
        if (original.status === 'DRAFT' || original.status === 'PENDING_CFO_APPROVAL') {
          throw badRequest(
            'That invoice has not been filed yet. Edit or withdraw it rather than crediting it.',
          );
        }
        if (!original.raw_payload_json) {
          throw badRequest('The original invoice has no stored content to reverse.');
        }
        if (original.corrective_credit_note_id) {
          throw conflict(
            'A credit note has already been raised against this invoice. Open that document instead.',
          );
        }

        const staged = recalcInvoice(original.raw_payload_json);
        const now = new Date();
        const creditNoteNumber = await nextNumber(tx, ctx.tenantId!, '381');

        const draft = buildCreditNote({
          original: staged,
          mode: body.reversalMode,
          creditNoteNumber,
          issueDate: now.toISOString().slice(0, 10),
          issueTime: now.toISOString().slice(11, 19),
          // A partial adjustment starts with nothing selected: the accountant
          // decides which lines move, and pre-crediting them all would make
          // "partial" the same button as "full" with an extra step.
          adjustments: [],
          id: randomUUID(),
          lineIds: staged.lines.map(() => randomUUID()),
        });

        const result: CreditNotePreparation = {
          invoice: draft as unknown as StagedInvoiceDto,
          referenced: {
            id: original.id,
            invoiceNumber: original.invoice_number,
            issueDate: original.issue_date.toISOString().slice(0, 10),
            ftaIrn: original.fta_irn,
            payableAmount: original.payable_amount,
            currencyCode: original.currency_code,
            status: original.status,
            disputeReasonCode: original.latest_response_reason_code,
            disputeComment: original.latest_response_comment,
            lines: staged.lines as unknown as CreditNotePreparation['referenced']['lines'],
          },
          reversalMode: body.reversalMode,
          // §8.2 feature 4: default the justification to whatever the buyer
          // actually complained about, so the common case is one click.
          reasonCode: body.reasonCode ?? original.latest_response_reason_code ?? 'OTH',
        };

        return result;
      });

      return reply.send(preparation);
    },
  );

  // --- §11 the dispute desk ------------------------------------------------
  app.get(
    '/api/v1/ar/disputes',
    { preHandler: requirePermission('invoice.read') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const { state } = request.query as { state?: 'open' | 'resolved' };
      const resolved = state === 'resolved';

      const rows = await withTenant(
        ctx.tenantId,
        (tx) => tx<
          {
            id: string;
            invoice_number: string;
            buyer_name: string;
            payable_amount_aed: string;
            fta_irn: string | null;
            latest_response_code: string | null;
            latest_response_reason_code: RejectionReasonCode | null;
            latest_response_comment: string | null;
            dispute_opened_at: Date | null;
            dispute_resolved_at: Date | null;
            corrective_credit_note_id: string | null;
            corrective_credit_note_number: string | null;
            days_open: string;
          }[]
        >`
          SELECT i.id, i.invoice_number, i.buyer_name, i.payable_amount_aed, i.fta_irn,
                 i.latest_response_code::text AS latest_response_code,
                 i.latest_response_reason_code, i.latest_response_comment,
                 i.dispute_opened_at, i.dispute_resolved_at, i.corrective_credit_note_id,
                 (SELECT c.invoice_number FROM invoices c WHERE c.id = i.corrective_credit_note_id)
                   AS corrective_credit_note_number,
                 coalesce(
                   extract(day from now() - coalesce(i.dispute_resolved_at, i.dispute_opened_at, now())),
                   0
                 )::int::text AS days_open
          FROM invoices i
          WHERE i.tenant_id = ${ctx.tenantId}
            AND i.direction = 'OUTBOUND_SALES_AR'
            AND i.is_commercial_dispute
            AND i.dispute_resolved = ${resolved}
          ORDER BY i.dispute_opened_at NULLS LAST
          LIMIT 500
        `,
      );

      return reply.send({
        items: rows.map((row) => ({
          id: row.id,
          invoiceNumber: row.invoice_number,
          buyerName: row.buyer_name,
          amountAed: row.payable_amount_aed,
          ftaIrn: row.fta_irn,
          responseCode: row.latest_response_code,
          reasonCode: row.latest_response_reason_code,
          comment: row.latest_response_comment,
          openedAt: row.dispute_opened_at?.toISOString() ?? null,
          resolvedAt: row.dispute_resolved_at?.toISOString() ?? null,
          daysOpen: Number(row.days_open),
          creditNoteId: row.corrective_credit_note_id,
          creditNoteNumber: row.corrective_credit_note_number,
        })),
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Shared work
// ---------------------------------------------------------------------------

/** A draft is validated by exactly the rules an ERP's submission is. */
async function validateDraft(tx: Tx, tenantId: string, row: DraftRow) {
  return validateDocument(tx, tenantId, row.raw_payload_json!, row.id);
}

/**
 * Create or update a draft.
 *
 * The client's payload is trusted for content and never for identity: the
 * seller block is re-read from the tenant, the buyer block is re-read from the
 * directory when a customer is named, and every amount is recalculated. A
 * browser that posts a payable amount of one dirham on a ten-thousand dirham
 * invoice gets the ten thousand.
 */
async function saveDraft(
  tenantId: string,
  userId: string,
  body: SaveDraftRequest,
  existingId: string | null,
): Promise<{ id: string; invoice: StagedInvoice; response: DraftResponse }> {
  return withTenant(tenantId, async (tx) => {
    if (existingId) await loadDraft(tx, existingId);

    let invoice = recalcInvoice(body.invoice as unknown as StagedInvoice);
    invoice = await applySeller(tx, tenantId, invoice);
    if (body.customerId) {
      invoice = await applyCustomer(tx, tenantId, body.customerId, invoice);
    }

    if (!invoice.invoiceNumber?.trim()) {
      invoice = { ...invoice, invoiceNumber: await nextNumber(tx, tenantId, invoice.invoiceType) };
    }

    const typeSpec = INVOICE_TYPES[invoice.invoiceType as InvoiceTypeCode];
    const isReversal = typeSpec?.requiresPrecedingInvoice === true;

    // §8.2 feature 2. Resolving the reference server-side is what guarantees the
    // credit note carries the IRN of the document it actually credits, rather
    // than whatever number the browser was holding.
    let referenced: {
      id: string;
      invoice_number: string;
      fta_irn: string | null;
      issue_date: Date;
      customer_id: string | null;
    } | null = null;

    if (isReversal) {
      if (!body.creditNote) {
        throw badRequest('A credit note must name the invoice it corrects.');
      }
      const rows = await tx<
        {
          id: string;
          invoice_number: string;
          fta_irn: string | null;
          issue_date: Date;
          customer_id: string | null;
          status: InvoiceStatus;
        }[]
      >`
        SELECT id, invoice_number, fta_irn, issue_date, customer_id, status
        FROM invoices
        WHERE id = ${body.creditNote.referencedInvoiceId}
          AND direction = 'OUTBOUND_SALES_AR'
      `;
      const original = rows[0];
      if (!original) throw notFound('Referenced invoice');
      if (original.status === 'DRAFT' || original.status === 'PENDING_CFO_APPROVAL') {
        throw badRequest(
          'That invoice has not been filed yet. Edit or withdraw it rather than crediting it.',
        );
      }
      referenced = original;
      invoice = { ...invoice, precedingInvoiceId: original.invoice_number };
    }

    const customerId = body.customerId ?? referenced?.customer_id ?? null;
    const typeDbValue = typeSpec?.dbValue ?? 'TAX_INVOICE';

    const id = existingId
      ? await updateDraftRow(tx, existingId, invoice, customerId, typeDbValue, body, referenced)
      : await insertDocument(tx, {
          tenantId,
          createdByUserId: userId,
          invoice,
          customerId,
          invoiceTypeDbValue: typeDbValue,
          status: 'DRAFT',
          sourceChannel: 'MANUAL_IN_APP_ENTRY',
          referenced,
          creditNote: body.creditNote ?? null,
          // Composed here, so there is no ERP row awaiting the clearance result.
          erpReverseSyncStatus: 'NOT_APPLICABLE',
        });

    await writeLines(tx, tenantId, id, invoice);

    const row = await loadDraft(tx, id);
    const validation = await validateDraft(tx, tenantId, row);

    return {
      id,
      invoice,
      response: toDraftResponse(row, validation.findings, validation.submittable),
    };
  });
}

async function updateDraftRow(
  tx: Tx,
  id: string,
  invoice: StagedInvoice,
  customerId: string | null,
  typeDbValue: string,
  body: SaveDraftRequest,
  referenced: { id: string; invoice_number: string; fta_irn: string | null } | null,
): Promise<string> {
  await tx`
    UPDATE invoices SET
      customer_id = ${customerId},
      invoice_number = ${invoice.invoiceNumber},
      invoice_type = ${typeDbValue}::invoice_type,
      issue_date = ${invoice.issueDate || new Date().toISOString().slice(0, 10)}::date,
      issue_time = ${invoice.issueTime || '00:00:00'}::time,
      currency_code = ${invoice.currency || 'AED'},
      exchange_rate = ${invoice.fxRate || '1.000000'},
      seller_trn = ${invoice.supplierTrn},
      seller_name = ${invoice.supplierName},
      buyer_trn = ${invoice.buyerTrn || null},
      buyer_name = ${invoice.buyerName},
      buyer_emirate = ${invoice.buyerEmirate},
      po_reference = ${invoice.poReference || null},
      preceding_invoice_id = ${invoice.precedingInvoiceId || null},
      payment_means = ${invoice.paymentMeans || null},
      line_extension_amount = ${invoice.lineExtensionAmount},
      tax_exclusive_amount = ${invoice.taxExclusiveAmount},
      tax_inclusive_amount = ${invoice.taxInclusiveAmount},
      vat_total_amount = ${invoice.vatTotalAmount},
      payable_amount = ${invoice.payableAmount},
      payable_amount_aed = ${invoice.payableAmountAed},
      raw_payload_json = ${jsonb(tx, invoice)},
      referenced_invoice_id = ${referenced?.id ?? null},
      referenced_invoice_number = ${referenced?.invoice_number ?? null},
      referenced_fta_irn = ${referenced?.fta_irn ?? null},
      credit_note_reason_code = ${body.creditNote?.reasonCode ?? null}::rejection_reason_code,
      credit_note_reversal_mode = ${body.creditNote?.reversalMode ?? null}::reversal_mode,
      credit_note_notes = ${body.creditNote?.notes ?? null}
    WHERE id = ${id}
  `;
  return id;
}
