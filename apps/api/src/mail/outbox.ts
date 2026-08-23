import { ROLE_LABELS, type Role } from '@uae/contracts';
import { INVITE_TTL_DAYS } from '../auth/service.js';
import { logger } from '../logger.js';
import { MAIL_JOB_OPTIONS, sendMailQueue } from '../queue/queues.js';
import { defaultAccount, recordQueued } from './service.js';
import { renderInvite } from './templates.js';

/**
 * Queue-side entry point for outbound mail.
 *
 * Nothing here throws. Creating a user and telling them about it are two
 * separate concerns, and a mail server that is down must not roll back an
 * account that was created correctly — the caller still gets the invitation
 * link back and can pass it on by hand, exactly as before this existed.
 */

export interface QueueResult {
  queued: boolean;
  /** Why it was not queued, for the response the administrator sees. */
  reason?: string;
}

export async function queueInvitation(params: {
  to: string;
  fullName: string;
  role: Role;
  inviteUrl: string;
  organisation?: string | null;
  userId?: string | null;
  tenantId?: string | null;
}): Promise<QueueResult> {
  try {
    const account = await defaultAccount();
    if (!account) {
      return {
        queued: false,
        reason: 'No outgoing mail account is configured, so the link was not e-mailed.',
      };
    }

    const message = renderInvite({
      fullName: params.fullName,
      inviteUrl: params.inviteUrl,
      organisation: params.organisation ?? null,
      roleLabel: ROLE_LABELS[params.role],
      expiresInDays: INVITE_TTL_DAYS,
    });

    const deliveryId = await recordQueued({
      kind: 'USER_INVITE',
      to: params.to,
      subject: message.subject,
      accountId: account.id,
      userId: params.userId ?? null,
      tenantId: params.tenantId ?? null,
    });

    await sendMailQueue().add(
      'invite',
      { deliveryId, to: params.to, subject: message.subject, html: message.html, text: message.text },
      MAIL_JOB_OPTIONS,
    );

    return { queued: true };
  } catch (err) {
    logger.error({ err, to: params.to }, 'could not queue invitation e-mail');
    return { queued: false, reason: 'The invitation e-mail could not be queued.' };
  }
}
