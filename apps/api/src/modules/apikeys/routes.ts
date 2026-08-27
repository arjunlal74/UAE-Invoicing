import { API_KEY_SCOPES, CreateApiKeyRequest, type CreatedApiKey } from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import {
  API_KEY_SELECT,
  generateToken,
  listKeys,
  toApiKeySummary,
  validateScopes,
  type ApiKeyRow,
} from '../../auth/apiKeys.js';
import { actorFromContext, audit } from '../../audit/audit.js';
import { withPlatformAccess, withTenant } from '../../db/client.js';
import { requireContext, requirePermission } from '../../http/context.js';
import { badRequest, notFound } from '../../lib/errors.js';

/**
 * Managing the credentials for ingestion channel 1.
 *
 * Reserved to `tenant.users.manage` — the same permission that governs who may
 * invite a colleague. Minting an API key is handing out an identity that can
 * file tax documents; it belongs with the other identity decisions rather than
 * with the invoicing ones, which is why an accountant who can compose invoices
 * all day cannot create a key that does it unattended.
 */

export function registerApiKeyRoutes(app: FastifyInstance) {
  // --- What may be granted -------------------------------------------------
  app.get(
    '/api/v1/api-keys/scopes',
    { preHandler: requirePermission('tenant.users.manage') },
    async (_request, reply) => reply.send({ scopes: API_KEY_SCOPES }),
  );

  // --- List ----------------------------------------------------------------
  app.get(
    '/api/v1/api-keys',
    { preHandler: requirePermission('tenant.users.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const rows = await withTenant(ctx.tenantId, (tx) => listKeys(tx, ctx.tenantId!));
      return reply.send({ items: rows.map(toApiKeySummary) });
    },
  );

  // --- Create --------------------------------------------------------------
  app.post(
    '/api/v1/api-keys',
    { preHandler: requirePermission('tenant.users.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const body = CreateApiKeyRequest.parse(request.body);
      const scopes = validateScopes(body.scopes);

      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
      if (expiresAt && expiresAt.getTime() <= Date.now()) {
        throw badRequest('An expiry in the past would create a key that never works.');
      }

      const { token, tokenHash, keyPrefix } = generateToken();
      const sftpUsername = body.sftpUsername ?? null;

      // Checked with platform access, deliberately: the name is a filesystem
      // path segment in a namespace shared by the whole platform, so the
      // collision it can have is with *another tenant's* directory — which a
      // tenant-scoped read cannot see. The unique index is still the authority;
      // this exists so the answer is a sentence rather than a constraint name.
      if (sftpUsername) {
        const taken = await withPlatformAccess(
          (tx) => tx<{ id: string }[]>`
            SELECT id FROM api_keys WHERE sftp_username = ${sftpUsername}
          `,
        );
        if (taken[0]) {
          throw badRequest(
            `The SFTP account name "${sftpUsername}" is already in use. Choose another.`,
          );
        }
      }

      const row = await withTenant(ctx.tenantId, async (tx) => {
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO api_keys (
            tenant_id, name, key_prefix, token_hash, scopes, created_by_user_id,
            expires_at, sftp_username
          ) VALUES (
            ${ctx.tenantId}, ${body.name}, ${keyPrefix}, ${tokenHash},
            ${scopes}::text[], ${ctx.userId}, ${expiresAt}, ${sftpUsername}
          )
          RETURNING id
        `;

        const rows = await tx.unsafe<ApiKeyRow[]>(
          `SELECT ${API_KEY_SELECT} FROM api_keys k WHERE k.id = $1`,
          [inserted[0]!.id],
        );
        return rows[0]!;
      });

      await audit(actorFromContext(ctx), {
        action: 'API_KEY_CREATED',
        resourceType: 'API_KEY',
        resourceId: row.id,
        tenantId: ctx.tenantId,
        changes: {
          name: body.name,
          keyPrefix,
          scopes,
          expiresAt: body.expiresAt ?? null,
          sftpUsername,
        },
      });

      // The one and only time the token exists outside the caller's own
      // records. Nothing recoverable is stored, so a lost key is replaced
      // rather than looked up — which is the property that makes the hash in
      // the database worth having.
      const response: CreatedApiKey = { key: toApiKeySummary(row), token };
      return reply.status(201).send(response);
    },
  );

  // --- Revoke --------------------------------------------------------------
  /**
   * Revocation is a timestamp, not a delete.
   *
   * The row is the answer to "what was this key allowed to do, and when did we
   * take it away" — a question asked precisely when something has gone wrong.
   * Deleting it would remove the evidence at the moment it becomes evidence,
   * and the database refuses the DELETE anyway (migration 0007).
   */
  app.post(
    '/api/v1/api-keys/:id/revoke',
    { preHandler: requirePermission('tenant.users.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const row = await withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx<
          { id: string; name: string; sftp_username: string | null; revoked_at: Date | null }[]
        >`
          SELECT id, name, sftp_username, revoked_at FROM api_keys
          WHERE id = ${id} AND tenant_id = ${ctx.tenantId}
        `;
        const key = rows[0];
        if (!key) throw notFound('API key');
        if (key.revoked_at) return key;

        // The drop directory belongs to the SFTP account, not to the key — the
        // account on the server keeps its name, and the replacement key has to
        // be able to take it. Holding the name on a revoked key would make
        // "revoke and re-issue" the one operation that permanently burns an
        // account name, which is precisely the operation you perform in a hurry
        // when a credential has leaked.
        await tx`
          UPDATE api_keys
          SET revoked_at = now(),
              revoked_by_user_id = ${ctx.userId},
              sftp_username = NULL
          WHERE id = ${id}
        `;
        return key;
      });

      await audit(actorFromContext(ctx), {
        action: 'API_KEY_REVOKED',
        resourceType: 'API_KEY',
        resourceId: id,
        tenantId: ctx.tenantId,
        // The released name is recorded here because the column no longer
        // holds it: the audit trail is now the only place that says which
        // directory this key used to own.
        changes: { name: row.name, releasedSftpUsername: row.sftp_username },
      });

      return reply.send({ revoked: true });
    },
  );
}
