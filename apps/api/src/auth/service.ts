import type { Role, SessionUser } from '@uae/contracts';
import { isPlatformRole } from '@uae/contracts';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { config } from '../config.js';
import { jsonb, sql, withPlatformAccess, type Sql, type Tx } from '../db/client.js';
import { generateToken, sha256Hex } from '../lib/crypto.js';
import { badRequest, forbidden, tooManyRequests, unauthorized } from '../lib/errors.js';
import { logger } from '../logger.js';
import {
  queueAccountLocked,
  queuePasswordChanged,
  queuePasswordReset,
} from '../mail/outbox.js';
import { consumeRateLimit } from './rateLimit.js';
import {
  FAILURE_WINDOW_MINUTES,
  LOCKOUT_MINUTES,
  MAX_FAILED_LOGINS,
  PASSWORD_HISTORY_DEPTH,
  RESET_REQUESTS_PER_HOUR,
  consumeAuthToken,
  inspectAuthToken,
  issueAuthToken,
  pushPasswordHistory,
  reusesRecentPassword,
  REDEEM_MESSAGES,
} from './credentials.js';
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
  is_locked: boolean;
  last_failed_login_at: Date | null;
  must_rotate_password: boolean;
  tenant_name: string | null;
  tenant_status: string | null;
}

/**
 * The columns every session-building query needs.
 *
 * Written once because there are three of them — sign-in, refresh and invite
 * acceptance — and a column added to one but not the others produces a session
 * that behaves differently depending on how it was created.
 */
export const SESSION_USER_COLUMNS = `
  u.id, u.tenant_id, u.email, u.full_name, u.role, u.password_hash,
  u.mfa_secret, u.mfa_enabled, u.is_active, u.failed_logins, u.locked_until,
  u.is_locked, u.last_failed_login_at, u.must_rotate_password,
  t.legal_name_en AS tenant_name, t.status::text AS tenant_status
`;

async function findUserByEmail(email: string): Promise<UserRow | null> {
  const rows = await sql().unsafe<UserRow[]>(
    `SELECT ${SESSION_USER_COLUMNS}
     FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.email = $1`,
    [email.trim().toLowerCase()],
  );
  return rows[0] ?? null;
}

/**
 * A channel partner's staff member working inside a custody client (SRS §3).
 *
 * Everything in here is read from the database at the moment the session is
 * opened — the client, the live grant, the partner it hangs off — so a session
 * can never be built from a tenant id and a role the caller supplied.
 */
export interface CustodyScope {
  /** The client whose books are being worked in. Becomes the session's tenant. */
  tenantId: string;
  tenantName: string;
  tenantStatus: string | null;
  /** The authority the grant carries inside that client, not the person's own. */
  role: Role;
  /** The partner they belong to, which is where "leave" takes them back to. */
  partnerTenantId: string;
  partnerName: string;
}

