import { IngestInvoiceRequest, type InvoiceStatusResponse } from '@uae/contracts';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { consumeRateLimit } from '../../auth/rateLimit.js';
import { jsonb, withTenant } from '../../db/client.js';
import { ctxCan, requireApiAccess, requireContext } from '../../http/context.js';
import { AppError, conflict, notFound, tooManyRequests } from '../../lib/errors.js';
import { ingestInvoice } from './service.js';

/**
 * Ingestion channel 1 (SRS v1.2 §"POST /v1/invoices", v2.1 §1.2).
 *
 * The endpoints an ERP integrates against. Two of them, which is the whole
 * surface a sending system needs: post the document, then ask what happened to
 * it. Clearance is asynchronous — the tax authority answers in its own time —
 * so the second endpoint exists precisely because the first cannot tell the
 * caller how the story ends.
 */

/**
 * Per-key request cap.
 *
 * Generous, because the thing on the other end is a nightly batch run that
 * legitimately posts a thousand invoices in five minutes. The cap exists to
 * stop a runaway retry loop consuming the tenant's data bundle and the FTA's
 * patience, not to shape normal traffic.
 */
const INGEST_LIMIT = 600;
const INGEST_WINDOW_SECONDS = 60;

export function registerIngestionRoutes(app: FastifyInstance) {
  // --- Post a document -----------------------------------------------------
  app.post(
    '/api/v1/invoices',
    { preHandler: requireApiAccess('invoice.submit', 'invoice.submit_for_approval') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      await enforceRateLimit(request);

      const body = IngestInvoiceRequest.parse(request.body);
      const idempotencyKey = headerValue(request, 'idempotency-key');

      // A replay must return the original outcome rather than attempt the work
      // again — filing the same invoice twice is a penalty for the merchant.
      if (idempotencyKey) {
        const replay = await findReplay(ctx.tenantId, idempotencyKey, request.body);
        if (replay) {
          return reply
            .status(replay.status_code)
            .header('idempotent-replay', 'true')
            .send({ ...(replay.response_body as object), duplicate: true });
        }
      }

      // §16: a key scoped only to prepare gets the same treatment as an
      // accountant — the document is composed and parked for the approver.
      const canFile = ctxCan(ctx, 'invoice.submit');

      let outcome;
      try {
        outcome = await ingestInvoice(body, {
          tenantId: ctx.tenantId,
          apiKeyId: ctx.apiKey?.id ?? null,
          userId: ctx.apiKey ? null : ctx.userId,
          canFile,
        });
      } catch (error) {
        // A rejection is an outcome too. Recording it under the idempotency key
        // means a retrying ERP is told the same thing rather than being let
        // through on the second attempt because a race resolved differently.
        if (idempotencyKey && error instanceof AppError && error.statusCode < 500) {
          await recordOutcome(ctx.tenantId, ctx.apiKey?.id ?? null, idempotencyKey, request.body, {
            statusCode: error.statusCode,
            body: { error: { code: error.code, message: error.message, details: error.details } },
            invoiceId: null,
          });
        }
        throw error;
      }

      if (idempotencyKey) {
        await recordOutcome(ctx.tenantId, ctx.apiKey?.id ?? null, idempotencyKey, request.body, {
          statusCode: 201,
          body: outcome.response,
          invoiceId: outcome.invoiceId,
        });
      }

      await audit(actorFromContext(ctx), {
        action: outcome.queued ? 'INVOICE_INGESTED' : 'INVOICE_INGESTED_FOR_APPROVAL',
        resourceType: 'INVOICE',
        resourceId: outcome.invoiceId,
        tenantId: ctx.tenantId,
        changes: {
          invoiceNumber: outcome.response.invoiceNumber,
          channel: 'REST_API',
          apiKey: ctx.apiKey?.name ?? null,
        },
      });

      return reply.status(201).send(outcome.response);
    },
  );

  // --- Ask what happened ---------------------------------------------------
  /**
   * v1.2 names this `GET /v1/invoices/status/{invoice_number}`, keyed by the
   * number rather than by our id, because that is what the sending system wrote
   * on its own ledger row. It is a distinct route from `/invoices/:id` for the
   * same reason: an ERP should never have to store a foreign primary key to ask
   * about a document it issued.
   */
  app.get(
    '/api/v1/invoices/status/:invoiceNumber',
    { preHandler: requireApiAccess('invoice.read') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const { invoiceNumber } = request.params as { invoiceNumber: string };

      const rows = await withTenant(
        ctx.tenantId,
        (tx) => tx<
          {
            id: string;
            invoice_number: string;
            status: InvoiceStatusResponse['status'];
            fta_irn: string | null;
            fta_rejection_reason: string | null;
            latest_response_code: string | null;
            is_commercial_dispute: boolean;
            dispute_resolved: boolean;
            submitted_at: Date | null;
            cleared_at: Date | null;
            currency_code: string;
            tax_exclusive_amount: string;
            vat_total_amount: string;
            payable_amount: string;
            payable_amount_aed: string;
          }[]
        >`
          SELECT id, invoice_number, status, fta_irn, fta_rejection_reason,
                 latest_response_code::text AS latest_response_code,
                 is_commercial_dispute, dispute_resolved,
                 submitted_at, cleared_at, currency_code,
                 tax_exclusive_amount, vat_total_amount, payable_amount, payable_amount_aed
          FROM invoices
          WHERE tenant_id = ${ctx.tenantId}
            AND direction = 'OUTBOUND_SALES_AR'
            AND invoice_number = ${invoiceNumber}
        `,
      );

      const row = rows[0];
      if (!row) throw notFound(`Invoice ${invoiceNumber}`);

      const response: InvoiceStatusResponse = {
        id: row.id,
        invoiceNumber: row.invoice_number,
        status: row.status,
        ftaIrn: row.fta_irn,
        rejectionReason: row.fta_rejection_reason,
        buyerResponseCode: row.latest_response_code,
        isDisputed: row.is_commercial_dispute && !row.dispute_resolved,
        submittedAt: row.submitted_at?.toISOString() ?? null,
        clearedAt: row.cleared_at?.toISOString() ?? null,
        totals: {
          taxExclusiveAmount: row.tax_exclusive_amount,
          vatTotalAmount: row.vat_total_amount,
          payableAmount: row.payable_amount,
          payableAmountAed: row.payable_amount_aed,
          currency: row.currency_code,
        },
      };

      return reply.send(response);
    },
  );
}

