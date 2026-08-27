import {
  REASON_CODE_LABELS,
  RESPONSE_CODE_LABELS,
  type RejectionReasonCode,
  type ResponseStatusCode,
} from '@uae/contracts';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { MAIL_JOB_OPTIONS, sendMailQueue } from '../queue/queues.js';
import { defaultAccount, recordQueued, type MailKind } from './service.js';
import {
  renderAccountLocked,
  renderActivationDirect,
  renderActivationManaged,
  renderDisputeAlert,
  renderInboundPurchaseInvoice,
  renderPasswordChanged,
  renderPasswordReset,
  renderInventoryBuffer,
  renderQuotaThreshold,
  type RenderedMail,
} from './templates.js';

/**
 * Queue-side entry point for outbound mail.
 *
 * Nothing here throws. Creating an account and telling someone about it are two
 * separate concerns: a mail server that is down must not roll back an account
 * that was created correctly, and it must certainly not prevent a password from
 * being changed. Callers get told whether the message went out and decide what
 * to show.
 */

export interface QueueResult {
  queued: boolean;
  /** Why it was not queued, for the response an administrator sees. */
  reason?: string;
}

async function enqueue(
  kind: MailKind,
  to: string,
  message: RenderedMail,
  refs: { userId?: string | null; tenantId?: string | null } = {},
): Promise<QueueResult> {
  try {
    const account = await defaultAccount();
    if (!account) {
      return {
        queued: false,
        reason: 'No outgoing mail account is configured, so no e-mail was sent.',
      };
    }

    const deliveryId = await recordQueued({
      kind,
      to,
      subject: message.subject,
      accountId: account.id,
      userId: refs.userId ?? null,
      tenantId: refs.tenantId ?? null,
    });

    await sendMailQueue().add(
      kind.toLowerCase(),
      { deliveryId, to, subject: message.subject, html: message.html, text: message.text },
      MAIL_JOB_OPTIONS,
    );

    return { queued: true };
  } catch (err) {
    logger.error({ err, to, kind }, 'could not queue outbound mail');
    return { queued: false, reason: 'The e-mail could not be queued.' };
  }
}

/**
 * Template A or B, chosen by who provisioned the account.
 *
 * A managed sub-tenant was set up by its accountant, not by us, so it gets the
 * partner's name and the partner's contact address. Sending the direct template
 * would point a client at a support desk that has never heard of them.
 */
export async function queueActivation(params: {
  to: string;
  contactName: string;
  companyName: string;
  activationUrl: string;
  /** Present only for a managed sub-tenant. */
  partner?: { name: string; contactEmail: string | null } | null;
  userId?: string | null;
  tenantId?: string | null;
}): Promise<QueueResult> {
  const message = params.partner
    ? renderActivationManaged({
        contactName: params.contactName,
        companyName: params.companyName,
        partnerName: params.partner.name,
        partnerContactEmail: params.partner.contactEmail,
        activationUrl: params.activationUrl,
      })
    : renderActivationDirect({
        contactName: params.contactName,
        companyName: params.companyName,
        activationUrl: params.activationUrl,
      });

  return enqueue('USER_INVITE', params.to, message, {
    userId: params.userId,
    tenantId: params.tenantId,
  });
}

/** Template C. */
export async function queuePasswordReset(params: {
  to: string;
  contactName: string;
  companyName: string | null;
  resetUrl: string;
  userId?: string | null;
  tenantId?: string | null;
}): Promise<QueueResult> {
  return enqueue(
    'PASSWORD_RESET',
    params.to,
    renderPasswordReset({
      contactName: params.contactName,
      companyName: params.companyName,
      resetUrl: params.resetUrl,
    }),
    { userId: params.userId, tenantId: params.tenantId },
  );
}

/** Template D. */
export async function queuePasswordChanged(params: {
  to: string;
  contactName: string;
  companyName: string | null;
  changedAt: Date;
  ip: string | null;
  userId?: string | null;
  tenantId?: string | null;
}): Promise<QueueResult> {
  return enqueue(
    'PASSWORD_CHANGED',
    params.to,
    renderPasswordChanged({
      contactName: params.contactName,
      companyName: params.companyName,
      changedAt: params.changedAt,
      ip: params.ip,
    }),
    { userId: params.userId, tenantId: params.tenantId },
  );
}

/**
 * Template E — a buyer disputed one of our cleared sales invoices (§5.5).
 *
 * The link goes straight to the credit note builder with the invoice already
 * named, which is §8.2's "1-Click Launch from Dispute Alerts": the recipient
 * arrives at a form that is already populated rather than at a search box.
 */