export function toSessionUser(row: UserRow, custody?: CustodyScope): SessionUser {
  // A custody session is presented as what it is: the tenant is the client, so
  // every screen and every query scopes to the books being worked in, and the
  // partner is named separately rather than substituted. Showing the partner as
  // the tenant would put the wrong company's name above somebody else's
  // invoices, which is the one mistake this feature must not make.
  if (custody) {
    return {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      role: custody.role,
      tenantId: custody.tenantId,
      tenantName: custody.tenantName,
      tenantStatus: (custody.tenantStatus as SessionUser['tenantStatus']) ?? null,
      mfaEnabled: row.mfa_enabled,
      mustRotatePassword: row.must_rotate_password,
      actingFor: {
        partnerTenantId: custody.partnerTenantId,
        partnerName: custody.partnerName,
        homeRole: row.role,
      },
    };
  }

  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    tenantStatus: (row.tenant_status as SessionUser['tenantStatus']) ?? null,
    mfaEnabled: row.mfa_enabled,
    mustRotatePassword: row.must_rotate_password,
    actingFor: null,
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
    const minutes = Math.max(1, Math.ceil((user.locked_until.getTime() - Date.now()) / 60_000));
    throw tooManyRequests(
      `Too many failed sign-in attempts. This account is locked for another ${minutes} minute${minutes === 1 ? '' : 's'}. You can unlock it immediately by resetting your password.`,
    );
  }

  // The lock has aged out. Clearing it here rather than waiting for a
  // successful sign-in means the flag an administrator sees is the truth.
  if (user.is_locked) {
    await sql()`
      UPDATE users SET is_locked = FALSE, locked_until = NULL, failed_logins = 0
      WHERE id = ${user.id}
    `;
    user.is_locked = false;
    user.failed_logins = 0;
  }

  if (!user.is_active) {
    throw forbidden('This account has been deactivated. Contact your administrator.');
  }

  const passwordOk = await verifyPassword(user.password_hash, password);
  if (!passwordOk) {
    // §4.4 counts failures "within a 15-minute window". Without this reset the
    // counter would accumulate across months and lock out someone who mistypes
    // their password once every few weeks.
    const windowStart = Date.now() - FAILURE_WINDOW_MINUTES * 60_000;
    const withinWindow =
      user.last_failed_login_at !== null && user.last_failed_login_at.getTime() >= windowStart;

    const failed = (withinWindow ? user.failed_logins : 0) + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    const lockUntil = lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null;

    await sql()`
      UPDATE users SET
        failed_logins = ${failed},
        last_failed_login_at = CURRENT_TIMESTAMP,
        is_locked = ${lock},
        locked_until = ${lockUntil}
      WHERE id = ${user.id}
    `;

    if (lock) {
      // §4.4 step 2: tell the account holder, since a burst of failures they
      // did not cause is the only warning they get that someone is trying.
      await notifyAccountLocked(user, context.ip ?? null);
      throw tooManyRequests(
        `Too many failed sign-in attempts. This account is locked for ${LOCKOUT_MINUTES} minutes. You can unlock it immediately by resetting your password.`,
      );
    }

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
    UPDATE users SET
      failed_logins = 0, locked_until = NULL, is_locked = FALSE,
      last_failed_login_at = NULL, last_login_at = CURRENT_TIMESTAMP
    WHERE id = ${user.id}
  `;

  const session = await issueSession(user, context);
  return { kind: 'success', session };
}

async function issueSession(
  user: UserRow,
  context: { ip?: string; userAgent?: string },
  custody?: CustodyScope,
) {
  const cfg = config();
  const accessToken = await signAccessToken({
    sub: user.id,
    email: user.email,
    role: custody?.role ?? user.role,
    tenantId: custody?.tenantId ?? user.tenant_id,
    mustRotatePassword: user.must_rotate_password,
    actingForTenantId: custody?.partnerTenantId ?? null,
  });

  const { token: refreshToken, hash } = generateToken(48);
  const expiresAt = new Date(Date.now() + cfg.JWT_REFRESH_TTL * 1000);

  // The acting tenant is recorded on the refresh row, not only in the access
  // token: without it the fifteen-minute expiry would hand back a partner
  // session while the user was still apparently inside a client's books.
  await sql()`
    INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address,
                                acting_tenant_id)
    VALUES (${user.id}, ${hash}, ${expiresAt}, ${context.userAgent ?? null},
            ${context.ip ?? null}::inet, ${custody?.tenantId ?? null})
  `;

  return {
    accessToken,
    refreshToken,
    expiresIn: cfg.JWT_ACCESS_TTL,
    user: toSessionUser(user, custody),
  };
}

/**
 * Open a custody session. The caller has already established the grant.
 *
 * Exported rather than inlined in the route so that the one place that mints
 * tokens stays the one place that mints tokens.
 */
export async function issueCustodySession(
  userId: string,
  custody: CustodyScope,
  context: { ip?: string; userAgent?: string },
) {
  const user = await findUserById(userId);
  if (!user || !user.is_active) throw unauthorized('This account is no longer active.');
  return issueSession(user, context, custody);
}

/**
 * The custody scope still standing behind a session, or null if there is none
 * left and the user should fall back to their own.
 *
 * Re-read on every refresh and every identity check rather than trusted from
 * the stored id: an authorisation withdrawn while somebody is working must stop
 * working, and the longest they should keep it is the life of one access token.
 * A revoked grant quietly returns them to their own session — they are still
 * legitimately signed in as themselves, and dropping them at the login screen
 * would be a harsher answer than the situation calls for.
 */
export async function liveCustodyScope(
  userId: string,
  actingTenantId: string,
): Promise<CustodyScope | null> {
  // Platform access, not a bare connection: `partner_custody_grants` is scoped
  // by row-level security to the client it concerns, and this question is asked
  // before any tenant has been established for the request — which is the whole
  // point of asking it. On a bare connection the policy sees no current tenant,
  // returns nothing, and the session quietly reverts to the partner's own.
  const rows = await withPlatformAccess(
    (tx) => tx<
      {
        role: Role;
        tenant_name: string;
        tenant_status: string;
        partner_tenant_id: string;
        partner_name: string;
      }[]
    >`
      SELECT g.role, c.legal_name_en AS tenant_name, c.status::text AS tenant_status,
             p.id AS partner_tenant_id, p.legal_name_en AS partner_name
      FROM partner_custody_grants g
      JOIN tenants c ON c.id = g.tenant_id
      JOIN tenants p ON p.id = c.parent_tenant_id
      WHERE g.tenant_id = ${actingTenantId}
        AND g.user_id = ${userId}
        AND g.revoked_at IS NULL
        AND c.provisioning_mode = 'FULLY_MANAGED_CUSTODY'
    `,
  );

  const row = rows[0];
  if (!row) {
    logger.info(
      { userId, actingTenantId },
      'custody session refreshed after the grant ended; returning the home session',
    );
    return null;
  }

  return {
    tenantId: actingTenantId,
    tenantName: row.tenant_name,
    tenantStatus: row.tenant_status,
    role: row.role,
    partnerTenantId: row.partner_tenant_id,
    partnerName: row.partner_name,
  };
}

async function findUserById(userId: string): Promise<UserRow | null> {
  const rows = await sql().unsafe<UserRow[]>(
    `SELECT ${SESSION_USER_COLUMNS}
     FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = $1`,
    [userId],
  );
  return rows[0] ?? null;
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

  const rows = await sql()<
    {
      id: string;
      user_id: string;
      expires_at: Date;
      revoked_at: Date | null;
      acting_tenant_id: string | null;
    }[]
  >`
    SELECT id, user_id, expires_at, revoked_at, acting_tenant_id
    FROM refresh_tokens
    WHERE token_hash = ${hash}
  `;

  const stored = rows[0];
  if (!stored || stored.revoked_at || stored.expires_at < new Date()) {
    throw unauthorized('Your session has expired. Please sign in again.');
  }

  await sql()`UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ${stored.id}`;

  const user = await findUserById(stored.user_id);
  if (!user || !user.is_active) throw unauthorized('This account is no longer active.');

  // A custody session refreshes as a custody session, provided the grant is
  // still live — see liveCustodyScope.
  const custody = stored.acting_tenant_id
    ? await liveCustodyScope(stored.user_id, stored.acting_tenant_id)
    : null;

  return issueSession(user, context, custody ?? undefined);
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


// --- Passwords, recovery & invitations (SRS v2.3 §4) -------------------------

interface ContactRow {
  id: string;
  email: string;
  full_name: string;
  tenant_id: string | null;
  tenant_name: string | null;
  password_hash: string | null;
  password_history: string[];
  is_active: boolean;
}

const CONTACT_COLUMNS = `
  u.id, u.email, u.full_name, u.tenant_id, u.password_hash, u.password_history, u.is_active,
  t.legal_name_en AS tenant_name
