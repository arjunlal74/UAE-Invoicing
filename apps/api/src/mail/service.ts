import { withPlatformAccess } from '../db/client.js';
import { decryptSecret } from '../lib/crypto.js';
import { logger } from '../logger.js';
import type { RenderedMail } from './templates.js';
import {
  SEND_TIMEOUT_MS,
  buildTransport,
  describeSmtpError,
  type SmtpSettings,
} from './transport.js';
import type { Encryption } from './providers.js';

/**
 * Reading the configured account, and actually putting a message on the wire.
 *
 * The stored password is decrypted here and nowhere else, and never leaves this
 * module: `toSummary` is what the portal receives, and it has no password field
 * at all rather than a blanked one — a field that is sometimes a secret and
 * sometimes a placeholder is a field that eventually gets logged.
 */

export interface MailAccountRow {
  id: string;
  display_name: string;
  from_address: string;
  reply_to: string | null;
  smtp_host: string;
  smtp_port: number;
  encryption: Encryption;
  auth_required: boolean;
  username: string | null;
  password_cipher: string | null;
  provider_key: string | null;
  is_default: boolean;
  is_active: boolean;
  last_tested_at: Date | null;
  last_test_ok: boolean | null;
  last_test_result: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MailAccountSummary {
  id: string;
  displayName: string;
  fromAddress: string;
  replyTo: string | null;
  host: string;
  port: number;
  encryption: Encryption;
  authRequired: boolean;
  username: string | null;
  hasPassword: boolean;
  providerKey: string | null;
  isDefault: boolean;
  isActive: boolean;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestResult: string | null;
  createdAt: string;
}

export function toSummary(row: MailAccountRow): MailAccountSummary {
  return {
    id: row.id,
    displayName: row.display_name,
    fromAddress: row.from_address,
    replyTo: row.reply_to,
    host: row.smtp_host,
    port: row.smtp_port,
    encryption: row.encryption,
    authRequired: row.auth_required,
    username: row.username,
    hasPassword: Boolean(row.password_cipher),
    providerKey: row.provider_key,
    isDefault: row.is_default,
    isActive: row.is_active,
    lastTestedAt: row.last_tested_at?.toISOString() ?? null,
    lastTestOk: row.last_test_ok,
    lastTestResult: row.last_test_result,
    createdAt: row.created_at.toISOString(),
  };
}

export function settingsFromRow(row: MailAccountRow): SmtpSettings {
  return {
    host: row.smtp_host,
    port: row.smtp_port,
    encryption: row.encryption,
    authRequired: row.auth_required,
    username: row.username,
    password: row.password_cipher ? decryptSecret(row.password_cipher) : null,
  };
}

export async function findAccount(id: string): Promise<MailAccountRow | null> {
  const rows = await withPlatformAccess(
    (tx) => tx<MailAccountRow[]>`SELECT * FROM mail_accounts WHERE id = ${id}`,
  );
  return rows[0] ?? null;
}

export async function listAccounts(): Promise<MailAccountRow[]> {
  return withPlatformAccess(
    (tx) => tx<MailAccountRow[]>`
      SELECT * FROM mail_accounts ORDER BY is_default DESC, created_at
    `,
  );
}

/** The account outbound mail is sent from, or null when none is configured. */
export async function defaultAccount(): Promise<MailAccountRow | null> {
  const rows = await withPlatformAccess(
    (tx) => tx<MailAccountRow[]>`
      SELECT * FROM mail_accounts WHERE is_default AND is_active LIMIT 1
    `,
  );
  return rows[0] ?? null;
}

export async function mailIsConfigured(): Promise<boolean> {
  return (await defaultAccount()) !== null;
}

function fromHeader(row: MailAccountRow): string {
  // Quoted because a display name containing a comma or a full stop otherwise
  // produces a header the receiving server parses as two addresses.
  return `"${row.display_name.replace(/"/g, '')}" <${row.from_address}>`;
}

export interface SendResult {
  ok: boolean;
  message: string;
  messageId?: string;
}

/**
 * Send one message through a specific account, synchronously.
 *
 * Callers that are answering an HTTP request should queue instead — an SMTP
 * conversation can take seconds and a provider outage would otherwise become
 * the portal's outage.
 */
export async function sendThrough(
  row: MailAccountRow,
  to: string,
  message: RenderedMail,
): Promise<SendResult> {
  const transport = buildTransport(settingsFromRow(row), SEND_TIMEOUT_MS);

  try {
    const info = await transport.sendMail({
      from: fromHeader(row),
      replyTo: row.reply_to ?? undefined,
      to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    logger.info({ to, accountId: row.id, messageId: info.messageId }, 'mail sent');
    return { ok: true, message: 'Message accepted by the mail server.', messageId: info.messageId };
  } catch (err) {
    const described = describeSmtpError(err);
    logger.warn({ to, accountId: row.id, reason: described.reason }, 'mail send failed');
    return { ok: false, message: described.message };
  } finally {
    transport.close();
  }
}

// --- Delivery log ------------------------------------------------------------

export type MailKind =
  | 'USER_INVITE'
  | 'TEST'
  | 'PASSWORD_RESET'
  | 'PASSWORD_CHANGED'
  | 'SECURITY_ALERT';

export async function recordQueued(params: {
  kind: MailKind;
  to: string;
  subject: string;
  accountId: string | null;
  userId?: string | null;
  tenantId?: string | null;
}): Promise<string> {
  const rows = await withPlatformAccess(
    (tx) => tx<{ id: string }[]>`
      INSERT INTO mail_deliveries (mail_account_id, kind, to_address, subject, status, user_id, tenant_id)
      VALUES (${params.accountId}, ${params.kind}, ${params.to}, ${params.subject}, 'QUEUED',
              ${params.userId ?? null}, ${params.tenantId ?? null})
      RETURNING id
    `,
  );
  return rows[0]!.id;
}

export async function recordOutcome(
  deliveryId: string,
  result: SendResult,
): Promise<void> {
  await withPlatformAccess(
    (tx) => tx`
      UPDATE mail_deliveries SET
        status     = ${result.ok ? 'SENT' : 'FAILED'},
        error      = ${result.ok ? null : result.message},
        message_id = ${result.messageId ?? null},
        sent_at    = ${result.ok ? new Date() : null}
      WHERE id = ${deliveryId}
    `,
  );
}

export interface MailDeliveryRow {
  id: string;
  kind: string;
  to_address: string;
  subject: string;
  status: string;
  error: string | null;
  created_at: Date;
  sent_at: Date | null;
}

export async function recentDeliveries(limit = 50): Promise<MailDeliveryRow[]> {
  return withPlatformAccess(
    (tx) => tx<MailDeliveryRow[]>`
      SELECT id, kind, to_address, subject, status, error, created_at, sent_at
      FROM mail_deliveries ORDER BY created_at DESC LIMIT ${limit}
    `,
  );
}

/**
 * The account a queued delivery should go out through.
 *
 * Falls back to whatever is default now: an administrator who fixes a broken
 * account by adding a working one should see the retry succeed, not keep
 * failing against the configuration they have already replaced.
 */
export async function accountForDelivery(deliveryId: string): Promise<MailAccountRow | null> {
  const rows = await withPlatformAccess(
    (tx) => tx<{ mail_account_id: string | null }[]>`
      SELECT mail_account_id FROM mail_deliveries WHERE id = ${deliveryId}
    `,
  );

  const accountId = rows[0]?.mail_account_id;
  const account = accountId ? await findAccount(accountId) : null;
  return account?.is_active ? account : defaultAccount();
}
