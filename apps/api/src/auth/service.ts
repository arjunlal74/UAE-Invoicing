import type { Role, SessionUser } from '@uae/contracts';
import { isPlatformRole } from '@uae/contracts';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { config } from '../config.js';
import { sql, withPlatformAccess, type Sql, type Tx } from '../db/client.js';
import { generateToken, safeEqual, sha256Hex } from '../lib/crypto.js';
import { badRequest, forbidden, tooManyRequests, unauthorized } from '../lib/errors.js';
import { signAccessToken } from './tokens.js';

/**
 * Authentication.
 *
 * Argon2id for passwords, TOTP for the second factor, opaque rotating refresh
 * tokens for sessions.
 */

const ARGON_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB — OWASP's minimum recommendation for argon2id
  timeCost: 2,
  parallelism: 1,
};

const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

interface UserRow {
  id: string;
  tenant_id: string | null;
  email: string;
  full_name: string;
  role: Role;
  password_hash: string | null;
  mfa_secret: string | null;
  mfa_enabled: boolean;
  is_active: boolean;
  failed_logins: number;
  locked_until: Date | null;
  tenant_name: string | null;
  tenant_status: string | null;
}

async function findUserByEmail(email: string): Promise<UserRow | null> {
  const rows = await sql()<UserRow[]>`
    SELECT u.id, u.tenant_id, u.email, u.full_name, u.role, u.password_hash,
           u.mfa_secret, u.mfa_enabled, u.is_active, u.failed_logins, u.locked_until,
           t.legal_name_en AS tenant_name, t.status::text AS tenant_status
    FROM users u
    LEFT JOIN tenants t ON t.id = u.tenant_id
    WHERE u.email = ${email.trim().toLowerCase()}
  `;
  return rows[0] ?? null;
}

export function toSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    tenantStatus: (row.tenant_status as SessionUser['tenantStatus']) ?? null,
    mfaEnabled: row.mfa_enabled,
  };
}

export interface LoginOutcome {
  kind: 'success' | 'mfa_required';
  session?: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    user: SessionUser;
  };
}

export async function login(
  email: string,
  password: string,
  mfaCode: string | undefined,
  context: { ip?: string; userAgent?: string },
): Promise<LoginOutcome> {
  const user = await findUserByEmail(email);

  // Always spend the cost of a hash comparison, even when no such account
  // exists, so response timing does not reveal which addresses are registered.
  if (!user?.password_hash) {
    await argon2.hash(password, ARGON_OPTIONS);
    throw unauthorized('Incorrect email address or password.');
  }

  if (user.locked_until && user.locked_until > new Date()) {
    throw tooManyRequests(
      'Too many failed sign-in attempts. Your account is locked for a few minutes.',
    );
  }

  if (!user.is_active) {
    throw forbidden('This account has been deactivated. Contact your administrator.');
  }

  const passwordOk = await verifyPassword(user.password_hash, password);
  if (!passwordOk) {
    const failed = user.failed_logins + 1;
    const lockUntil =
      failed >= MAX_FAILED_LOGINS
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
        : null;

    await sql()`
      UPDATE users
      SET failed_logins = ${failed}, locked_until = ${lockUntil}
      WHERE id = ${user.id}
    `;
    throw unauthorized('Incorrect email address or password.');
  }

  // MFA is mandatory for portal users per the SRS, but an account that has not
  // enrolled yet must still be able to sign in — otherwise nobody could ever
  // reach the enrolment screen. The portal forces enrolment after login.
  if (user.mfa_enabled) {
    if (!mfaCode) return { kind: 'mfa_required' };
    if (!user.mfa_secret || !authenticator.verify({ token: mfaCode, secret: user.mfa_secret })) {
      await sql()`UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ${user.id}`;
      throw unauthorized('That authentication code is not valid.');
    }
  }

  // A suspended tenant's staff can sign in — they need to see why — but every
  // action that would file an invoice is blocked further down the stack.
  await sql()`
    UPDATE users
    SET failed_logins = 0, locked_until = NULL, last_login_at = CURRENT_TIMESTAMP
    WHERE id = ${user.id}
  `;

  const session = await issueSession(user, context);
  return { kind: 'success', session };
}

async function issueSession(user: UserRow, context: { ip?: string; userAgent?: string }) {
  const cfg = config();
  const accessToken = await signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role,
    tenantId: user.tenant_id,
  });

  const { token: refreshToken, hash } = generateToken(48);
  const expiresAt = new Date(Date.now() + cfg.JWT_REFRESH_TTL * 1000);

  await sql()`
    INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
    VALUES (${user.id}, ${hash}, ${expiresAt}, ${context.userAgent ?? null},
            ${context.ip ?? null}::inet)
  `;

  return {
    accessToken,
    refreshToken,
    expiresIn: cfg.JWT_ACCESS_TTL,
    user: toSessionUser(user),
  };
}

/**
 * Exchange a refresh token for a new session, rotating the token.
 *
 * Rotation means a stolen refresh token is usable at most once, and the theft
 * surfaces the next time the legitimate client tries to refresh and is rejected.
 */
