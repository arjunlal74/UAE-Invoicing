import {
  ApprovalDecisionRequest,
  type ApprovalDecisionResponse,
} from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { withTenant } from '../../db/client.js';
import { requireContext, requirePermission } from '../../http/context.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { SUBMIT_JOB_OPTIONS, invoiceSubmitQueue } from '../../queue/queues.js';

/**
 * The tax approver's desk (SRS v2.1 §5).
 *
 * Everything an accountant prepares stops at PENDING_CFO_APPROVAL. Releasing it
 * is the only route to the FTA, and it is reserved to the approver — which is
 * why both endpoints here ask for `invoice.submit` and nothing else does.
 *
 * The queue itself is read through the ordinary invoice search with
 * `?status=PENDING_CFO_APPROVAL`; duplicating that query with its filters and
 * paging would only give it a second place to drift.
 */

interface PendingRow {
  id: string;
  invoice_number: string;
  status: string;
  staging_row_id: string | null;
}

/** The rows this decision applies to: the named ones, or the whole queue. */
async function loadQueue(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  invoiceIds: string[] | undefined,
) {
  return tx<PendingRow[]>`
    SELECT id, invoice_number, status, staging_row_id
    FROM invoices
    WHERE tenant_id = ${tenantId}
      -- The approval gate is an outbound control (SRS §16). A purchase invoice
      -- named explicitly by id must not be swept into it.
      AND direction = 'OUTBOUND_SALES_AR'
      AND (${invoiceIds ?? null}::uuid[] IS NULL OR id = ANY(${invoiceIds ?? null}::uuid[]))
      AND (${invoiceIds ?? null}::uuid[] IS NOT NULL OR status = 'PENDING_CFO_APPROVAL')
    ORDER BY created_at
  `;
}

export function registerApprovalRoutes(app: FastifyInstance) {
  // --- Approve: release to the FTA -----------------------------------------
  app.post(
    '/api/v1/approvals/approve',
    { preHandler: requirePermission('invoice.submit') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const body = ApprovalDecisionRequest.parse(request.body ?? {});

      const outcome = await withTenant(ctx.tenantId, async (tx) => {
        // The same two gates the batch submit path applies. An approval that
        // cannot reach the FTA would sit in the queue looking successful.
        const tenants = await tx<{ status: string }[]>`
          SELECT status FROM tenants WHERE id = ${ctx.tenantId}
        `;
        if (tenants[0]?.status !== 'ACTIVE') {
          throw badRequest(
            'Your account is not yet active with our network provider, so invoices cannot be filed.',
          );
        }

        const configs = await tx<{ status: string }[]>`
          SELECT status FROM tenant_asp_configs WHERE tenant_id = ${ctx.tenantId} AND is_active
        `;
        if (configs[0]?.status !== 'ACTIVE') {
          throw badRequest('Your provider connection is not active. Invoices cannot be filed yet.');
        }

        const rows = await loadQueue(tx, ctx.tenantId!, body.invoiceIds);

        const approved: string[] = [];
        const reasons: { invoiceId: string; reason: string }[] = [];

        for (const row of rows) {
          if (row.status !== 'PENDING_CFO_APPROVAL') {
            reasons.push({
              invoiceId: row.id,
              reason: `This invoice is ${row.status.toLowerCase().replace(/_/g, ' ')}, not awaiting approval.`,
            });
            continue;
          }

          await tx`
            UPDATE invoices
            SET status              = 'VALIDATED',
                approved_by_user_id = ${ctx.userId},
                approved_at         = CURRENT_TIMESTAMP,
                approval_note       = ${body.note ?? null}
            WHERE id = ${row.id}
          `;
          approved.push(row.id);
        }

        return { approved, reasons };
      });

      // After the commit, for the same reason batch submission enqueues late:
      // a rolled-back transaction would leave the worker chasing a missing row.
      for (const invoiceId of outcome.approved) {
        await invoiceSubmitQueue().add(
          'submit',
          { invoiceId, tenantId: ctx.tenantId, actorUserId: ctx.userId },
          { ...SUBMIT_JOB_OPTIONS, jobId: `submit-${invoiceId}` },
        );
      }

      await audit(actorFromContext(ctx), {
        action: 'INVOICES_APPROVED',
        resourceType: 'INVOICE',
        resourceId: null,
        tenantId: ctx.tenantId,
        changes: { approved: outcome.approved.length, note: body.note ?? null },
      });

      const response: ApprovalDecisionResponse = {
        affected: outcome.approved.length,
        skipped: outcome.reasons.length,
        reasons: outcome.reasons,
      };
      return reply.send(response);
    },
  );

  // --- Reject: hand back to whoever prepared it ----------------------------
  app.post(
    '/api/v1/approvals/reject',
    { preHandler: requirePermission('invoice.submit') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const body = ApprovalDecisionRequest.parse(request.body ?? {});
      if (!body.note) {
        throw badRequest('Give a reason so the preparer knows what to correct.');
      }

      const outcome = await withTenant(ctx.tenantId, async (tx) => {
        const rows = await loadQueue(tx, ctx.tenantId!, body.invoiceIds);

        const rejected: { id: string; invoiceNumber: string }[] = [];
        const reasons: { invoiceId: string; reason: string }[] = [];

        for (const row of rows) {
          if (row.status !== 'PENDING_CFO_APPROVAL') {
            reasons.push({
              invoiceId: row.id,
              reason: `This invoice is ${row.status.toLowerCase().replace(/_/g, ' ')}, not awaiting approval.`,
            });
            continue;
          }

          // A rejected invoice never left the building, so it is withdrawn
          // rather than marked failed: the staged row reopens for editing and
          // the invoice number is freed for the corrected resubmission. Keeping
          // the row would hold that number against `uq_tenant_invoice_num` and
          // leave the preparer unable to file the fix at all.
          if (row.staging_row_id) {
            await tx`
              UPDATE staging_rows SET invoice_id = NULL WHERE id = ${row.staging_row_id}
            `;
          }
          await tx`DELETE FROM invoices WHERE id = ${row.id}`;
          rejected.push({ id: row.id, invoiceNumber: row.invoice_number });
        }

        return { rejected, reasons };
      });

      // The invoice rows are gone, so the audit trail is the only record that
      // these documents were ever prepared. It carries the numbers explicitly.
      await audit(actorFromContext(ctx), {
        action: 'INVOICES_REJECTED_BY_APPROVER',
        resourceType: 'INVOICE',
        resourceId: null,
        tenantId: ctx.tenantId,
        changes: {
          note: body.note,
          invoiceNumbers: outcome.rejected.map((r) => r.invoiceNumber),
        },
      });

      const response: ApprovalDecisionResponse = {
        affected: outcome.rejected.length,
        skipped: outcome.reasons.length,
        reasons: outcome.reasons,
      };
      return reply.send(response);
    },
  );
}
