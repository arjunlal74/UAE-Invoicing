import type { Role } from '@uae/contracts';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';
import { unauthorized } from '../lib/errors.js';

/**
 * Access tokens are short-lived JWTs; refresh tokens are opaque random strings
 * stored hashed in the database. Access tokens are therefore not revocable
 * within their (15 minute) lifetime, while a session can be killed instantly by
 * revoking its refresh token — the usual trade, made explicit.
 */

export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: Role;
  tenantId: string | null;
  /**
   * SRS v2.3 §4.3. Carried in the token rather than read from the database on
   * every request because the specification makes the flag bite "upon the
   * user's next login" — so the value at issue time is the correct one, and a
   * per-request lookup would buy nothing but latency.
   */
  mustRotatePassword?: boolean;
  /**
   * SRS §3 custody. Set when a channel partner's staff member is working inside
   * a client's books: `tenantId` is then the client, and this is the partner
   * the person actually belongs to.
   *
   * Carried in the token because everything downstream — row-level scoping, the
   * audit actor, the guard that keeps a custody session out of the partner
   * console — has to know within the request, and re-deriving it from the
   * database on every call would be a join to answer a question the token
   * already settled at issue time.
   */
  actingForTenantId?: string | null;
}

function accessKey(): Uint8Array {
  return new TextEncoder().encode(config().JWT_ACCESS_SECRET);
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  const cfg = config();
  return new SignJWT({
    email: claims.email,
    role: claims.role,
    tenantId: claims.tenantId,
    mustRotatePassword: claims.mustRotatePassword ?? false,
    actingForTenantId: claims.actingForTenantId ?? null,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer('uae-einvoice')
    .setAudience('uae-einvoice-portal')
    .setExpirationTime(`${cfg.JWT_ACCESS_TTL}s`)
    .sign(accessKey());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, accessKey(), {
      issuer: 'uae-einvoice',
      audience: 'uae-einvoice-portal',
    });

    return {
      sub: String(payload.sub),
      email: String(payload.email),
      role: payload.role as Role,
      tenantId: (payload.tenantId as string | null) ?? null,
      mustRotatePassword: payload.mustRotatePassword === true,
      actingForTenantId: (payload.actingForTenantId as string | null) ?? null,
    };
  } catch {
    throw unauthorized('Your session has expired. Please sign in again.');
  }
}
