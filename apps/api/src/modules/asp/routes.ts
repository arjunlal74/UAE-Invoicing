import { UpsertAspConfigRequest } from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { withPlatformAccess } from '../../db/client.js';
import { requireAuth, requireContext, requirePlatform } from '../../http/context.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { getDriver } from './driver.js';
import {
  decodeCredentials,
  encodeCredentials,
  toAspConfigResponse,
  webhookSecretHash,
  webhookUrlFor,
  type AspConfigRow,
} from './service.js';

export function registerAspRoutes(app: FastifyInstance) {
  // --- Platform: read a tenant's connection --------------------------------
  app.get(
    '/api/v1/admin/tenants/:id/asp-config',
    { preHandler: requirePlatform() },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const rows = await withPlatformAccess(
        (tx) => tx<AspConfigRow[]>`
          SELECT * FROM tenant_asp_configs WHERE tenant_id = ${id} AND is_active
        `,
      );

      if (!rows[0]) throw notFound('ASP configuration');
      return reply.send(toAspConfigResponse(rows[0]));
    },
  );

  // --- Platform: create or update ------------------------------------------
  app.put(
    '/api/v1/admin/tenants/:id/asp-config',
    { preHandler: requirePlatform() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      const body = UpsertAspConfigRequest.parse(request.body);

      if (body.status === 'ACTIVE' && body.providerType !== 'MOCK' && !body.apiEndpoint) {
        throw badRequest('An endpoint URL is required before this connection can be made active.');
      }

      const updated = await withPlatformAccess(async (tx) => {
        const existing = await tx<AspConfigRow[]>`
          SELECT * FROM tenant_asp_configs WHERE tenant_id = ${id} AND is_active FOR UPDATE
        `;
        const current = existing[0];
        if (!current) throw notFound('ASP configuration');

        // Credentials are merged, not replaced. The admin form cannot show the
        // existing secret, so an edit that changes only the endpoint sends no
        // credentials at all — overwriting would silently wipe them.
        let cipher = current.credentials_cipher;
        let secretHash: string | null = null;

        if (body.credentials && Object.values(body.credentials).some((v) => v)) {
          const merged = { ...decodeCredentials(current.credentials_cipher) };
          for (const [key, value] of Object.entries(body.credentials)) {
            if (value) merged[key as keyof typeof merged] = value;
          }
          cipher = encodeCredentials(merged);
          if (merged.webhookSecret) secretHash = webhookSecretHash(merged.webhookSecret);
        }

        await tx`
          UPDATE tenant_asp_configs SET
            provider_type       = ${body.providerType}::asp_provider_type,
            display_name        = ${body.displayName},
            api_endpoint        = ${body.apiEndpoint},
            credentials_cipher  = ${cipher},
            provider_account_id = ${body.providerAccountId ?? current.provider_account_id},
            webhook_secret_hash = ${secretHash ?? current.webhook_secret_hash},
            status              = ${body.status}::asp_connection_status,
            notes               = ${body.notes ?? current.notes}
          WHERE id = ${current.id}
        `;

        // A tenant whose provider connection is switched off must not keep
        // filing invoices; suspending them makes the consequence visible in the
        // admin list rather than surfacing as mysterious submission failures.
        if (body.status !== 'ACTIVE') {
          await tx`
            UPDATE tenants SET status = 'PENDING'
            WHERE id = ${id} AND status = 'ACTIVE'
          `;
        }

        const refreshed = await tx<AspConfigRow[]>`
          SELECT * FROM tenant_asp_configs WHERE id = ${current.id}
        `;
        return refreshed[0]!;
      });

      await audit(actorFromContext(ctx), {
        action: 'ASP_CONFIG_UPDATED',
        resourceType: 'ASP_CONFIG',
        resourceId: updated.id,
        tenantId: id,
        changes: {
          providerType: body.providerType,
          status: body.status,
          apiEndpoint: body.apiEndpoint,
          credentialsUpdated: Boolean(body.credentials && Object.values(body.credentials).some(Boolean)),
        },
      });

      return reply.send(toAspConfigResponse(updated));
    },
  );

  // --- Platform: test connection -------------------------------------------
  app.post(
    '/api/v1/admin/tenants/:id/asp-config/test',
    { preHandler: requirePlatform() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };

      const rows = await withPlatformAccess(
        (tx) => tx<AspConfigRow[]>`
          SELECT * FROM tenant_asp_configs WHERE tenant_id = ${id} AND is_active
        `,
      );
      const row = rows[0];
      if (!row) throw notFound('ASP configuration');

      const started = Date.now();
      let result: { ok: boolean; message: string };

      try {
        result = await getDriver(row.provider_type).testConnection({
          tenantId: row.tenant_id,
          configId: row.id,
          providerType: row.provider_type,
          displayName: row.display_name,
          apiEndpoint: row.api_endpoint,
          providerAccountId: row.provider_account_id,
          credentials: decodeCredentials(row.credentials_cipher),
        });
      } catch (err) {
        result = { ok: false, message: (err as Error).message };
      }

      const latencyMs = Date.now() - started;

      await withPlatformAccess(
        (tx) => tx`
          UPDATE tenant_asp_configs
          SET last_tested_at = CURRENT_TIMESTAMP, last_test_result = ${result.message}
          WHERE id = ${row.id}
        `,
      );

      await audit(actorFromContext(ctx), {
        action: 'ASP_CONNECTION_TESTED',
        resourceType: 'ASP_CONFIG',
        resourceId: row.id,
        tenantId: id,
        changes: { ok: result.ok, message: result.message },
      });

      return reply.send({ ...result, latencyMs });
    },
  );

  /**
   * Merchant-facing view of their own connection. Deliberately narrow: a
   * merchant needs to know whether they can submit and where to chase, not the
   * endpoint or account identifiers.
   */
  app.get('/api/v1/tenant/asp-status', { preHandler: requireAuth() }, async (request, reply) => {
    const ctx = requireContext(request);
    if (!ctx.tenantId) throw notFound('Tenant');

    const rows = await withPlatformAccess(
      (tx) => tx<AspConfigRow[]>`
        SELECT * FROM tenant_asp_configs WHERE tenant_id = ${ctx.tenantId} AND is_active
      `,
    );

    const row = rows[0];
    if (!row) {
      return reply.send({
        status: 'NOT_CONFIGURED',
        canSubmit: false,
        message: 'Your account is not yet connected to an accredited service provider.',
      });
    }

    const messages: Record<string, string> = {
      NOT_CONFIGURED: 'Your account is not yet connected to an accredited service provider.',
      PENDING_REGISTRATION:
        'Your registration with our network provider is in progress. You can upload and correct invoices now, but they cannot be submitted until this completes.',
      ACTIVE: 'Connected. Invoices can be submitted to the FTA.',
      DISABLED: 'Your provider connection has been disabled. Contact support.',
    };

    return reply.send({
      status: row.status,
      providerName: row.display_name,
      canSubmit: row.status === 'ACTIVE',
      message: messages[row.status] ?? '',
      webhookUrl: webhookUrlFor(ctx.tenantId),
    });
  });
}