export async function queueDisputeAlert(params: {
  to: string;
  contactName: string;
  invoiceId: string;
  invoiceNumber: string;
  buyerName: string;
  ftaIrn: string | null;
  responseCode: ResponseStatusCode;
  reasonCode: RejectionReasonCode | null;
  comments: string | null;
  userId?: string | null;
  tenantId?: string | null;
}): Promise<QueueResult> {
  return enqueue(
    'DISPUTE_ALERT',
    params.to,
    renderDisputeAlert({
      invoiceNumber: params.invoiceNumber,
      buyerName: params.buyerName,
      ftaIrn: params.ftaIrn,
      responseStatus: `${params.responseCode} — ${RESPONSE_CODE_LABELS[params.responseCode]}`,
      reasonCode: params.reasonCode,
      reasonLabel: params.reasonCode ? REASON_CODE_LABELS[params.reasonCode] : null,
      comments: params.comments,
      creditNoteUrl: `${config().PORTAL_ORIGIN}/ar/credit-notes/new?invoiceId=${params.invoiceId}`,
    }),
    { userId: params.userId, tenantId: params.tenantId },
  );
}

/** Template F — a supplier's invoice arrived in the AP desk (§5.6). */
export async function queueInboundPurchaseInvoice(params: {
  to: string;
  invoiceId: string;
  invoiceNumber: string;
  supplierName: string;
  supplierTrn: string | null;
  ftaIrn: string | null;
  totalAmount: string;
  vatAmount: string;
  currency: string;
  isNewSupplier: boolean;
  userId?: string | null;
  tenantId?: string | null;
}): Promise<QueueResult> {
  return enqueue(
    'INBOUND_INVOICE',
    params.to,
    renderInboundPurchaseInvoice({
      supplierName: params.supplierName,
      supplierTrn: params.supplierTrn,
      invoiceNumber: params.invoiceNumber,
      ftaIrn: params.ftaIrn,
      totalAmount: params.totalAmount,
      vatAmount: params.vatAmount,
      currency: params.currency,
      isNewSupplier: params.isNewSupplier,
      deskUrl: `${config().PORTAL_ORIGIN}/ap/inbox/${params.invoiceId}`,
    }),
    { userId: params.userId, tenantId: params.tenantId },
  );
}

/** §15 — the 80/90/100% bundle threshold alert. */
export async function queueQuotaThreshold(params: {
  to: string;
  contactName: string;
  companyName: string;
  threshold: number;
  purchasedUnits: number;
  consumedUnits: number;
  remainingUnits: number;
  hardCap: boolean;
  userId?: string | null;
  tenantId?: string | null;
}): Promise<QueueResult> {
  return enqueue(
    'QUOTA_ALERT',
    params.to,
    renderQuotaThreshold({
      contactName: params.contactName,
      companyName: params.companyName,
      threshold: params.threshold,
      purchasedUnits: params.purchasedUnits,
      consumedUnits: params.consumedUnits,
      remainingUnits: params.remainingUnits,
      hardCap: params.hardCap,
      balanceUrl: `${config().PORTAL_ORIGIN}/settings/usage`,
    }),
    { userId: params.userId, tenantId: params.tenantId },
  );
}

/**
 * Template G — the §15.5 minimum buffer alert.
 *
 * Reuses the QUOTA_ALERT purpose rather than adding one: to a mail server and
 * to the delivery log these are the same kind of message about the same
 * subject, and splitting them would only fragment the reporting.
 */
export async function queueInventoryBuffer(params: {
  to: string;
  contactName: string;
  accountName: string;
  tierLabel: string;
  thresholdUnits: number;
  remainingUnits: number;
  dailyRunRate: number;
  critical: boolean;
  /** Where the recipient can actually do something about it. */
  consolePath: string;
  userId?: string | null;
  tenantId?: string | null;
}): Promise<QueueResult> {
  return enqueue(
    'QUOTA_ALERT',
    params.to,
    renderInventoryBuffer({
      contactName: params.contactName,
      accountName: params.accountName,
      tierLabel: params.tierLabel,
      thresholdUnits: params.thresholdUnits,
      remainingUnits: params.remainingUnits,
      dailyRunRate: params.dailyRunRate,
      critical: params.critical,
      consoleUrl: `${config().PORTAL_ORIGIN}${params.consolePath}`,
    }),
    { userId: params.userId, tenantId: params.tenantId },
  );
}

/** Account lockout alert (§4.4 step 2). */
export async function queueAccountLocked(params: {
  to: string;
  contactName: string;
  lockMinutes: number;
  ip: string | null;
  resetUrl: string;
  userId?: string | null;
  tenantId?: string | null;
}): Promise<QueueResult> {
  return enqueue(
    'SECURITY_ALERT',
    params.to,
    renderAccountLocked({
      contactName: params.contactName,
      lockMinutes: params.lockMinutes,
      ip: params.ip,
      resetUrl: params.resetUrl,
    }),
    { userId: params.userId, tenantId: params.tenantId },
  );
}
