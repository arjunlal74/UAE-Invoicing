import { API_KEY_SCOPES, type ApiKeySummary, type Permission } from '@uae/contracts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { withPlatformAccess, withTenant, type Tx } from '../db/client.js';
import { badRequest } from '../lib/errors.js';

/**
 * Machine credentials for ingestion channel 1 (SRS v2.1 §1.2).
 *
 * A person authenticates with a password they can be made to rotate and a
 * second factor they carry. An ERP has neither: it holds one long-lived string
 * in a configuration file that a dozen people can read. Everything here follows
 * from that difference — the token is high-entropy so it cannot be guessed, it
 * is shown exactly once so the platform never becomes a place to look it up,
 * its authority is a scope list rather than a role so a leak is bounded, and it
 * can be revoked without touching the person who created it or the jobs of the
 * other integrations in the same tenant.
 */

/**
 * `uaeinv_<env>_<43 base64url chars>`.
 *
 * The prefix is there to be recognised: secret scanners match on a literal
 * marker, and a token that looks like any other opaque string is a token that
 * sits in a public repository unnoticed. The environment segment stops a
 * sandbox key being pasted into production configuration and quietly failing to
 * authenticate for reasons nobody can see.
 */
const TOKEN_PREFIX = 'uaeinv';
const SECRET_BYTES = 32;
/** Enough of the token to identify it in a list. Never enough to use it. */
const DISPLAY_PREFIX_LENGTH = 18;

export interface ApiKeyRow {
  id: string;
  tenant_id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  created_by_user_id: string | null;
  created_by_name?: string | null;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function environmentSegment(): string {
  return process.env.NODE_ENV === 'production' ? 'live' : 'test';
}

export function generateToken(): { token: string; tokenHash: string; keyPrefix: string } {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const token = `${TOKEN_PREFIX}_${environmentSegment()}_${secret}`;
  return {
    token,
    tokenHash: hashToken(token),
    keyPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

/**
 * Reject a scope list that asks for more than a machine is ever offered.
 *
 * Checked here rather than only in the portal because the portal is not the
 * only thing that can call the endpoint that creates keys — and a key that
 * granted `platform.manage` because a request body said so would be the whole
 * permission model undone by one unvalidated array.
 */
export function validateScopes(requested: string[]): Permission[] {
  const scopes = [...new Set(requested)];
  const rejected = scopes.filter((scope) => !(API_KEY_SCOPES as string[]).includes(scope));

  if (rejected.length > 0) {
    throw badRequest(
      `These permissions cannot be granted to an API key: ${rejected.join(', ')}.`,
      { allowed: API_KEY_SCOPES },
    );
  }
  return scopes as Permission[];
}

export interface AuthenticatedApiKey {
  id: string;
  tenantId: string;
  name: string;
  keyPrefix: string;
  scopes: Permission[];
}

/**
 * Resolve a presented token, or explain why it will not do.
 *
 * Runs with platform access because the caller has not identified a tenant yet
 * — the key is what says which tenant this is. The lookup is by hash on a
 * unique index, so it is one index probe and does not widen with the number of
 * keys on the platform.
 *
 * The reasons are distinguished internally and collapsed to one message at the
 * boundary: an integrator debugging a 401 needs to know whether their key is
 * wrong, revoked or expired, and an attacker probing tokens must not learn
 * which of their guesses named a real key.
 */
export type ApiKeyFailure = 'malformed' | 'unknown' | 'revoked' | 'expired' | 'tenant_inactive';

export async function authenticateToken(
  token: string,
): Promise<{ ok: true; key: AuthenticatedApiKey } | { ok: false; reason: ApiKeyFailure }> {
  if (!token.startsWith(`${TOKEN_PREFIX}_`) || token.length < 40) {
    return { ok: false, reason: 'malformed' };
  }

  const presented = hashToken(token);

  const rows = await withPlatformAccess(
    (tx) => tx<
      {
        id: string;
        tenant_id: string;
        name: string;
        key_prefix: string;
        token_hash: string;
        scopes: string[];
        revoked_at: Date | null;
        expires_at: Date | null;
        tenant_status: string;
      }[]
    >`
      SELECT k.id, k.tenant_id, k.name, k.key_prefix, k.token_hash, k.scopes,
             k.revoked_at, k.expires_at, t.status::text AS tenant_status
      FROM api_keys k
      JOIN tenants t ON t.id = k.tenant_id
      WHERE k.token_hash = ${presented}
    `,
  );

  const row = rows[0];
  if (!row) return { ok: false, reason: 'unknown' };

  // The index lookup already matched, so this compares two equal strings in the
  // happy path. It is here for the case where the column is ever made
  // non-unique or the query gains a second predicate — the comparison that
  // decides authentication should not be one Postgres did for us.
  const stored = Buffer.from(row.token_hash, 'utf8');
  const supplied = Buffer.from(presented, 'utf8');
  if (stored.length !== supplied.length || !timingSafeEqual(stored, supplied)) {
    return { ok: false, reason: 'unknown' };
  }

  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  // A suspended tenant must stop filing through every door, not just the one a
  // person walks through.
  if (row.tenant_status !== 'ACTIVE') return { ok: false, reason: 'tenant_inactive' };

  return {
    ok: true,
    key: {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      keyPrefix: row.key_prefix,
      scopes: row.scopes.filter((s): s is Permission =>
        (API_KEY_SCOPES as string[]).includes(s),
      ),
    },
  };
}

/**
 * Record that a key was used, without making every request wait for it.
 *
 * `last_used_at` exists so an operator can find the key nobody has used in a
 * year and revoke it. It is not evidence of anything — the audit trail is —
 * so it is written at a coarse granularity and never blocks the response.
 */
const LAST_USED_RESOLUTION_MS = 60_000;
const lastTouched = new Map<string, number>();

export function touchApiKey(keyId: string, tenantId: string): void {
  const now = Date.now();
  const previous = lastTouched.get(keyId) ?? 0;
  if (now - previous < LAST_USED_RESOLUTION_MS) return;
  lastTouched.set(keyId, now);

  void withTenant(
    tenantId,
    (tx) => tx`UPDATE api_keys SET last_used_at = now() WHERE id = ${keyId}`,
  ).catch(() => {
    // Losing a usage timestamp is not worth failing an invoice submission over.
    lastTouched.delete(keyId);
  });
}

export function toApiKeySummary(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: row.scopes,
    createdByName: row.created_by_name ?? null,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export const API_KEY_SELECT = `
  k.id, k.tenant_id, k.name, k.key_prefix, k.scopes, k.created_by_user_id,
  k.last_used_at, k.expires_at, k.revoked_at, k.created_at,
  (SELECT full_name FROM users u WHERE u.id = k.created_by_user_id) AS created_by_name
`;

export async function listKeys(tx: Tx, tenantId: string): Promise<ApiKeyRow[]> {
  return tx.unsafe<ApiKeyRow[]>(
    `SELECT ${API_KEY_SELECT}
     FROM api_keys k
     WHERE k.tenant_id = $1
     ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC
     LIMIT 200`,
    [tenantId],
  );
}
