import { parseApplicationResponse } from '@uae/ubl';
import type { FastifyInstance } from 'fastify';
import { logger } from '../../logger.js';
import { jsonb, withPlatformAccess } from '../../db/client.js';
import { sha256Hex } from '../../lib/crypto.js';
import { receivePurchaseInvoice } from '../ap/service.js';
import { getDriver } from '../asp/driver.js';
import { loadTenantAspConfigUnchecked } from '../asp/service.js';
import { applyBuyerResponse } from '../responses/service.js';
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

      // SRS v2.7 gives the same endpoint three jobs. A clearance verdict is one
      // of them; the other two arrive over the same signed channel and are
      // recognised here before the clearance parser is asked to make sense of
      // something that is not a clearance event at all.
      const kind = classify(rawBody);

      if (kind !== 'clearance') {
        const handled = await handleModuleEvent(tenantId, kind, rawBody, config.providerType);
        return reply.status(handled.status).send(handled.body);
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
        irn: event.irn,
        cryptographicStamp: event.cryptographicStamp,
        mlsStatus: event.mlsStatus,
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

// ===========================================================================
// SRS v2.7 — the two module event types
// ===========================================================================

type EventKind = 'clearance' | 'inbound-invoice' | 'invoice-response';

/**
 * Decide what a delivery is before trying to parse it.
 *
 * Providers vary in how they label events, so the classification looks at the
 * shape as well as the declared type: an ApplicationResponse and a UBL Invoice
 * are unmistakable from their root elements even when the envelope says
 * nothing useful.
 */
function classify(rawBody: string): EventKind {
  let declared = '';
  let payload = '';

  try {
    const parsed = JSON.parse(rawBody) as {
      event_type?: string;
      data?: { document_type?: string; ubl_xml?: string; response_xml?: string; document?: string };
    };
    declared = (parsed.event_type ?? parsed.data?.document_type ?? '').toUpperCase();
    payload = decodeDocument(parsed.data) ?? '';
  } catch {
    // Not JSON — some providers post the bare XML document.
    payload = rawBody;
  }

  if (declared.includes('RESPONSE') && !declared.includes('CLEARANCE')) return 'invoice-response';
  if (declared.includes('INBOUND') || declared.includes('PURCHASE')) return 'inbound-invoice';

  if (/<(\w+:)?ApplicationResponse[\s>]/.test(payload)) return 'invoice-response';
  if (/<(\w+:)?Invoice[\s>]/.test(payload)) return 'inbound-invoice';

  return 'clearance';
}

/** Pull the embedded document out of whichever field the provider used. */
function decodeDocument(data?: {
  ubl_xml?: string;
  response_xml?: string;
  document?: string;
}): string | null {
  const raw = data?.ubl_xml ?? data?.response_xml ?? data?.document;
  if (!raw) return null;
  // Base64 is the common envelope for XML inside JSON; a raw XML string is
  // equally common, so both are accepted rather than one being assumed.
  if (raw.trimStart().startsWith('<')) return raw;
  try {
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return raw;
  }
}

async function handleModuleEvent(
  tenantId: string,
  kind: Exclude<EventKind, 'clearance'>,
  rawBody: string,
  provider: string,
): Promise<{ status: number; body: unknown }> {
  const document = extractDocument(rawBody);
  if (!document) {
    logger.warn({ tenantId, kind }, 'module webhook carried no document');
    return { status: 400, body: { error: { code: 'MALFORMED_PAYLOAD' } } };
  }

  // De-duplicated on the document's own content. A provider that redelivers the
  // same purchase invoice must not create a second payable, and the reception
  // path's own idempotency check is a second line of defence rather than the
  // first.
  const deliveryId = `${kind}:${sha256Hex(document)}`;
  const isNew = await recordDelivery(tenantId, provider, deliveryId, rawBody, true, null);
  if (!isNew) return { status: 200, body: { received: true, duplicate: true } };

  try {
    if (kind === 'inbound-invoice') {
      const result = await receivePurchaseInvoice({
        tenantId,
        ublXml: document,
        ftaIrn: extractIrn(rawBody),
        source: 'webhook',
      });
      await markProcessed(provider, deliveryId, result.duplicate ? 'duplicate' : 'received');
      return { status: 200, body: { received: true, invoiceId: result.invoiceId } };
    }

    const parsed = parseApplicationResponse(document);
    if (!parsed.responseCode) {
      await markProcessed(provider, deliveryId, 'no response code');
      return { status: 200, body: { received: true, applied: false } };
    }

    const result = await applyBuyerResponse({
      tenantId,
      invoiceNumber: parsed.invoiceNumber,
      peppolUuid: parsed.invoicePeppolUuid,
      responseCode: parsed.responseCode,
      reasonCode: parsed.reasonCode,
      comments: parsed.description,
      rawXml: document,
      source: 'webhook',
    });

    await markProcessed(provider, deliveryId, result.applied ? 'applied' : (result.reason ?? 'ignored'));
    return { status: 200, body: { received: true, applied: result.applied } };
  } catch (err) {
    logger.error({ err, tenantId, kind }, 'module webhook processing failed');
    await markProcessed(provider, deliveryId, 'error');
    // 200 rather than 500: the delivery is recorded and a retry would only
    // produce the same failure. The operator finds it in the delivery log.
    return { status: 200, body: { received: true, applied: false } };
  }
}

function extractDocument(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as {
      data?: { ubl_xml?: string; response_xml?: string; document?: string };
    };
    return decodeDocument(parsed.data);
  } catch {
    return rawBody.trimStart().startsWith('<') ? rawBody : null;
  }
}

function extractIrn(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as { data?: { irn?: string; fta_irn?: string } };
    return parsed.data?.irn ?? parsed.data?.fta_irn ?? null;
  } catch {
    return null;
  }
}

async function markProcessed(provider: string, deliveryId: string, result: string): Promise<void> {
  await withPlatformAccess(
    (tx) => tx`
      UPDATE webhook_deliveries
      SET processed_at = CURRENT_TIMESTAMP, result = ${result}
      WHERE provider = ${provider} AND delivery_id = ${deliveryId}
    `,
  );
}
