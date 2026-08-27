import type { Permission, Role } from '@uae/contracts';
import { ROLE_PERMISSIONS, can, canAny } from '@uae/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { authenticateToken, touchApiKey } from '../auth/apiKeys.js';
import { verifyAccessToken } from '../auth/tokens.js';
import { forbidden, rotationRequired, unauthorized } from '../lib/errors.js';
import { logger } from '../logger.js';

/**
 * Per-request identity, attached by `authenticate` and read by every handler.
 */
export interface RequestContext {
  userId: string;
  email: string;
  role: Role;
  /** Null for the global admin, who is not scoped to a tenant. */
  tenantId: string | null;
  ip: string | undefined;
  userAgent: string | undefined;
  /** SRS v2.3 §4.3: the account is held at the rotation gate. */
  mustRotatePassword: boolean;
  /**
   * Set when the caller is a machine on an API key (§1.2 channel 1). Its
   * presence is what distinguishes an ERP from a person for audit and rate
   * limiting; `role` is `API_CLIENT` and carries no permissions of its own.
   */
  apiKey?: { id: string; name: string; keyPrefix: string };
  /**
   * The permissions actually granted to this request. Undefined means "whatever
   * the role grants", which is every session; an API key sets it explicitly.
   */
  scopes?: Permission[];
}

/**
 * What this caller may do — the single answer, whether it arrived on a session
 * or on a key.
 *
 * Every guard goes through this rather than through `can(ctx.role, …)`, because
 * a machine's authority is its scope list and its role is deliberately empty.
 * A check written against the role alone still *works* for an API key — it
 * refuses — which is the right way for this to fail if one is ever missed.
 */
export function permissionsOf(ctx: RequestContext): Permission[] {
  return ctx.scopes ?? ROLE_PERMISSIONS[ctx.role];
}

export function ctxCan(ctx: RequestContext, permission: Permission): boolean {
  return permissionsOf(ctx).includes(permission);
}

export function ctxCanAny(ctx: RequestContext, ...permissions: Permission[]): boolean {
  const granted = permissionsOf(ctx);
  return permissions.some((permission) => granted.includes(permission));
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx?: RequestContext;
  }
}

export function requireContext(request: FastifyRequest): RequestContext {
  if (!request.ctx) throw unauthorized();
  return request.ctx;
}

/**
 * The tenant a merchant request operates on.
 *
 * The global admin may act on a specific tenant by passing `?tenantId=`, which
 * is how the admin panel inspects a customer's data. Tenant users get their own
 * tenant and nothing else — the query parameter is ignored for them rather
 * than honoured, so a crafted URL cannot cross the boundary.
 */
export function resolveTenantId(request: FastifyRequest): string {
  const ctx = requireContext(request);
  if (ctx.tenantId) return ctx.tenantId;

  const query = request.query as Record<string, unknown> | undefined;
  const requested = typeof query?.tenantId === 'string' ? query.tenantId : null;
  if (requested) return requested;

  throw forbidden('Select a tenant to view this data.');
}

export async function authenticate(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();

  const claims = await verifyAccessToken(header.slice(7).trim());

  request.ctx = {
    userId: claims.sub,
    email: claims.email,
    role: claims.role,
    tenantId: claims.tenantId,
    ip: request.ip,
    userAgent: request.headers['user-agent'],
    mustRotatePassword: claims.mustRotatePassword === true,
  };

  // §4.3: "the application restricts access to an isolated modal forcing the
  // user to establish a permanent secret before any tax data can be accessed".
  // Enforced here rather than in the portal alone — a client-side gate on a
  // tax record is decoration, not a control.
  if (request.ctx.mustRotatePassword && !ROTATION_EXEMPT.has(request.routeOptions.url ?? '')) {
    throw rotationRequired();
  }
}

/**
 * Routes reachable while the rotation gate is closed: reading your own identity
 * so the portal can render the modal, setting the new password, and leaving.
 */
const ROTATION_EXEMPT = new Set([
  '/api/v1/auth/me',
  '/api/v1/auth/change-password',
  '/api/v1/auth/logout',
  '/api/v1/auth/refresh',
]);