`;

async function loadContact(userId: string): Promise<ContactRow | null> {
  const rows = await sql().unsafe<ContactRow[]>(
    `SELECT ${CONTACT_COLUMNS} FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

export function activationUrlFor(token: string): string {
  return `${config().PORTAL_ORIGIN}/accept-invite?token=${token}`;
}

export function resetUrlFor(token: string): string {
  return `${config().PORTAL_ORIGIN}/reset-password?token=${token}`;
}

/**
 * §4.4 step 2 — tell the account holder their account was locked.
 *
 * Carries a reset link because §4.4 step 3 makes password reset the immediate
 * way out of a lock, and the person reading this is, by definition, someone who
 * cannot get in.
 */
export async function notifyAccountLocked(
  user: { id: string; email: string; full_name: string; tenant_name: string | null; tenant_id: string | null },
  ip: string | null,
): Promise<void> {
  try {
    const { token } = await issueAuthToken(user.id, 'PASSWORD_RESET', { ip });
    await queueAccountLocked({
      to: user.email,
      contactName: user.full_name,
      lockMinutes: LOCKOUT_MINUTES,
      ip,
      resetUrl: resetUrlFor(token),
      userId: user.id,
      tenantId: user.tenant_id,
    });
  } catch (err) {
    // A lock that cannot be announced is still a lock. Never let the mail path
    // turn a failed sign-in into a 500.
    logger.error({ err, userId: user.id }, 'could not send the account lock alert');
  }
}

/**
 * Set a new password and deal with every consequence of having done so.
 *
 * One place for all three routes that can change a secret — in-session change,
 * reset by link, and invitation acceptance — because the consequences are the
 * part that gets forgotten: the history entry, clearing the rotation flag,
 * releasing the lock, ending other sessions, and telling the account holder.
 */
