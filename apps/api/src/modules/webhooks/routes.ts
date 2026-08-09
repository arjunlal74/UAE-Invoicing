import type { FastifyInstance } from 'fastify';
import { logger } from '../../logger.js';
import { jsonb, withPlatformAccess } from '../../db/client.js';
import { getDriver } from '../asp/driver.js';
import { loadTenantAspConfigUnchecked } from '../asp/service.js';
import { applyStatusUpdate } from './applyStatus.js';

/**
 * Inbound clearance callbacks from the ASP.
 *
 * This endpoint is deliberately unauthenticated in the session sense — the
 * provider has no user account — and therefore reachable by anyone on the
 * internet. Its integrity rests entirely on the HMAC signature check below.
 * Without it, a stranger could mark invoices as cleared with the FTA.
 */
export function registerWebhookRoutes(app: FastifyInstance) {
  app.post(
    '/api/v1/webhooks/asp/:tenantId',
    {
      config: { rawBody: true },
      // The signature is computed over the exact bytes the provider sent.
      // Re-serialising a parsed object would change key order and whitespace
      // and break verification, so the raw text is captured here.
      preParsing: async (_request, _reply, payload) => payload,
    },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      const rawBody =
        typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {});

      const config = await loadTenantAspConfigUnchecked(tenantId);
      if (!config) {
        // Do not reveal whether the tenant exists.
        logger.warn({ tenantId }, 'webhook for unknown or unconfigured tenant');
        return reply.status(202).send({ received: true });
      }

      const driver = getDriver(config.providerType);
      const signatureOk = driver.verifyWebhookSignature(request.headers, rawBody, config);

      if (!signatureOk) {
        logger.warn({ tenantId }, 'webhook signature verification failed');
        await recordDelivery(tenantId, config.providerType, `unsigned:${Date.now()}`, rawBody, false, 'signature invalid');
        return reply.status(401).send({ error: { code: 'INVALID_SIGNATURE' } });
      }

      let event;
      try {
        event = driver.parseWebhook(rawBody, request.headers);
      } catch (err) {
        logger.error({ err, tenantId }, 'could not parse webhook body');
        return reply.status(400).send({ error: { code: 'MALFORMED_PAYLOAD' } });
      }

      // Providers retry deliveries; processing one twice must be harmless.
      const isNew = await recordDelivery(
        tenantId,
        config.providerType,
        event.deliveryId,
        rawBody,
        true,
        null,
      );
      if (!isNew) {
        return reply.status(200).send({ received: true, duplicate: true });
      }

      const result = await applyStatusUpdate({
        tenantId,
        transmissionReference: event.transmissionReference,
        peppolUuid: event.peppolUuid,
        invoiceNumber: event.invoiceNumber,
        verdict: event.status,
        reason: event.reason,
        ruleCode: event.ruleCode,
        receipt: event.receipt,
        source: 'webhook',
      });

      await withPlatformAccess(
        (tx) => tx`
          UPDATE webhook_deliveries
          SET processed_at = CURRENT_TIMESTAMP,
              result = ${result.applied ? 'applied' : (result.reason ?? 'ignored')}
          WHERE provider = ${config.providerType} AND delivery_id = ${event.deliveryId}
        `,
      );

      // 200 regardless of whether the update changed anything: a non-2xx makes
      // the provider retry a delivery we have already understood.
      return reply.status(200).send({ received: true, applied: result.applied });
    },
  );
}

/** Returns true when this delivery has not been seen before. */
async function recordDelivery(
  tenantId: string,
  provider: string,
  deliveryId: string,
  payload: string,
  signatureOk: boolean,
  result: string | null,
): Promise<boolean> {
  return withPlatformAccess(async (tx) => {
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO webhook_deliveries (tenant_id, provider, delivery_id, payload, signature_ok, result)
      VALUES (
        ${tenantId}, ${provider}, ${deliveryId},
        ${jsonb(tx, safeJson(payload))}, ${signatureOk}, ${result}
      )
      ON CONFLICT (provider, delivery_id) DO NOTHING
      RETURNING id
    `;
    return inserted.length > 0;
  });
}

/**
 * Return the body as a value the driver can store as jsonb.
 * Must return an object, not a string: `sql.json("...")` would store a JSON
 * string scalar rather than the document.
 */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}
