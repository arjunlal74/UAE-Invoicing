import {
  AcceptInviteRequest,
  ChangePasswordRequest,
  LoginRequest,
  MfaEnrolConfirmRequest,
  RefreshRequest,
} from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { SYSTEM_ACTOR, audit, actorFromContext } from '../audit/audit.js';
import { sql } from '../db/client.js';
import { requireAuth, requireContext } from '../http/context.js';
import { notFound } from '../lib/errors.js';
import {
  acceptInvite,
  changePassword,
  confirmMfaEnrolment,
  disableMfa,
  login,
  refreshSession,
  revokeSession,
  startMfaEnrolment,
  toSessionUser,
} from './service.js';

export function registerAuthRoutes(app: FastifyInstance) {
  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = LoginRequest.parse(request.body);

    const outcome = await login(body.email, body.password, body.mfaCode, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    if (outcome.kind === 'mfa_required') {
      return reply.status(200).send({ mfaRequired: true });
    }

    await audit(
      {
        actorType: 'USER',
        actorId: outcome.session!.user.id,
        actorName: outcome.session!.user.email,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        tenantId: outcome.session!.user.tenantId,
      },
      { action: 'USER_LOGIN', resourceType: 'USER', resourceId: outcome.session!.user.id },
    );

    return reply.send(outcome.session);
  });

  app.post('/api/v1/auth/refresh', async (request, reply) => {
    const body = RefreshRequest.parse(request.body);
    const session = await refreshSession(body.refreshToken, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    return reply.send(session);
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const body = RefreshRequest.parse(request.body);
    await revokeSession(body.refreshToken);
    return reply.status(204).send();
  });

  app.get('/api/v1/auth/me', { preHandler: requireAuth() }, async (request, reply) => {
    const ctx = requireContext(request);

    const rows = await sql()<any[]>`
      SELECT u.id, u.tenant_id, u.email, u.full_name, u.role, u.password_hash,
             u.mfa_secret, u.mfa_enabled, u.is_active, u.failed_logins, u.locked_until,
             t.legal_name_en AS tenant_name, t.status::text AS tenant_status
      FROM users u
      LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = ${ctx.userId}
    `;

    if (!rows[0]) throw notFound('Account');
    return reply.send(toSessionUser(rows[0]));
  });

  app.post('/api/v1/auth/change-password', { preHandler: requireAuth() }, async (request, reply) => {
    const ctx = requireContext(request);
    const body = ChangePasswordRequest.parse(request.body);

    await changePassword(ctx.userId, body.currentPassword, body.newPassword);
    await audit(actorFromContext(ctx), {
      action: 'PASSWORD_CHANGED',
      resourceType: 'USER',
      resourceId: ctx.userId,
    });

    return reply.status(204).send();
  });

  app.post('/api/v1/auth/mfa/start', { preHandler: requireAuth() }, async (request, reply) => {
    const ctx = requireContext(request);
    return reply.send(await startMfaEnrolment(ctx.userId, ctx.email));
  });

  app.post('/api/v1/auth/mfa/confirm', { preHandler: requireAuth() }, async (request, reply) => {
    const ctx = requireContext(request);
    const body = MfaEnrolConfirmRequest.parse(request.body);

    await confirmMfaEnrolment(ctx.userId, body.code);
    await audit(actorFromContext(ctx), {
      action: 'MFA_ENABLED',
      resourceType: 'USER',
      resourceId: ctx.userId,
    });

    return reply.status(204).send();
  });

  app.post('/api/v1/auth/mfa/disable', { preHandler: requireAuth() }, async (request, reply) => {
    const ctx = requireContext(request);

    await disableMfa(ctx.userId);
    await audit(actorFromContext(ctx), {
      action: 'MFA_DISABLED',
      resourceType: 'USER',
      resourceId: ctx.userId,
    });

    return reply.status(204).send();
  });

  // Unauthenticated by design — the invite token is the credential.
  app.post('/api/v1/auth/accept-invite', async (request, reply) => {
    const body = AcceptInviteRequest.parse(request.body);
    const user = await acceptInvite(body.token, body.fullName, body.password);

    await audit(
      { ...SYSTEM_ACTOR, ip: request.ip, tenantId: user.tenantId },
      { action: 'USER_UPDATED', resourceType: 'USER', resourceId: user.id, changes: { invitedAccepted: true } },
    );

    return reply.send(user);
  });
}
