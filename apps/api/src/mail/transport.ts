import nodemailer, { type Transporter } from 'nodemailer';
import type { Encryption } from './providers.js';

/**
 * SMTP transport construction and error translation.
 *
 * Everything that talks to a mail server goes through here so that the wizard,
 * the "test account settings" button and the background sender all fail in the
 * same words. A mail server's own error text is written for postmasters — the
 * administrator setting this up needs to know whether to fix the password, the
 * hostname, or their provider's policy.
 */

export interface SmtpSettings {
  host: string;
  port: number;
  encryption: Encryption;
  authRequired: boolean;
  username?: string | null;
  password?: string | null;
}

/** Probing several candidates must not leave the wizard hanging for a minute. */
export const PROBE_TIMEOUT_MS = 7_000;
export const SEND_TIMEOUT_MS = 20_000;

export function buildTransport(settings: SmtpSettings, timeoutMs: number): Transporter {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    // `secure` means TLS from the first byte (port 465). STARTTLS begins in the
    // clear and upgrades, and requireTLS makes that upgrade mandatory rather
    // than best-effort — without it a downgrade leaves the password in plain
    // text on the wire.
    secure: settings.encryption === 'SSL',
    requireTLS: settings.encryption === 'STARTTLS',
    ignoreTLS: settings.encryption === 'NONE',
    auth:
      settings.authRequired && settings.username
        ? { user: settings.username, pass: settings.password ?? '' }
        : undefined,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
}

export interface SmtpResult {
  ok: boolean;
  message: string;
  /** Present on failure: lets the portal decide whether to blame the password. */
  reason?: 'AUTH' | 'CONNECTION' | 'HOST' | 'TLS' | 'RECIPIENT' | 'UNKNOWN';
}

/**
 * Open a connection, negotiate TLS and authenticate, then hang up.
 *
 * This is what "Test Account Settings" runs, and what the wizard runs against
 * each candidate. It sends no mail, so it is safe to repeat.
 */
export async function verifySmtp(
  settings: SmtpSettings,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<SmtpResult> {
  const transport = buildTransport(settings, timeoutMs);
  try {
    await transport.verify();
    return { ok: true, message: 'Connected and signed in successfully.' };
  } catch (err) {
    return describeSmtpError(err);
  } finally {
    transport.close();
  }
}

export function describeSmtpError(err: unknown): SmtpResult {
  const error = err as { code?: string; responseCode?: number; response?: string; message?: string };
  const code = error?.code ?? '';
  const detail = (error?.response ?? error?.message ?? '').trim();

  // Truncated because some servers answer a rejected login with a paragraph of
  // policy links, and the whole thing ends up in a UI field.
  const suffix = detail ? ` Server said: ${detail.slice(0, 300)}` : '';

  switch (code) {
    case 'EAUTH':
      return {
        ok: false,
        reason: 'AUTH',
        message: `The mail server refused those credentials. Many providers require an app-specific password rather than the account password.${suffix}`,
      };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return {
        ok: false,
        reason: 'HOST',
        message: `That server name could not be resolved. Check the outgoing server address.${suffix}`,
      };
    case 'ECONNECTION':
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'ESOCKET':
    case 'EDNS':
      return {
        ok: false,
        reason: 'CONNECTION',
        message: `Could not reach that server on this port. Check the port and the encryption setting — 587 is normally STARTTLS and 465 is normally SSL/TLS.${suffix}`,
      };
    case 'EENVELOPE':
      return {
        ok: false,
        reason: 'RECIPIENT',
        message: `The server accepted the connection but rejected the sender or recipient address.${suffix}`,
      };
    default:
      if (/self.signed|certificate|SSL|TLS/i.test(detail)) {
        return {
          ok: false,
          reason: 'TLS',
          message: `The TLS handshake failed. This usually means the encryption setting does not match the port.${suffix}`,
        };
      }
      return {
        ok: false,
        reason: 'UNKNOWN',
        message: detail || 'The mail server could not be contacted.',
      };
  }
}
