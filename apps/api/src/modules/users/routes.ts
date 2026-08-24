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
import {
  createInvite,
  revokeAllSessions,
  sendAdminPasswordReset,
  setMustRotatePassword,
} from '../../auth/service.js';
import { queueActivation } from '../../mail/outbox.js';
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

    const organisation = await sql()<{ legal_name_en: string }[]>`
      SELECT legal_name_en FROM tenants WHERE id = ${ctx.tenantId}
    `;

    const mail = await queueActivation({
      to: body.email,
      contactName: body.fullName,
      companyName: organisation[0]?.legal_name_en ?? 'your organisation',
      activationUrl: inviteUrl,
      userId,
      tenantId: ctx.tenantId,
    });

    await audit(actorFromContext(ctx), {
      action: 'USER_INVITED',
      resourceType: 'USER',
      resourceId: userId,
      tenantId: ctx.tenantId,
      changes: { email: body.email, role: body.role },
    });

    logger.info({ userId, emailed: mail.queued }, 'user invite created');

    // The link is still returned even when the e-mail went out. Mail can be
    // delayed or filtered, and the administrator who created the account is the
    // one who gets asked why it never arrived.
    return reply.status(201).send({
      id: userId,
      inviteUrl,
      emailed: mail.queued,
      emailMessage: mail.reason ?? null,
    });
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

      const rows = await sql()<
        { id: string; email: string; full_name: string; role: Role; password_hash: string | null }[]
      >`
        SELECT id, email, full_name, role, password_hash
        FROM users WHERE id = ${id} AND tenant_id = ${ctx.tenantId}
      `;
      const user = rows[0];
      if (!user) throw notFound('User');
      if (user.password_hash) throw badRequest('That user has already accepted their invitation.');

      const token = await createInvite(id);
      const inviteUrl = `${config().PORTAL_ORIGIN}/accept-invite?token=${token}`;

      const organisation = await sql()<{ legal_name_en: string }[]>`
        SELECT legal_name_en FROM tenants WHERE id = ${ctx.tenantId}
      `;

      const mail = await queueActivation({
        to: user.email,
        contactName: user.full_name,
        companyName: organisation[0]?.legal_name_en ?? 'your organisation',
        activationUrl: inviteUrl,
        userId: id,
        tenantId: ctx.tenantId,
      });

      return reply.send({ inviteUrl, emailed: mail.queued, emailMessage: mail.reason ?? null });
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
    const inviteUrl = `${config().PORTAL_ORIGIN}/accept-invite?token=${token}`;

    const mail = await queueActivation({
      to: body.email,
      contactName: body.fullName,
      companyName: config().PLATFORM_NAME,
      activationUrl: inviteUrl,
      userId,
    });

    await audit(actorFromContext(ctx), {
      action: 'USER_INVITED',
      resourceType: 'USER',
      resourceId: userId,
      changes: { email: body.email, role: body.role, scope: 'platform' },
    });

    return reply.status(201).send({
      id: userId,
      inviteUrl,
      emailed: mail.queued,
      emailMessage: mail.reason ?? null,
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

  // --- Administrator-initiated credential actions (SRS v2.3 §4.3) ----------
  //
  // Both are deliberately write-only with respect to the secret itself. §4.3
  // step 3: "Under no circumstances can an Administrator define or view a
  // clear-text password for any user account." There is therefore no endpoint
  // anywhere that accepts a password on another user's behalf — an
  // administrator can only send a link, or require a rotation.

  /** A company admin acting on a user inside their own tenant. */
  app.post(
    '/api/v1/tenant/users/:id/send-reset',
    { preHandler: requireAuth() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId || !can(ctx.role, 'tenant.users.manage')) throw forbidden();

      await assertUserInTenant(id, ctx.tenantId);
      const result = await sendAdminPasswordReset(id, ctx.ip ?? null);

      await audit(actorFromContext(ctx), {
        action: 'PASSWORD_RESET_REQUESTED',
        resourceType: 'USER',
        resourceId: id,
        tenantId: ctx.tenantId,
        changes: { by: 'company administrator', emailed: result.sent },
      });

      return reply.send(result);
    },
  );

  app.post(
    '/api/v1/tenant/users/:id/force-rotation',
    { preHandler: requireAuth() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId || !can(ctx.role, 'tenant.users.manage')) throw forbidden();
      if (id === ctx.userId) throw badRequest('You cannot lock yourself out of your own account.');

      await assertUserInTenant(id, ctx.tenantId);
      await setMustRotatePassword(id, true);

      await audit(actorFromContext(ctx), {
        action: 'PASSWORD_ROTATION_REQUIRED',
        resourceType: 'USER',
        resourceId: id,
        tenantId: ctx.tenantId,
      });

      return reply.status(204).send();
    },
  );

  /** The host global admin, who may act on any account. */
  app.post(
    '/api/v1/admin/users/:id/send-reset',
    { preHandler: requirePlatform() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!can(ctx.role, 'platform.manage')) throw forbidden();

      const result = await sendAdminPasswordReset(id, ctx.ip ?? null);

      await audit(actorFromContext(ctx), {
        action: 'PASSWORD_RESET_REQUESTED',
        resourceType: 'USER',
        resourceId: id,
        changes: { by: 'global administrator', emailed: result.sent },
      });

      return reply.send(result);
    },
  );

  app.post(
    '/api/v1/admin/users/:id/force-rotation',
    { preHandler: requirePlatform() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!can(ctx.role, 'platform.manage')) throw forbidden();
      if (id === ctx.userId) throw badRequest('You cannot lock yourself out of your own account.');

      await setMustRotatePassword(id, true);

      await audit(actorFromContext(ctx), {
        action: 'PASSWORD_ROTATION_REQUIRED',
        resourceType: 'USER',
        resourceId: id,
      });

      return reply.status(204).send();
    },
  );
}

/** Refuses to act on a user who belongs to somebody else's tenant. */
async function assertUserInTenant(userId: string, tenantId: string): Promise<void> {
  const rows = await sql()<{ id: string }[]>`
    SELECT id FROM users WHERE id = ${userId} AND tenant_id = ${tenantId}
  `;
  if (!rows[0]) throw notFound('User');
}
