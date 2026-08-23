import {
  MailAutodiscoverRequest,
  SendTestMailRequest,
  TestMailSettingsRequest,
  UpsertMailAccountRequest,
  can,
  type Role,
} from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { withPlatformAccess, type Tx } from '../../db/client.js';
import { requireContext, requirePlatform } from '../../http/context.js';
import { encryptSecret } from '../../lib/crypto.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { autodiscover } from '../../mail/autodiscover.js';
import { PROVIDERS } from '../../mail/providers.js';
import {
  findAccount,
  listAccounts,
  recentDeliveries,
  recordOutcome,
  recordQueued,
  sendThrough,
  settingsFromRow,
  toSummary,
  type MailAccountRow,
} from '../../mail/service.js';
import { renderTest } from '../../mail/templates.js';
import { verifySmtp } from '../../mail/transport.js';

/**
 * Outgoing mail configuration.
 *
 * Reading is open to any platform role, changing is not: these settings hold
 * the credential for a mailbox that speaks for the whole platform, and whoever
 * can change the sending address can send convincing invitations to themselves.
 */

function requireManage(role: Role) {
  if (!can(role, 'platform.manage')) {
    throw forbidden('Only a global administrator can change mail settings.');
  }
}

/**
 * Clear the current default within the caller transaction.
 *
 * The partial unique index rejects a second default outright, so the old one
 * has to go first rather than the insert being left to sort itself out.
 */
async function clearDefault(tx: Tx): Promise<void> {
  await tx`UPDATE mail_accounts SET is_default = FALSE WHERE is_default`;
}