async function applyNewPassword(params: {
  contact: ContactRow;
  newPassword: string;
  ip: string | null;
  /** Sessions to end. A reset always ends all of them; a change may keep one. */
  keepRefreshTokenHash?: string | null;
  revokeSessions: boolean;
  /** Invitation acceptance also turns the account on. */
  activate?: boolean;
  fullName?: string;
}): Promise<void> {
  const { contact, newPassword, ip } = params;

  const history = Array.isArray(contact.password_history) ? contact.password_history : [];
  // §4.2: the current password counts as generation one, so it is checked too —
  // otherwise "change" could be satisfied by retyping what is already set.
  const known = contact.password_hash ? [contact.password_hash, ...history] : history;

  if (await reusesRecentPassword(newPassword, known)) {
    throw badRequest(
      `Choose a password you have not used before. The last ${PASSWORD_HISTORY_DEPTH} cannot be reused.`,
    );
  }

  const hash = await hashPassword(newPassword);
  const nextHistory = contact.password_hash
    ? pushPasswordHistory(history, contact.password_hash)
    : history;

  await sql()`
    UPDATE users SET
      password_hash            = ${hash},
      password_history         = ${jsonb(sql(), nextHistory)},
      password_last_changed_at = CURRENT_TIMESTAMP,
      must_rotate_password     = FALSE,
      failed_logins            = 0,
      last_failed_login_at     = NULL,
      is_locked                = FALSE,
      locked_until             = NULL,
      -- Both only move on invitation acceptance; every other caller passes the
      -- value already stored, which keeps this one statement for all three
      -- routes without stitching SQL fragments together conditionally.
      is_active                = ${params.activate ? true : contact.is_active},
      full_name                = ${params.fullName ?? contact.full_name}
    WHERE id = ${contact.id}
  `;

  if (params.revokeSessions) {
    if (params.keepRefreshTokenHash) {
      await sql()`
        UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP
        WHERE user_id = ${contact.id} AND revoked_at IS NULL
          AND token_hash <> ${params.keepRefreshTokenHash}
      `;
    } else {
      await revokeAllSessions(contact.id);
    }
  }

  // Template D. Not awaited for its outcome beyond queueing: a confirmation
  // that cannot be sent must not undo a password the user has already set.
  await queuePasswordChanged({
    to: contact.email,
    contactName: contact.full_name,
    companyName: contact.tenant_name,
    changedAt: new Date(),
    ip,
    userId: contact.id,
    tenantId: contact.tenant_id,
  });
}

/** §4.2 — authenticated in-session change. */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  options: { ip?: string | null; signOutOtherDevices?: boolean; currentRefreshToken?: string } = {},
): Promise<void> {
  const contact = await loadContact(userId);

  // §4.2 step 2: the re-authentication gate. Verified before the new secret is
  // even looked at, so an unattended terminal cannot be used to take an account.
  if (!contact?.password_hash || !(await verifyPassword(contact.password_hash, currentPassword))) {
    throw badRequest('Your current password is not correct.');
  }

  await applyNewPassword({
    contact,
    newPassword,
    ip: options.ip ?? null,
    revokeSessions: options.signOutOtherDevices !== false,
    keepRefreshTokenHash: options.currentRefreshToken
      ? sha256Hex(options.currentRefreshToken)
      : null,
  });
}

/**
 * §4.1 — self-service recovery request.
 *
 * Returns nothing the caller can use to tell whether the address exists. The
 * anti-enumeration requirement is the whole design here: every branch that
 * could leak — unknown address, deactivated account, rate limit reached — ends
 * in the same silence, and the differences are recorded in the log instead.
 */
export async function requestPasswordReset(email: string, ip: string | null): Promise<void> {
  const address = email.trim().toLowerCase();

  // §4.1 step 3: per address and per IP, so neither a single mailbox nor a
  // single origin can be used to flood.
  const limits = await Promise.all([
    consumeRateLimit(`pwreset:email:${address}`, RESET_REQUESTS_PER_HOUR, 3600),
    consumeRateLimit(`pwreset:ip:${ip ?? 'unknown'}`, RESET_REQUESTS_PER_HOUR, 3600),
  ]);

  if (limits.some((l) => !l.allowed)) {
    logger.warn({ email: address, ip }, 'password reset rate limit reached');
    return;
  }

  const rows = await sql().unsafe<ContactRow[]>(
    `SELECT ${CONTACT_COLUMNS} FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.email = $1`,
    [address],
  );

  const contact = rows[0];
  if (!contact || !contact.is_active) {
    logger.info({ email: address, ip }, 'password reset requested for an unusable account');
    return;
  }

  const { token } = await issueAuthToken(contact.id, 'PASSWORD_RESET', { ip });

  await queuePasswordReset({
    to: contact.email,
    contactName: contact.full_name,
    companyName: contact.tenant_name,
    resetUrl: resetUrlFor(token),
    userId: contact.id,
    tenantId: contact.tenant_id,
  });

  logger.info({ userId: contact.id }, 'password reset link issued');
}

