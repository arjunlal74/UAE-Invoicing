import { logger } from '../logger.js';
import { accountForDelivery, recordOutcome, sendThrough } from '../mail/service.js';
import type { SendMailJob } from '../queue/queues.js';

/**
 * Deliver one queued message.
 *
 * Throws on failure so BullMQ applies its backoff, but records the outcome
 * first: the delivery log is what the administrator looks at, and it has to
 * show the last real reason rather than nothing until the retries run out.
 */
export async function sendMailJob(data: SendMailJob): Promise<void> {
  const account = await accountForDelivery(data.deliveryId);

  if (!account) {
    const message = 'No outgoing mail account is configured.';
    await recordOutcome(data.deliveryId, { ok: false, message });
    logger.warn({ deliveryId: data.deliveryId }, 'mail job skipped: no account configured');
    // Not retryable by waiting — an administrator has to configure an account,
    // and by then the invitation can be resent from the users screen.
    return;
  }

  const result = await sendThrough(account, data.to, {
    subject: data.subject,
    html: data.html,
    text: data.text,
  });

  await recordOutcome(data.deliveryId, result);
  if (!result.ok) throw new Error(result.message);
}