export function registerMailRoutes(app: FastifyInstance) {
  app.get('/api/v1/admin/mail/accounts', { preHandler: requirePlatform() }, async (_req, reply) => {
    const rows = await listAccounts();
    return reply.send({ items: rows.map(toSummary) });
  });

  app.get('/api/v1/admin/mail/providers', { preHandler: requirePlatform() }, async (_req, reply) =>
    reply.send({
      items: PROVIDERS.map((p) => ({
        key: p.providerKey,
        label: p.label,
        host: p.host,
        port: p.port,
        encryption: p.encryption,
        note: p.note ?? null,
      })),
    }),
  );

  // --- Auto account setup ---------------------------------------------------
  app.post(
    '/api/v1/admin/mail/autodiscover',
    { preHandler: requirePlatform() },
    async (request, reply) => {
      const ctx = requireContext(request);
      requireManage(ctx.role);

      const body = MailAutodiscoverRequest.parse(request.body);
      return reply.send(await autodiscover(body.email, body.password));
    },
  );

  // --- Test settings that have not been saved yet ---------------------------
  app.post(
    '/api/v1/admin/mail/test-settings',
    { preHandler: requirePlatform() },
    async (request, reply) => {
      const ctx = requireContext(request);
      requireManage(ctx.role);

      const body = TestMailSettingsRequest.parse(request.body);

      // An edit that does not retype the password still has to be testable, so
      // a blank password on a known account falls back to the stored one.
      let password = body.password ?? '';
      if (!password && body.accountId) {
        const existing = await findAccount(body.accountId);
        if (existing) password = settingsFromRow(existing).password ?? '';
      }

      return reply.send(
        await verifySmtp({
          host: body.host,
          port: body.port,
          encryption: body.encryption,
          authRequired: body.authRequired,
          username: body.username ?? null,
          password,
        }),
      );
    },
  );

  // --- Create ---------------------------------------------------------------
  app.post(
    '/api/v1/admin/mail/accounts',
    { preHandler: requirePlatform() },
    async (request, reply) => {
      const ctx = requireContext(request);
      requireManage(ctx.role);

      const body = UpsertMailAccountRequest.parse(request.body);
      if (body.authRequired && !body.username) {
        throw badRequest('A user name is required when the server needs authentication.');
      }

      const row = await withPlatformAccess(async (tx) => {
        if (body.makeDefault) await clearDefault(tx);

        const rows = await tx<MailAccountRow[]>`
          INSERT INTO mail_accounts (
            display_name, from_address, reply_to, smtp_host, smtp_port, encryption,
            auth_required, username, password_cipher, provider_key, is_default, is_active
          ) VALUES (
            ${body.displayName}, ${body.fromAddress}, ${body.replyTo || null},
            ${body.host}, ${body.port}, ${body.encryption}::mail_encryption,
            ${body.authRequired}, ${body.authRequired ? (body.username ?? null) : null},
            ${body.password ? encryptSecret(body.password) : null},
            ${body.providerKey ?? null}, ${body.makeDefault}, ${body.isActive}
          )
          RETURNING *
        `;
        return rows[0]!;
      });

      await audit(actorFromContext(ctx), {
        action: 'MAIL_ACCOUNT_SAVED',
        resourceType: 'MAIL_ACCOUNT',
        resourceId: row.id,
        changes: { fromAddress: body.fromAddress, host: body.host, port: body.port, created: true },
      });

      return reply.status(201).send(toSummary(row));
    },
  );

  // --- Update ---------------------------------------------------------------
  app.put(
    '/api/v1/admin/mail/accounts/:id',
    { preHandler: requirePlatform() },
    async (request, reply) => {
      const ctx = requireContext(request);
      requireManage(ctx.role);

      const { id } = request.params as { id: string };
      const body = UpsertMailAccountRequest.parse(request.body);
      if (body.authRequired && !body.username) {
        throw badRequest('A user name is required when the server needs authentication.');
      }

      const row = await withPlatformAccess(async (tx) => {
        const existing = await tx<MailAccountRow[]>`
          SELECT * FROM mail_accounts WHERE id = ${id} FOR UPDATE
        `;
        const current = existing[0];
        if (!current) throw notFound('Mail account');

        // The form cannot show the stored password, so an edit that changes
        // only the port sends no password field at all. Absent means keep it;
        // present but empty means the administrator cleared it deliberately.
        const cipher =
          body.password === undefined
            ? current.password_cipher
            : body.password === ''
              ? null
              : encryptSecret(body.password);

        if (body.makeDefault) await clearDefault(tx);

        const updated = await tx<MailAccountRow[]>`
          UPDATE mail_accounts SET
            display_name    = ${body.displayName},
            from_address    = ${body.fromAddress},
            reply_to        = ${body.replyTo || null},
            smtp_host       = ${body.host},
            smtp_port       = ${body.port},
            encryption      = ${body.encryption}::mail_encryption,
            auth_required   = ${body.authRequired},
            username        = ${body.authRequired ? (body.username ?? null) : null},
            password_cipher = ${body.authRequired ? cipher : null},
            provider_key    = ${body.providerKey ?? current.provider_key},
            is_default      = ${body.makeDefault ? true : current.is_default},
            is_active       = ${body.isActive}
          WHERE id = ${id}
          RETURNING *
        `;
        return updated[0]!;
      });

      await audit(actorFromContext(ctx), {
        action: 'MAIL_ACCOUNT_SAVED',
        resourceType: 'MAIL_ACCOUNT',
        resourceId: id,
        changes: {
          fromAddress: body.fromAddress,
          host: body.host,
          port: body.port,
          passwordChanged: body.password !== undefined,
        },
      });

      return reply.send(toSummary(row));
    },
  );

  // --- Make default ---------------------------------------------------------
  app.post(
    '/api/v1/admin/mail/accounts/:id/default',
    { preHandler: requirePlatform() },
    async (request, reply) => {
      const ctx = requireContext(request);
      requireManage(ctx.role);
      const { id } = request.params as { id: string };

      const row = await withPlatformAccess(async (tx) => {
        await clearDefault(tx);
        const rows = await tx<MailAccountRow[]>`
          UPDATE mail_accounts SET is_default = TRUE, is_active = TRUE
          WHERE id = ${id} RETURNING *
        `;
        if (!rows[0]) throw notFound('Mail account');
        return rows[0];
      });

      return reply.send(toSummary(row));
    },
  );

  // --- Delete ---------------------------------------------------------------
  app.delete(
    '/api/v1/admin/mail/accounts/:id',
    { preHandler: requirePlatform() },
    async (request, reply) => {
      const ctx = requireContext(request);
      requireManage(ctx.role);
      const { id } = request.params as { id: string };

      const rows = await withPlatformAccess(
        (tx) => tx<{ id: string; from_address: string }[]>`
          DELETE FROM mail_accounts WHERE id = ${id} RETURNING id, from_address
        `,
      );
      if (!rows[0]) throw notFound('Mail account');

      await audit(actorFromContext(ctx), {
        action: 'MAIL_ACCOUNT_DELETED',
        resourceType: 'MAIL_ACCOUNT',
        resourceId: id,
        changes: { fromAddress: rows[0].from_address },
      });

      return reply.status(204).send();
    },
  );

  // --- Send a real message --------------------------------------------------
  app.post(
    '/api/v1/admin/mail/accounts/:id/send-test',
    { preHandler: requirePlatform() },
    async (request, reply) => {
      const ctx = requireContext(request);
      requireManage(ctx.role);

      const { id } = request.params as { id: string };
      const body = SendTestMailRequest.parse(request.body);

      const account = await findAccount(id);
      if (!account) throw notFound('Mail account');

      const message = renderTest({
        sentBy: ctx.email ?? 'an administrator',
        host: account.smtp_host,
      });

      const deliveryId = await recordQueued({
        kind: 'TEST',
        to: body.to,
        subject: message.subject,
        accountId: account.id,
      });

      // Sent inline rather than queued: the administrator is waiting for the
      // answer, and a queued job could only report that it had been accepted
      // onto the queue, which is not the question being asked.
      const result = await sendThrough(account, body.to, message);
      await recordOutcome(deliveryId, result);

      await withPlatformAccess(
        (tx) => tx`
          UPDATE mail_accounts
          SET last_tested_at = CURRENT_TIMESTAMP, last_test_ok = ${result.ok},
              last_test_result = ${result.message}
          WHERE id = ${account.id}
        `,
      );

      await audit(actorFromContext(ctx), {
        action: 'MAIL_ACCOUNT_TESTED',
        resourceType: 'MAIL_ACCOUNT',
        resourceId: account.id,
        changes: { to: body.to, ok: result.ok },
      });

      return reply.send(result);
    },
  );

  // --- Delivery log ---------------------------------------------------------
  app.get(
    '/api/v1/admin/mail/deliveries',
    { preHandler: requirePlatform() },
    async (_req, reply) => {
      const rows = await recentDeliveries(50);
      return reply.send({
        items: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          toAddress: row.to_address,
          subject: row.subject,
          status: row.status,
          error: row.error,
          createdAt: row.created_at.toISOString(),
          sentAt: row.sent_at?.toISOString() ?? null,
        })),
      });
    },
  );
}
