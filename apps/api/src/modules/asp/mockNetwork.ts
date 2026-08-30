import { createHmac, randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { withPlatformAccess } from '../../db/client.js';
import { logger } from '../../logger.js';
import { loadTenantAspConfigUnchecked } from './service.js';

/**
 * The other half of the simulated network (SRS v2.7 §12).
 *
 * `MockAspDriver` models one provider talking to one merchant: submit, clear,
 * call back. A real Peppol network has a second leg — the cleared document is
 * carried on to the buyer's access point, and the buyer's verdict is carried
 * back to the supplier's. Without that leg the AP module can only be reached by
 * pasting XML by hand, and a buyer's accept or reject dies in the driver, so
 * the dispute lifecycle that §11 and §12.3 describe cannot be exercised
 * end to end by anyone who has not scripted it themselves.
 *
 * This closes it, for the simulator only: when the counterparty of a document
 * is itself a tenant of this platform — matched on the TRN the document is
 * addressed to — the document is delivered to them over their own signed
 * webhook, exactly as a provider would deliver it.
 *
 * Delivery goes over HTTP rather than by calling the reception service
 * directly, so signature verification, replay de-duplication and the delivery
 * log all run. A shortcut here would leave those unexercised precisely on the
 * path most likely to be used in development.
 *
 * Nothing in here is reachable from a real provider driver. A production ASP
 * delivers to the buyer's real access point, which may belong to anybody.
 */

interface InvoiceDelivery {
  /** Who the document is addressed to. No TRN, no counterparty to find. */
  buyerTrn: string | null;
  /** Excluded from the search: a tenant does not post its own invoice to itself. */
  senderTenantId: string;
  ublXml: string;
  irn: string;
  invoiceNumber: string;
  /** Not before the verdict: an uncleared document has not been carried anywhere. */
  notBefore: number;
}

interface ResponseDelivery {
  /** The supplier the verdict is addressed to. */
  recipientTrn: string | null;
  senderTenantId: string;
  responseXml: string;
  invoiceNumber: string;
}

/** Carry a cleared invoice on to the buyer, if the buyer banks here too. */
export function deliverInvoiceToBuyer(delivery: InvoiceDelivery): void {
  const body = JSON.stringify({
    event_id: randomUUID(),
    event_type: 'INBOUND_PURCHASE_INVOICE',
    data: {
      document_type: 'INVOICE',
      ubl_xml: delivery.ublXml,
      irn: delivery.irn,
      invoice_number: delivery.invoiceNumber,
      occurred_at: new Date().toISOString(),
    },
  });

  schedule({
    trn: delivery.buyerTrn,
    senderTenantId: delivery.senderTenantId,
    body,
    delayMs: Math.max(1_000, delivery.notBefore - Date.now() + 1_000),
    what: `invoice ${delivery.invoiceNumber}`,
  });
}

/** Carry an ApplicationResponse back to the supplier, if the supplier banks here too. */
export function deliverResponseToSeller(delivery: ResponseDelivery): void {
  const body = JSON.stringify({
    event_id: randomUUID(),
    event_type: 'INVOICE_RESPONSE',
    data: {
      document_type: 'APPLICATION_RESPONSE',
      response_xml: delivery.responseXml,
      invoice_number: delivery.invoiceNumber,
      occurred_at: new Date().toISOString(),
    },
  });

  schedule({
    trn: delivery.recipientTrn,
    senderTenantId: delivery.senderTenantId,
    body,
    delayMs: 1_000,
    what: `response for ${delivery.invoiceNumber}`,
  });
}

interface ScheduledDelivery {
  trn: string | null;
  senderTenantId: string;
  body: string;
  delayMs: number;
  what: string;
}

/**
 * Fire and forget, on the same terms as the clearance callback: a delivery that
 * cannot be made is logged and dropped rather than failing the submission that
 * triggered it. The sender has done nothing wrong, and on a real network they
 * would never learn of it either.
 */
function schedule(delivery: ScheduledDelivery): void {
  if (!delivery.trn) return;

  const timer = setTimeout(() => {
    void deliver(delivery).catch((err) =>
      logger.warn({ err, what: delivery.what }, 'mock network delivery failed'),
    );
  }, delivery.delayMs);

  timer.unref?.();
}

async function deliver(delivery: ScheduledDelivery): Promise<void> {
  const recipientId = await findTenantByTrn(delivery.trn!, delivery.senderTenantId);
  if (!recipientId) {
    // The overwhelmingly common case: the counterparty is a real company that
    // is not a tenant here. Debug, not warn — it is not a fault.
    logger.debug({ what: delivery.what }, 'mock network: counterparty is not a tenant here');
    return;
  }

  const recipientConfig = await loadTenantAspConfigUnchecked(recipientId);
  const secret = recipientConfig?.credentials.webhookSecret;
  if (!secret) {
    logger.warn(
      { tenantId: recipientId, what: delivery.what },
      'mock network: recipient has no webhook secret; delivery dropped',
    );
    return;
  }

  const url = `${config().internalApiUrl}/api/v1/webhooks/asp/${recipientId}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-asp-signature': createHmac('sha256', secret).update(delivery.body).digest('hex'),
    },
    body: delivery.body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    logger.warn(
      { status: response.status, tenantId: recipientId, what: delivery.what },
      'mock network delivery was not accepted',
    );
    return;
  }

  logger.info({ tenantId: recipientId, what: delivery.what }, 'mock network delivered a document');
}

/**
 * The counterparty, by the TRN the document is addressed to.
 *
 * A VAT group shares one TRN across several tenants, so this can in principle
 * match more than one row; the oldest is chosen for stability rather than
 * delivering to whichever the planner happened to return first.
 */
async function findTenantByTrn(trn: string, excludeTenantId: string): Promise<string | null> {
  const rows = await withPlatformAccess(
    (tx) => tx<{ id: string }[]>`
      SELECT id FROM tenants
      WHERE trn = ${trn} AND id <> ${excludeTenantId}
      ORDER BY created_at
      LIMIT 1
    `,
  );
  return rows[0]?.id ?? null;
}
