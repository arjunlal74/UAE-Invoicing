import { jsonb, sql } from '../db/client.js';
import { logger } from '../logger.js';
import type { RequestContext } from '../http/context.js';

/**
 * Audit trail writes.
 *
 * Recorded for every state change: tenant lifecycle, user management, ASP
 * configuration, staged-cell edits, submissions, and clearance results. The
 * table has no UPDATE or DELETE grant for the application role, so entries are
 * append-only by database privilege rather than by convention.
 */

export type AuditAction =
  | 'TENANT_CREATED'
  | 'TENANT_UPDATED'
  | 'TENANT_STATUS_CHANGED'
  | 'USER_INVITED'
  | 'USER_UPDATED'
  | 'USER_DEACTIVATED'
  | 'USER_LOGIN'
  | 'PASSWORD_CHANGED'
  | 'PASSWORD_RESET'
  | 'PASSWORD_RESET_REQUESTED'
  | 'PASSWORD_ROTATION_REQUIRED'
  | 'ACCOUNT_LOCKED'
  | 'MFA_ENABLED'
  | 'MFA_DISABLED'
  | 'ASP_CONFIG_UPDATED'
  | 'ASP_CONNECTION_TESTED'
  | 'BATCH_UPLOADED'
  | 'BATCH_PARSED'
  | 'BATCH_AUTOFIXED'
  | 'BATCH_REVALIDATED'
  | 'BATCH_SUBMITTED'
  | 'BATCH_SENT_FOR_APPROVAL'
  | 'STAGING_ROW_EDITED'
  | 'STAGING_ROW_DELETED'
  | 'INVOICE_SUBMITTED'
  | 'INVOICE_STATUS_CHANGED'
  | 'INVOICE_RETRIED'
  | 'INVOICES_APPROVED'
  | 'INVOICES_REJECTED_BY_APPROVER'
  | 'MAIL_ACCOUNT_SAVED'
  | 'MAIL_ACCOUNT_DELETED'
  | 'MAIL_ACCOUNT_TESTED'
  | 'SUB_TENANT_CREATED'
  | 'WEBHOOK_RECEIVED'
  // --- SRS v2.7: the two modules ---------------------------------------------
  | 'CUSTOMER_CREATED'
  | 'CUSTOMER_UPDATED'
  | 'CUSTOMER_DEACTIVATED'
  | 'SUPPLIER_CREATED'
  | 'SUPPLIER_UPDATED'
  | 'SUPPLIER_DEACTIVATED'
  | 'DRAFT_SAVED'
  | 'DRAFT_DISCARDED'
  | 'DRAFT_SUBMITTED'
  | 'DRAFT_SENT_FOR_APPROVAL'
  | 'CREDIT_NOTE_CLEARED'
  | 'INVOICE_RESPONSE_RECEIVED'
  | 'PURCHASE_INVOICE_RECEIVED'
  | 'PURCHASE_INVOICE_MATCHED'
  | 'PURCHASE_INVOICE_DECIDED'
  | 'AP_RESPONSE_TRANSMITTED'
  | 'BUNDLE_CREATED'
  | 'BUNDLE_UPDATED';

export interface AuditEntry {
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null;
  tenantId?: string | null;
  changes?: unknown;
}

export interface AuditActor {
  actorId?: string | null;
  actorName?: string | null;
  actorType: 'USER' | 'SYSTEM' | 'ASP_WEBHOOK';
  ip?: string | null;
  userAgent?: string | null;
  tenantId?: string | null;
}

export function actorFromContext(ctx: RequestContext): AuditActor {
  return {
    actorId: ctx.userId,
    actorName: ctx.email,
    actorType: 'USER',
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
    tenantId: ctx.tenantId,
  };
}

export const SYSTEM_ACTOR: AuditActor = { actorType: 'SYSTEM', actorId: null, actorName: 'system' };

/**
 * Write an audit entry.
 *
 * Never throws. An audit write failing must not roll back the business action
 * that succeeded — the alternative is that a transient database hiccup on this
 * table blocks invoice submission entirely. Failures are logged loudly so the
 * gap is discoverable.
 */
export async function audit(actor: AuditActor, entry: AuditEntry): Promise<void> {
  try {
    await sql()`
      INSERT INTO audit_trails (
        tenant_id, actor_id, actor_type, actor_name, action,
        resource_type, resource_id, ip_address, user_agent, changes
      ) VALUES (
        ${entry.tenantId ?? actor.tenantId ?? null},
        ${actor.actorId ?? null},
        ${actor.actorType},
        ${actor.actorName ?? null},
        ${entry.action},
        ${entry.resourceType},
        ${entry.resourceId ?? null},
        ${actor.ip ?? null}::inet,
        ${actor.userAgent ?? null},
        ${entry.changes === undefined || entry.changes === null
          ? null
          : jsonb(sql(), entry.changes)}
      )
    `;
  } catch (err) {
    logger.error({ err, entry }, 'failed to write audit entry');
  }
}

/**
 * Reduce a before/after pair to only the fields that actually changed.
 * Keeps the trail readable and avoids storing an entire staged invoice when a
 * user corrected one TRN.
 */
export function diff<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, next] of Object.entries(after)) {
    const prev = before[key];
    if (next !== undefined && JSON.stringify(prev) !== JSON.stringify(next)) {
      changes[key] = { from: prev, to: next };
    }
  }
  return changes;
}
