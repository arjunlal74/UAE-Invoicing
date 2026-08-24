import type { Permission, Role } from '@uae/contracts';
import { ROLE_PERMISSIONS, can, canAny } from '@uae/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, rotationRequired, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../auth/tokens.js';

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
    if (!canAny(ctx.role, ...permissions)) {
      throw forbidden('Your role does not allow this action.');
    }
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
  if (!can(ctx.role, permission)) throw forbidden(message);
}

export { ROLE_PERMISSIONS, can, canAny };
