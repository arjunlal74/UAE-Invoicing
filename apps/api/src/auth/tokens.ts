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
    };
  } catch {
    throw unauthorized('Your session has expired. Please sign in again.');
  }
}
