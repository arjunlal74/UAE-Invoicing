import * as argon2 from 'argon2';
import { sql, type Sql, type Tx } from '../db/client.js';
import { generateToken, sha256Hex } from '../lib/crypto.js';

/**
 * Credential lifecycle primitives — SRS v2.3 §3.2 and §4.
 *
 * The numbers below are the specification's, gathered here rather than spread
 * across the call sites, because they are the part most likely to be argued
 * over and changed.
 */

/** §3.2: every activation vector expires in 24 hours, whatever its purpose. */
export const TOKEN_TTL_HOURS = 24;

/** §4.4: five failures inside a fifteen-minute window locks for thirty. */
export const MAX_FAILED_LOGINS = 5;
export const FAILURE_WINDOW_MINUTES = 15;
export const LOCKOUT_MINUTES = 30;

/** §4.2: a new password may not repeat any of the last three. */
export const PASSWORD_HISTORY_DEPTH = 3;

/** §4.1: at most three reset requests per hour, counted per address and per IP. */
export const RESET_REQUESTS_PER_HOUR = 3;

export type TokenType = 'ACTIVATION_INVITE' | 'PASSWORD_RESET' | 'MFA_CHALLENGE';

export interface IssuedToken {
  /** The value that goes in the e-mail. Never stored. */
  token: string;
  expiresAt: Date;
}

/**
 * Mint a token of a given purpose, invalidating any it supersedes.
 *
 * §4.1 requires previous unexpired reset tokens to die the moment a new one is
 * requested: otherwise every "I didn't get the email" retry leaves another
 * working link alive in an inbox for a day.
 */
export async function issueAuthToken(
  userId: string,
  type: TokenType,
  options: { ip?: string | null; client?: Sql | Tx } = {},
): Promise<IssuedToken> {
  const client = options.client ?? sql();
  const { token, hash } = generateToken(32);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60_000);

  await client`
    UPDATE auth_tokens SET is_used = TRUE, used_at = CURRENT_TIMESTAMP
    WHERE user_id = ${userId} AND token_type = ${type}::token_type
      AND NOT is_used AND expires_at > CURRENT_TIMESTAMP
  `;

  await client`
    INSERT INTO auth_tokens (user_id, token_hash, token_type, expires_at, requested_ip)
    VALUES (${userId}, ${hash}, ${type}::token_type, ${expiresAt}, ${options.ip ?? null}::inet)
  `;

  return { token, expiresAt };
}

export interface RedeemedToken {
  id: string;
  userId: string;
}

export type RedeemFailure = 'NOT_FOUND' | 'USED' | 'EXPIRED';

/**
 * Look a token up without consuming it.
 *
 * Separate from spending it so the reset screen can say "this link has expired"
 * before asking someone to type a new password twice.
 */
export async function inspectAuthToken(
  token: string,
  type: TokenType,
  client: Sql | Tx = sql(),
): Promise<{ ok: true; row: RedeemedToken & { email: string } } | { ok: false; reason: RedeemFailure }> {
  const rows = await client<
    { id: string; user_id: string; email: string; is_used: boolean; expires_at: Date }[]
  >`
    SELECT t.id, t.user_id, u.email, t.is_used, t.expires_at
    FROM auth_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ${sha256Hex(token)} AND t.token_type = ${type}::token_type
  `;

  const row = rows[0];
  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  if (row.is_used) return { ok: false, reason: 'USED' };
  if (row.expires_at <= new Date()) return { ok: false, reason: 'EXPIRED' };

  return { ok: true, row: { id: row.id, userId: row.user_id, email: row.email } };
}

/** Mark a token spent. Call inside the same transaction as the state change. */
export async function consumeAuthToken(id: string, client: Sql | Tx = sql()): Promise<void> {
  await client`
    UPDATE auth_tokens SET is_used = TRUE, used_at = CURRENT_TIMESTAMP WHERE id = ${id}
  `;
}

/** Human wording for a link that cannot be used, shared by every redemption path. */
export const REDEEM_MESSAGES: Record<RedeemFailure, string> = {
  NOT_FOUND: 'This link is not valid. Request a new one.',
  USED: 'This link has already been used. Request a new one if you still need it.',
  EXPIRED: `This link has expired — they are valid for ${TOKEN_TTL_HOURS} hours. Request a new one.`,
};

// --- Password history (§4.2) -------------------------------------------------

/**
 * Whether a candidate matches any remembered hash.
 *
 * Verifying against three Argon2 hashes costs three full derivations, which is
 * the point: this runs only when someone sets a password, never on the login
 * path, so the cost is paid once and buys the guarantee.
 */
export async function reusesRecentPassword(
  candidate: string,
  history: string[],
): Promise<boolean> {
  for (const previous of history.slice(0, PASSWORD_HISTORY_DEPTH)) {
    try {
      if (await argon2.verify(previous, candidate)) return true;
    } catch {
      // A malformed entry is not a match, and must not stop the check.
    }
  }
  return false;
}

/** Newest first, capped, so the column cannot grow without bound. */
export function pushPasswordHistory(history: string[], hash: string): string[] {
  return [hash, ...history].slice(0, PASSWORD_HISTORY_DEPTH);
}
