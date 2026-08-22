import {
  InviteUserRequest,
  PLATFORM_ROLES,
  TENANT_ROLES,
  can,
  type Role,
  type UserSummary,
} from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { createInvite, revokeAllSessions } from '../../auth/service.js';
import { config } from '../../config.js';
import { sql } from '../../db/client.js';
import { requireAuth, requireContext, requirePlatform } from '../../http/context.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { logger } from '../../logger.js';

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  tenant_id: string | null;
  is_active: boolean;
  mfa_enabled: boolean;
  last_login_at: Date | null;
  invite_pending: boolean;
  created_at: Date;
}

function toSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    tenantId: row.tenant_id,
    isActive: row.is_active,
    mfaEnabled: row.mfa_enabled,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
    invitePending: row.invite_pending,
    createdAt: row.created_at.toISOString(),
  };
}

const USER_SELECT = `
  u.id, u.email, u.full_name, u.role, u.tenant_id, u.is_active,
  u.mfa_enabled, u.last_login_at, u.created_at,
  (u.password_hash IS NULL) AS invite_pending
`;

export function registerUserRoutes(app: FastifyInstance) {
  // --- Merchant: users within own tenant -----------------------------------
  app.get('/api/v1/tenant/users', { preHandler: requireAuth() }, async (request, reply) => {
    const ctx = requireContext(request);
    if (!ctx.tenantId) throw notFound('Tenant');

    const rows = await sql().unsafe<UserRow[]>(
      `SELECT ${USER_SELECT} FROM users u WHERE u.tenant_id = $1 ORDER BY u.created_at`,
      [ctx.tenantId],
    );

    return reply.send({ items: rows.map(toSummary), total: rows.length, page: 1, pageSize: rows.length });
  });

  app.post('/api/v1/tenant/users', { preHandler: requireAuth() }, async (request, reply) => {
    const ctx = requireContext(request);
    if (!ctx.tenantId) throw notFound('Tenant');
    if (!can(ctx.role, 'tenant.users.manage')) {
      throw forbidden('Only a company administrator can invite users.');
    }

    const body = InviteUserRequest.parse(request.body);
    // A company admin must not be able to mint themselves a platform or
    // partner role. PARTNER_ADMIN is excluded here as well as the platform
    // roles: it is granted by onboarding a channel partner, not by invitation.
    if (!TENANT_ROLES.includes(body.role)) {
      throw badRequest('That role cannot be assigned within a tenant.');
    }

    const rows = await sql()<{ id: string }[]>`
      INSERT INTO users (tenant_id, email, full_name, role, is_active)
      VALUES (${ctx.tenantId}, ${body.email}, ${body.fullName}, ${body.role}::user_role, FALSE)
      RETURNING id
    `;

    const userId = rows[0]!.id;
    const token = await createInvite(userId);
    const inviteUrl = `${config().PORTAL_ORIGIN}/accept-invite?token=${token}`;

    await audit(actorFromContext(ctx), {
      action: 'USER_INVITED',
      resourceType: 'USER',
      resourceId: userId,
      tenantId: ctx.tenantId,
      changes: { email: body.email, role: body.role },
    });

    logger.info({ userId, inviteUrl }, 'user invite created');
    return reply.status(201).send({ id: userId, inviteUrl });
  });

  app.post(
    '/api/v1/tenant/users/:id/deactivate',
    { preHandler: requireAuth() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };

      if (!ctx.tenantId) throw notFound('Tenant');
      if (!can(ctx.role, 'tenant.users.manage')) {
        throw forbidden('Only a company administrator can do that.');
      }
      if (id === ctx.userId) throw badRequest('You cannot deactivate your own account.');

      const rows = await sql()<{ id: string; role: Role }[]>`
        UPDATE users SET is_active = FALSE
        WHERE id = ${id} AND tenant_id = ${ctx.tenantId}
        RETURNING id, role
      `;
      if (!rows[0]) throw notFound('User');

      // Deactivation must end existing sessions, otherwise a live access token
      // keeps working for up to its full lifetime after the account is closed.
      await revokeAllSessions(id);

      await audit(actorFromContext(ctx), {
        action: 'USER_DEACTIVATED',
        resourceType: 'USER',
        resourceId: id,
        tenantId: ctx.tenantId,
      });

      return reply.status(204).send();
    },
  );

  app.post(
    '/api/v1/tenant/users/:id/resend-invite',
    { preHandler: requireAuth() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };

      if (!ctx.tenantId || !can(ctx.role, 'tenant.users.manage')) throw forbidden();

      const rows = await sql()<{ id: string; password_hash: string | null }[]>`
        SELECT id, password_hash FROM users WHERE id = ${id} AND tenant_id = ${ctx.tenantId}
      `;
      if (!rows[0]) throw notFound('User');
      if (rows[0].password_hash) throw badRequest('That user has already accepted their invitation.');

      const token = await createInvite(id);
      return reply.send({ inviteUrl: `${config().PORTAL_ORIGIN}/accept-invite?token=${token}` });
    },
  );

  // --- Platform: staff accounts -------------------------------------------
  app.get('/api/v1/admin/staff', { preHandler: requirePlatform() }, async (_request, reply) => {
    const rows = await sql().unsafe<UserRow[]>(
      `SELECT ${USER_SELECT} FROM users u WHERE u.tenant_id IS NULL ORDER BY u.created_at`,
    );
    return reply.send({ items: rows.map(toSummary), total: rows.length, page: 1, pageSize: rows.length });
  });

  app.post('/api/v1/admin/staff', { preHandler: requirePlatform() }, async (request, reply) => {
    const ctx = requireContext(request);
    if (!can(ctx.role, 'platform.manage')) {
      throw forbidden('Only a global administrator can create staff accounts.');
    }

    const body = InviteUserRequest.parse(request.body);
    if (!PLATFORM_ROLES.includes(body.role)) {
      throw badRequest('Staff accounts must have a platform role.');
    }

    const rows = await sql()<{ id: string }[]>`
      INSERT INTO users (tenant_id, email, full_name, role, is_active)
      VALUES (NULL, ${body.email}, ${body.fullName}, ${body.role}::user_role, FALSE)
      RETURNING id
    `;

    const userId = rows[0]!.id;
    const token = await createInvite(userId);

    await audit(actorFromContext(ctx), {
      action: 'USER_INVITED',
      resourceType: 'USER',
      resourceId: userId,
      changes: { email: body.email, role: body.role, scope: 'platform' },
    });

    return reply.status(201).send({
      id: userId,
      inviteUrl: `${config().PORTAL_ORIGIN}/accept-invite?token=${token}`,
    });
  });

  // Users of a given tenant, for the admin panel's tenant detail screen.
  app.get(
    '/api/v1/admin/tenants/:id/users',
    { preHandler: requirePlatform() },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await sql().unsafe<UserRow[]>(
        `SELECT ${USER_SELECT} FROM users u WHERE u.tenant_id = $1 ORDER BY u.created_at`,
        [id],
      );
      return reply.send({ items: rows.map(toSummary), total: rows.length, page: 1, pageSize: rows.length });
    },
  );
}