// ---------------------------------------------------------------------------

function headerValue(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  return text?.trim() ? text.trim().slice(0, 255) : null;
}

/**
 * Limit per key where there is one, per user otherwise.
 *
 * Not per IP: every ERP behind one corporate NAT would share a bucket, and the
 * noisy neighbour would be a different customer entirely.
 */
async function enforceRateLimit(request: FastifyRequest): Promise<void> {
  const ctx = requireContext(request);
  const subject = ctx.apiKey ? `key:${ctx.apiKey.id}` : `user:${ctx.userId}`;

  const result = await consumeRateLimit(`ingest:${subject}`, INGEST_LIMIT, INGEST_WINDOW_SECONDS);
  if (!result.allowed) {
    throw tooManyRequests(
      `Too many submissions. This key is limited to ${INGEST_LIMIT} per minute; try again in ${result.resetInSeconds}s.`,
    );
  }
}

function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null), 'utf8').digest('hex');
}

async function findReplay(
  tenantId: string,
  idempotencyKey: string,
  body: unknown,
): Promise<{ status_code: number; response_body: unknown } | null> {
  const rows = await withTenant(
    tenantId,
    (tx) => tx<{ status_code: number; response_body: unknown; request_hash: string }[]>`
      SELECT status_code, response_body, request_hash
      FROM ingestion_requests
      WHERE tenant_id = ${tenantId} AND idempotency_key = ${idempotencyKey}
    `,
  );

  const previous = rows[0];
  if (!previous) return null;

  // Same key, different invoice. Returning the first invoice's receipt would
  // hide a real bug in the caller — most likely a key that is not being
  // regenerated per document — and silently drop an invoice on the floor.
  if (previous.request_hash !== hashBody(body)) {
    throw conflict(
      'This Idempotency-Key was already used for a different request body. Use a new key for each document.',
    );
  }

  return previous;
}

async function recordOutcome(
  tenantId: string,
  apiKeyId: string | null,
  idempotencyKey: string,
  body: unknown,
  outcome: { statusCode: number; body: unknown; invoiceId: string | null },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    // Two concurrent retries of the same request race here; whichever loses
    // finds the winner's row on its next attempt, which is the correct
    // behaviour rather than an error worth surfacing.
    await tx`
      INSERT INTO ingestion_requests (
        tenant_id, api_key_id, idempotency_key, request_hash,
        status_code, response_body, invoice_id
      ) VALUES (
        ${tenantId}, ${apiKeyId}, ${idempotencyKey}, ${hashBody(body)},
        ${outcome.statusCode}, ${jsonb(tx, outcome.body)}, ${outcome.invoiceId}
      )
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    `;
  });
}