/**
 * Route guard: the caller must hold at least one of `permissions`.
 *
 * Guards name capabilities rather than roles so that the SRS §5 matrix lives in
 * one file. Several endpoints legitimately accept more than one capability —
 * batch submission is open to whoever prepares invoices *and* to the approver
 * who can file them outright — which is why this is an "any of" test.
 */
export function requirePermission(...permissions: Permission[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await authenticate(request);
    const ctx = requireContext(request);
    if (!ctxCanAny(ctx, ...permissions)) {
      throw forbidden(
        ctx.apiKey
          ? `This API key is not scoped for this action. It would need one of: ${permissions.join(', ')}.`
          : 'Your role does not allow this action.',
      );
    }
  };
}

/**
 * Route guard for endpoints an ERP calls: an API key, or a session that could
 * have made the same call by hand.
 *
 * Both are admitted deliberately. An integrator's first act is to reproduce a
 * failing call from a browser or a terminal with their own login, and an
 * ingestion endpoint that only speaks to keys makes that impossible.
 */
export function requireApiAccess(...permissions: Permission[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (presentedApiKey(request)) {
      await authenticateApiKey(request);
      const ctx = requireContext(request);
      if (!ctxCanAny(ctx, ...permissions)) {
        throw forbidden(
          `This API key is not scoped for this action. It would need one of: ${permissions.join(', ')}.`,
        );
      }
      return;
    }
    await requirePermission(...permissions)(request, reply);
  };
}

export function requirePlatform() {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await authenticate(request);
    const ctx = requireContext(request);
    if (!can(ctx.role, 'platform.read')) {
      throw forbidden('This area is restricted to platform administrators.');
    }
  };
}

export function requirePartner() {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await authenticate(request);
    const ctx = requireContext(request);
    if (!can(ctx.role, 'partner.read')) {
      throw forbidden('This area is restricted to channel partner administrators.');
    }
  };
}

export function requireAuth() {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await authenticate(request);
  };
}

/** Throw unless the caller holds `permission`. For checks inside a handler. */
export function assertPermission(ctx: RequestContext, permission: Permission, message?: string) {
  if (!ctxCan(ctx, permission)) throw forbidden(message);
}

// ---------------------------------------------------------------------------
// API keys — ingestion channel 1
// ---------------------------------------------------------------------------

/**
 * The presented key, from either header.
 *
 * `Authorization: Bearer` is what most ERP HTTP clients are already configured
 * to send, and `X-API-Key` is what the rest send. Distinguishing a key from a
 * session token on the same header is done by the `uaeinv_` marker rather than
 * by trying to verify it as a JWT first — a failed JWT verification is not a
 * cheap way to ask "is this a different kind of credential".
 */
function presentedApiKey(request: FastifyRequest): string | null {
  const header = request.headers['x-api-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();

  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Bearer ')) {
    const token = authorization.slice(7).trim();
    if (token.startsWith('uaeinv_')) return token;
  }
  return null;
}

export async function authenticateApiKey(request: FastifyRequest): Promise<void> {
  const token = presentedApiKey(request);
  if (!token) throw unauthorized('This endpoint requires an API key.');

  const result = await authenticateToken(token);
  if (!result.ok) {
    // One message for every failure. An integrator gets the detail from the
    // portal, where they are authenticated; a caller probing tokens learns
    // nothing about which guesses named a real key.
    logger.warn(
      { reason: result.reason, ip: request.ip, url: request.url },
      'api key rejected',
    );
    throw unauthorized('That API key is not valid, has been revoked, or has expired.');
  }

  const { key } = result;
  request.ctx = {
    // The key's own id stands in for a user id so that everything downstream —
    // audit rows, `created_by_user_id`, log lines — has a stable actor to name.
    // It is not a foreign key to `users`, and the columns it reaches are the
    // nullable ones.
    userId: key.id,
    email: `${key.keyPrefix}… (${key.name})`,
    role: 'API_CLIENT',
    tenantId: key.tenantId,
    ip: request.ip,
    userAgent: request.headers['user-agent'],
    mustRotatePassword: false,
    apiKey: { id: key.id, name: key.name, keyPrefix: key.keyPrefix },
    scopes: key.scopes,
  };

  touchApiKey(key.id, key.tenantId);
}

export { ROLE_PERMISSIONS, can, canAny };
