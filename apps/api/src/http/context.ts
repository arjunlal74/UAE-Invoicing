import type { Role } from '@uae/contracts';
import { isPlatformRole } from '@uae/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../auth/tokens.js';

/**
 * Per-request identity, attached by `authenticate` and read by every handler.
 */
export interface RequestContext {
  userId: string;
  email: string;
  role: Role;
  /** Null for platform staff, who are not scoped to a tenant. */
  tenantId: string | null;
  ip: string | undefined;
  userAgent: string | undefined;
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
 * Platform staff may act on a specific tenant by passing `?tenantId=`, which is
 * how the admin panel inspects a customer's data. Merchant users get their own
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
  };
}

/** Route guard: the caller's role must be in `roles`. */
export function requireRole(...roles: Role[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await authenticate(request);
    const ctx = requireContext(request);
    if (!roles.includes(ctx.role)) {
      throw forbidden('Your role does not allow this action.');
    }
  };
}

export function requirePlatform() {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await authenticate(request);
    const ctx = requireContext(request);
    if (!isPlatformRole(ctx.role)) {
      throw forbidden('This area is restricted to platform administrators.');
    }
  };
}

export function requireAuth() {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await authenticate(request);
  };
}

/** Roles permitted to change staged data or submit invoices. */
export const EDITOR_ROLES: Role[] = ['TENANT_ADMIN', 'FINANCE_USER', 'DATA_ENTRY_CLERK'];
/** Roles permitted to read tenant data. */
export const READER_ROLES: Role[] = [...EDITOR_ROLES, 'AUDITOR'];