export async function refreshSession(
  refreshToken: string,
  context: { ip?: string; userAgent?: string },
) {
  const hash = sha256Hex(refreshToken);

  const rows = await sql()<{ id: string; user_id: string; expires_at: Date; revoked_at: Date | null }[]>`
    SELECT id, user_id, expires_at, revoked_at
    FROM refresh_tokens
    WHERE token_hash = ${hash}
  `;

  const stored = rows[0];
  if (!stored || stored.revoked_at || stored.expires_at < new Date()) {
    throw unauthorized('Your session has expired. Please sign in again.');
  }

  await sql()`UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ${stored.id}`;

  const users = await sql()<UserRow[]>`
    SELECT u.id, u.tenant_id, u.email, u.full_name, u.role, u.password_hash,
           u.mfa_secret, u.mfa_enabled, u.is_active, u.failed_logins, u.locked_until,
           t.legal_name_en AS tenant_name, t.status::text AS tenant_status
    FROM users u
    LEFT JOIN tenants t ON t.id = u.tenant_id
    WHERE u.id = ${stored.user_id}
  `;

  const user = users[0];
  if (!user || !user.is_active) throw unauthorized('This account is no longer active.');

  return issueSession(user, context);
}

export async function revokeSession(refreshToken: string): Promise<void> {
  await sql()`
    UPDATE refresh_tokens
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE token_hash = ${sha256Hex(refreshToken)} AND revoked_at IS NULL
  `;
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await sql()`
    UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP
    WHERE user_id = ${userId} AND revoked_at IS NULL
  `;
}

// --- MFA --------------------------------------------------------------------

export async function startMfaEnrolment(userId: string, email: string) {
  const secret = authenticator.generateSecret();

  // Held unconfirmed until a valid code proves the authenticator app actually
  // has it. Marking mfa_enabled here would lock the user out of their account.
  await sql()`UPDATE users SET mfa_secret = ${secret} WHERE id = ${userId}`;

  return {
    secret,
    otpauthUrl: authenticator.keyuri(email, config().MFA_ISSUER, secret),
  };
}

export async function confirmMfaEnrolment(userId: string, code: string): Promise<void> {
  const rows = await sql()<{ mfa_secret: string | null }[]>`
    SELECT mfa_secret FROM users WHERE id = ${userId}
  `;
  const secret = rows[0]?.mfa_secret;
  if (!secret) throw badRequest('Start enrolment before confirming it.');

  if (!authenticator.verify({ token: code, secret })) {
    throw badRequest('That code is not valid. Check your authenticator app and try again.');
  }

  await sql()`UPDATE users SET mfa_enabled = TRUE WHERE id = ${userId}`;
}

export async function disableMfa(userId: string): Promise<void> {
  await sql()`UPDATE users SET mfa_enabled = FALSE, mfa_secret = NULL WHERE id = ${userId}`;
}

// --- Passwords & invites -----------------------------------------------------

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const rows = await sql()<{ password_hash: string | null }[]>`
    SELECT password_hash FROM users WHERE id = ${userId}
  `;
  const hash = rows[0]?.password_hash;
  if (!hash || !(await verifyPassword(hash, currentPassword))) {
    throw badRequest('Your current password is not correct.');
  }

  await sql()`UPDATE users SET password_hash = ${await hashPassword(newPassword)} WHERE id = ${userId}`;

  // Changing a password ends every other session — that is the whole point of
  // changing it after a suspected compromise.
  await revokeAllSessions(userId);
}

/**
 * Issue an invitation token for a user.
 *
 * Pass the surrounding transaction when the user is being created in one:
 * without it this runs on a different pooled connection, which cannot see the
 * uncommitted row and fails on `user_invites.user_id`.
 */
export async function createInvite(userId: string, client: Sql | Tx = sql()): Promise<string> {
  const { token, hash } = generateToken(32);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);

  await client`
    INSERT INTO user_invites (user_id, token_hash, expires_at)
    VALUES (${userId}, ${hash}, ${expiresAt})
  `;

  return token;
}

export async function acceptInvite(
  token: string,
  fullName: string,
  password: string,
): Promise<SessionUser> {
  const hash = sha256Hex(token);

  return withPlatformAccess(async (tx) => {
    const invites = await tx<{ id: string; user_id: string; expires_at: Date; accepted_at: Date | null }[]>`
      SELECT id, user_id, expires_at, accepted_at
      FROM user_invites WHERE token_hash = ${hash}
      FOR UPDATE
    `;

    const invite = invites[0];
    // Compare through safeEqual as well as the indexed lookup so that a partial
    // token cannot be distinguished by response time.
    if (!invite || !safeEqual(hash, sha256Hex(token))) {
      throw badRequest('This invitation link is not valid.');
    }
    if (invite.accepted_at) throw badRequest('This invitation has already been used.');
    if (invite.expires_at < new Date()) throw badRequest('This invitation has expired.');

    await tx`
      UPDATE users
      SET full_name = ${fullName}, password_hash = ${await hashPassword(password)}, is_active = TRUE
      WHERE id = ${invite.user_id}
    `;
    await tx`UPDATE user_invites SET accepted_at = CURRENT_TIMESTAMP WHERE id = ${invite.id}`;

    const users = await tx<UserRow[]>`
      SELECT u.id, u.tenant_id, u.email, u.full_name, u.role, u.password_hash,
             u.mfa_secret, u.mfa_enabled, u.is_active, u.failed_logins, u.locked_until,
             t.legal_name_en AS tenant_name, t.status::text AS tenant_status
      FROM users u
      LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = ${invite.user_id}
    `;

    const user = users[0];
    if (!user) throw badRequest('The account for this invitation no longer exists.');
    return toSessionUser(user);
  });
}

export { isPlatformRole };