/** Whether a reset link is still good, checked before asking for a password. */
export async function checkResetToken(
  token: string,
): Promise<{ valid: boolean; email: string | null; message: string }> {
  const result = await inspectAuthToken(token, 'PASSWORD_RESET');

  if (!result.ok) {
    return { valid: false, email: null, message: REDEEM_MESSAGES[result.reason] };
  }
  return { valid: true, email: result.row.email, message: 'Choose a new password.' };
}

/** §4.1 steps 6 and 7 — redeem the link and set the new secret. */
export async function resetPassword(
  token: string,
  newPassword: string,
  ip: string | null,
): Promise<void> {
  const result = await inspectAuthToken(token, 'PASSWORD_RESET');
  if (!result.ok) throw badRequest(REDEEM_MESSAGES[result.reason]);

  const contact = await loadContact(result.row.userId);
  if (!contact) throw badRequest('The account for this link no longer exists.');

  await applyNewPassword({
    contact,
    newPassword,
    ip,
    // A reset is the response to a lost or compromised password, so every
    // session goes — including, deliberately, any the attacker holds.
    revokeSessions: true,
  });

  await consumeAuthToken(result.row.id);
}

/** §4.3 — an administrator holds an account at the rotation gate. */
export async function setMustRotatePassword(userId: string, required: boolean): Promise<void> {
  await sql()`UPDATE users SET must_rotate_password = ${required} WHERE id = ${userId}`;
}

/**
 * §4.3 — an administrator sends a reset link without ever seeing a password.
 *
 * Distinct from `requestPasswordReset` in that the caller is entitled to know
 * whether it worked: there is no address to enumerate when an administrator is
 * acting on a user already listed on their own screen.
 */
export async function sendAdminPasswordReset(
  userId: string,
  ip: string | null,
): Promise<{ sent: boolean; reason?: string }> {
  const contact = await loadContact(userId);
  if (!contact) throw badRequest('That user no longer exists.');

  const { token } = await issueAuthToken(contact.id, 'PASSWORD_RESET', { ip });

  const result = await queuePasswordReset({
    to: contact.email,
    contactName: contact.full_name,
    companyName: contact.tenant_name,
    resetUrl: resetUrlFor(token),
    userId: contact.id,
    tenantId: contact.tenant_id,
  });

  return { sent: result.queued, reason: result.reason };
}

// --- Invitations --------------------------------------------------------------

/**
 * Issue an activation token for a user.
 *
 * Pass the surrounding transaction when the user is being created in one:
 * without it this runs on a different pooled connection, which cannot see the
 * uncommitted row and fails on `auth_tokens.user_id`.
 */
export async function createInvite(userId: string, client: Sql | Tx = sql()): Promise<string> {
  const { token } = await issueAuthToken(userId, 'ACTIVATION_INVITE', { client });
  return token;
}

export async function acceptInvite(
  token: string,
  fullName: string,
  password: string,
  ip: string | null = null,
): Promise<SessionUser> {
  const result = await inspectAuthToken(token, 'ACTIVATION_INVITE');
  if (!result.ok) throw badRequest(REDEEM_MESSAGES[result.reason]);

  const contact = await loadContact(result.row.userId);
  if (!contact) throw badRequest('The account for this invitation no longer exists.');

  await applyNewPassword({
    contact,
    newPassword: password,
    ip,
    revokeSessions: false, // A brand-new account has no sessions to end.
    activate: true,
    fullName,
  });

  await consumeAuthToken(result.row.id);

  const users = await withPlatformAccess((tx) =>
    tx.unsafe<UserRow[]>(
      `SELECT ${SESSION_USER_COLUMNS}
       FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1`,
      [contact.id],
    ),
  );

  const user = users[0];
  if (!user) throw badRequest('The account for this invitation no longer exists.');
  return toSessionUser(user);
}

export { isPlatformRole };
