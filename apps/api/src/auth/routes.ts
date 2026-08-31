import {
  AcceptInviteRequest,
  ChangePasswordRequest,
  ForgotPasswordRequest,
  LoginRequest,
  MfaEnrolConfirmRequest,
  RefreshRequest,
  ResetPasswordRequest,
} from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { SYSTEM_ACTOR, audit, actorFromContext } from '../audit/audit.js';
import { sql } from '../db/client.js';
import { requireAuth, requireContext } from '../http/context.js';
import { notFound } from '../lib/errors.js';
import {
  SESSION_USER_COLUMNS,
  acceptInvite,
  changePassword,
  checkResetToken,
  confirmMfaEnrolment,
  disableMfa,
  liveCustodyScope,
  login,
  refreshSession,
  requestPasswordReset,
  resetPassword,
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

    const rows = await sql().unsafe<any[]>(
      `SELECT ${SESSION_USER_COLUMNS}
       FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1`,
      [ctx.userId],
    );

    if (!rows[0]) throw notFound('Account');

    // A custody session must describe itself the same way here as it did when
    // it was issued (§3): this row is the partner's staff member, whose own
    // tenant is the partner, so without the overlay the portal would be told it
    // is in the partner's console while every other request it makes is scoped
    // to the client's books.
    const custody = ctx.actingForTenantId && ctx.tenantId
      ? await liveCustodyScope(ctx.userId, ctx.tenantId)
      : null;

    return reply.send(toSessionUser(rows[0], custody ?? undefined));
  });

  app.post('/api/v1/auth/change-password', { preHandler: requireAuth() }, async (request, reply) => {
    const ctx = requireContext(request);
    const body = ChangePasswordRequest.parse(request.body);

    await changePassword(ctx.userId, body.currentPassword, body.newPassword, {
      ip: request.ip,
      signOutOtherDevices: body.signOutOtherDevices,
      currentRefreshToken: body.currentRefreshToken,
    });
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

  // --- Credential recovery (SRS v2.3 §4.1) ---------------------------------

  /**
   * Always answers the same way.
   *
   * §4.1 step 2 forbids revealing whether an address is registered, so there is
   * no error branch here to leak one: an unknown address, a deactivated account
   * and a rate-limited caller all receive this response.
   */
  app.post('/api/v1/auth/forgot-password', async (request, reply) => {
    const body = ForgotPasswordRequest.parse(request.body);
    await requestPasswordReset(body.email, request.ip);

    return reply.send({
      message:
        'If an active account is associated with this email address, a password reset link has been dispatched.',
    });
  });

  /** Lets the reset screen say "this link expired" before asking for a password. */
  app.get('/api/v1/auth/reset-password', async (request, reply) => {
    const { token } = request.query as { token?: string };
    if (!token) return reply.send({ valid: false, email: null, message: 'No link was supplied.' });

    return reply.send(await checkResetToken(token));
  });

  app.post('/api/v1/auth/reset-password', async (request, reply) => {
    const body = ResetPasswordRequest.parse(request.body);
    await resetPassword(body.token, body.password, request.ip);

    await audit(
      { ...SYSTEM_ACTOR, ip: request.ip },
      { action: 'PASSWORD_RESET', resourceType: 'USER', changes: { via: 'self-service link' } },
    );

    return reply.send({
      message: 'Your password has been changed. Sign in with your new password.',
    });
  });

  // Unauthenticated by design — the invite token is the credential.
  app.post('/api/v1/auth/accept-invite', async (request, reply) => {
    const body = AcceptInviteRequest.parse(request.body);
    const user = await acceptInvite(body.token, body.fullName, body.password, request.ip);

    await audit(
      { ...SYSTEM_ACTOR, ip: request.ip, tenantId: user.tenantId },
      { action: 'USER_UPDATED', resourceType: 'USER', resourceId: user.id, changes: { invitedAccepted: true } },
    );

    return reply.send(user);
  });
}
