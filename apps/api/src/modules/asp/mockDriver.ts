import { createHmac, randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { safeEqual } from '../../lib/crypto.js';
import { logger } from '../../logger.js';
import type {
  AspDriver,
  AspStatusOutcome,
  AspSubmissionOutcome,
  AspSubmissionRequest,
  AspTenantConfig,
  AspWebhookEvent,
} from './driver.js';

/**
 * A simulated Accredited Service Provider.
 *
 * No provider has been selected for this project yet, so this driver stands in
 * for one. It is not a stub that returns success — it models the behaviour that
 * actually breaks integrations:
 *
 *   - a two-stage lifecycle (immediate acknowledgement, verdict later)
 *   - a share of rejections carrying real UAE rule codes
 *   - occasional transient failures, to exercise retry and dead-lettering
 *   - HMAC-signed webhooks, so signature verification is real code that runs
 *   - idempotency by key, so a retried submission is not filed twice
 *
 * Deterministic where it matters: the accept/reject decision is derived from a
 * hash of the idempotency key, so retrying the same invoice yields the same
 * verdict rather than eventually passing by luck.
 */

interface MockRecord {
  reference: string;
  invoiceNumber: string;
  peppolUuid: string;
  verdict: 'accepted' | 'rejected';
  reason?: string;
  ruleCode?: string;
  availableAt: number;
  idempotencyKey: string;
}

/**
 * In-memory provider state. Lost on restart, which is correct for a simulator —
 * anything that must survive a restart lives in our own database.
 */
const submissions = new Map<string, MockRecord>();
const byIdempotencyKey = new Map<string, string>();

const REJECTION_SCENARIOS = [
  {
    ruleCode: 'BR-UAE-08',
    reason: 'The Tax Registration Number (TRN) of the buyer is not registered for VAT.',
  },
  {
    ruleCode: 'BR-UAE-05',
    reason: 'The sum of line amounts does not equal the payable amount on the document.',
  },
  {
    ruleCode: 'BR-UAE-17',
    reason: 'The invoice issue date falls outside the permitted reporting window.',
  },
  {
    ruleCode: 'PEPPOL-AE-R001',
    reason: 'No participant is registered on the network for the recipient identifier.',
  },
];

function hashToUnitInterval(input: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 0xff_ff_ff_ff;
}

export class MockAspDriver implements AspDriver {
  readonly providerType = 'MOCK' as const;

  async submitInvoice(
    request: AspSubmissionRequest,
    tenantConfig: AspTenantConfig,
  ): Promise<AspSubmissionOutcome> {
    const cfg = config();

    // Idempotency: the same key always returns the original reference. This is
    // what stops a network timeout followed by a retry from filing twice.
    const existingRef = byIdempotencyKey.get(request.idempotencyKey);
    if (existingRef) {
      return { kind: 'accepted', transmissionReference: existingRef, httpStatus: 200 };
    }

    await new Promise((resolve) => setTimeout(resolve, Math.min(cfg.ASP_MOCK_LATENCY_MS, 3_000)));

    const roll = hashToUnitInterval(request.idempotencyKey);

    // A small slice of attempts fail transiently, so the retry path is exercised
    // in development rather than first meeting reality in production.
    if (roll > 0.97) {
      return {
        kind: 'retryable',
        reason: 'Simulated provider timeout',
        httpStatus: 504,
        retryAfterMs: 30_000,
      };
    }

    const reference = `mock_tx_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const rejected = roll < cfg.ASP_MOCK_REJECT_RATE;
    const scenario = REJECTION_SCENARIOS[Math.floor(roll * 1000) % REJECTION_SCENARIOS.length]!;

    const record: MockRecord = {
      reference,
      invoiceNumber: request.invoiceNumber,
      peppolUuid: request.peppolUuid,
      verdict: rejected ? 'rejected' : 'accepted',
      reason: rejected ? scenario.reason : undefined,
      ruleCode: rejected ? scenario.ruleCode : undefined,
      // The verdict is not available immediately — that asynchrony is the whole
      // reason the status polling and webhook paths exist.
      availableAt: Date.now() + cfg.ASP_MOCK_LATENCY_MS * 2,
      idempotencyKey: request.idempotencyKey,
    };

    submissions.set(reference, record);
    byIdempotencyKey.set(request.idempotencyKey, reference);

    this.scheduleCallback(record, tenantConfig);

    return { kind: 'accepted', transmissionReference: reference, httpStatus: 202 };
  }

  /**
   * Deliver the verdict back over HTTP, exactly as a real provider would.
   *
   * A simulator that only answered `getStatus` would leave the inbound webhook
   * route — signature verification, replay de-duplication, out-of-order
   * protection — completely unexercised until the day a real provider is
   * connected. Posting a genuinely signed callback means that path runs on
   * every development submission.
   *
   * Failures are swallowed and logged: if the callback cannot be delivered the
   * polling sweeper still resolves the invoice, which is precisely the
   * belt-and-braces behaviour being modelled.
   */
  private scheduleCallback(record: MockRecord, tenantConfig: AspTenantConfig): void {
    const secret = tenantConfig.credentials.webhookSecret;
    if (!secret) {
      logger.warn(
        { tenantId: tenantConfig.tenantId },
        'mock provider has no webhook secret configured; verdict will arrive via polling only',
      );
      return;
    }

    const delay = Math.max(500, record.availableAt - Date.now() + 250);
    // The INTERNAL address: this callback is a loopback within the deployment,
    // so it must not depend on the public URL being reachable from in here.
    const url = `${config().internalApiUrl}/api/v1/webhooks/asp/${tenantConfig.tenantId}`;

    const timer = setTimeout(() => {
      const body = buildMockWebhookBody(
        record,
        record.verdict === 'accepted' ? 'ACCEPTED' : 'REJECTED',
        record.verdict === 'rejected'
          ? { code: record.ruleCode ?? 'ASP-REJECTION', message: record.reason ?? 'Rejected' }
          : undefined,
      );

      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-asp-signature': signMockWebhook(secret, body),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      })
        .then((response) => {
          if (!response.ok) {
            logger.warn(
              { status: response.status, reference: record.reference },
              'mock provider callback was not accepted',
            );
          }
        })
        .catch((err) => {
          logger.warn({ err, reference: record.reference }, 'mock provider callback failed');
        });
    }, delay);

    // Must not keep the worker process alive on shutdown.
    timer.unref?.();
  }

  async getStatus(
    transmissionReference: string,
    _config: AspTenantConfig,
  ): Promise<AspStatusOutcome> {
    const record = submissions.get(transmissionReference);
    if (!record) {
      return { kind: 'unknown', reason: 'The provider has no record of this transmission.' };
    }
    if (Date.now() < record.availableAt) return { kind: 'pending' };

    if (record.verdict === 'accepted') {
      return {
        kind: 'accepted',
        clearedAt: new Date(record.availableAt).toISOString(),
        receipt: this.buildReceipt(record),
      };
    }

    return { kind: 'rejected', reason: record.reason ?? 'Rejected', ruleCode: record.ruleCode };
  }

  /**
   * The signed AS4 receipt is the non-repudiation evidence — legal proof the
   * document was delivered and acknowledged. Archived to WORM storage.
   */
  private buildReceipt(record: MockRecord): string {
    return JSON.stringify(
      {
        receiptType: 'NON_REPUDIATION_OF_RECEIPT',
        transmissionReference: record.reference,
        peppolUuid: record.peppolUuid,
        invoiceNumber: record.invoiceNumber,
        acknowledgedAt: new Date(record.availableAt).toISOString(),
        signature: {
          algorithm: 'RSA-SHA256',
          value: createHmac('sha256', 'mock-provider-key').update(record.reference).digest('base64'),
          note: 'Simulated. A real provider returns a signed AS4 receipt here.',
        },
      },
      null,
      2,
    );
  }

  verifyWebhookSignature(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
    tenantConfig: AspTenantConfig,
  ): boolean {
    const provided = headers['x-asp-signature'];
    const signature = Array.isArray(provided) ? provided[0] : provided;
    if (!signature) return false;

    const secret = tenantConfig.credentials.webhookSecret;
    if (!secret) return false;

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return safeEqual(signature, expected);
  }

  parseWebhook(rawBody: string): AspWebhookEvent {
    const body = JSON.parse(rawBody) as {
      event_id?: string;
      event_type?: string;
      data?: {
        transmission_id?: string;
        peppol_uuid?: string;
        invoice_number?: string;
        status?: string;
        receipt?: string;
        occurred_at?: string;
        error_details?: { code?: string; message?: string }[];
      };
    };

    const data = body.data ?? {};
    const error = data.error_details?.[0];
    const status =
      data.status === 'ACCEPTED_BY_FTA'
        ? 'ACCEPTED'
        : data.status === 'REJECTED_BY_FTA'
          ? 'REJECTED'
          : 'PENDING';

    return {
      // Without a stable delivery id a replayed webhook cannot be recognised
      // as a duplicate, so fall back to the transmission reference plus status.
      deliveryId: body.event_id ?? `${data.transmission_id ?? 'unknown'}:${data.status ?? 'unknown'}`,
      transmissionReference: data.transmission_id ?? null,
      peppolUuid: data.peppol_uuid ?? null,
      invoiceNumber: data.invoice_number ?? null,
      status,
      reason: error?.message,
      ruleCode: error?.code,
      receipt: data.receipt,
      occurredAt: data.occurred_at,
    };
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    return {
      ok: true,
      message:
        'Connected to the simulated provider. Invoices will complete the full pipeline without leaving this system.',
    };
  }
}

/** Build the webhook body the mock provider would post, used by the simulator. */
export function buildMockWebhookBody(
  record: { reference: string; peppolUuid: string; invoiceNumber: string },
  verdict: 'ACCEPTED' | 'REJECTED',
  detail?: { code: string; message: string },
): string {
  return JSON.stringify({
    event_id: randomUUID(),
    event_type: 'INVOICE_CLEARANCE_UPDATE',
    data: {
      transmission_id: record.reference,
      peppol_uuid: record.peppolUuid,
      invoice_number: record.invoiceNumber,
      status: verdict === 'ACCEPTED' ? 'ACCEPTED_BY_FTA' : 'REJECTED_BY_FTA',
      occurred_at: new Date().toISOString(),
      error_details: detail ? [detail] : undefined,
    },
  });
}

export function signMockWebhook(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}
