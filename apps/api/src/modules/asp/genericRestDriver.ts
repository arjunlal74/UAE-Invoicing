import { createHmac } from 'node:crypto';
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
 * Driver for a real third-party ASP over REST.
 *
 * ⚠️ NO PROVIDER HAS BEEN SELECTED FOR THIS PROJECT YET.
 *
 * The request and response shapes below follow the illustrative contracts in
 * the SRS. Those are examples of the *form* such an API takes, not any actual
 * vendor's documentation. Do not assume this works against a live provider —
 * when one is chosen, the three things to reconcile against their docs are:
 *
 *   1. Authentication — this assumes OAuth2 client credentials with a bearer
 *      token. Some providers use a static API key or mTLS instead.
 *   2. Payload envelope — this posts base64 XML inside a JSON wrapper. Some
 *      expect multipart, or raw XML with the metadata in headers.
 *   3. Status vocabulary — `mapStatus` below is the single place where their
 *      terminology is translated into ours.
 *
 * Until then the mock driver carries the pipeline end to end. This class is
 * wired in and reachable so that switching is a configuration change, and so
 * the shape of the work is visible rather than hypothetical.
 */

interface TokenCache {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenCache>();

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export class GenericRestAspDriver implements AspDriver {
  readonly providerType = 'GENERIC_REST' as const;

  private async accessToken(config: AspTenantConfig): Promise<string> {
    const { clientId, clientSecret, apiKey } = config.credentials;

    // A static API key needs no token exchange at all.
    if (apiKey) return apiKey;
    if (!clientId || !clientSecret) {
      throw new Error('ASP credentials are incomplete: expected an API key, or a client id and secret.');
    }

    const cached = tokenCache.get(config.configId);
    // Refresh a minute early so a token does not expire mid-flight.
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const response = await fetch(new URL('/oauth2/token', config.apiEndpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`ASP authentication failed with status ${response.status}`);
    }

    const body = (await response.json()) as { access_token: string; expires_in?: number };
    tokenCache.set(config.configId, {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3_600) * 1_000,
    });

    return body.access_token;
  }

  async submitInvoice(
    request: AspSubmissionRequest,
    config: AspTenantConfig,
  ): Promise<AspSubmissionOutcome> {
    if (!config.apiEndpoint) {
      return { kind: 'retryable', reason: 'No ASP endpoint is configured for this tenant.' };
    }

    let token: string;
    try {
      token = await this.accessToken(config);
    } catch (err) {
      // Credential problems are transient from the pipeline's point of view —
      // an administrator can fix the configuration and the retry will succeed.
      return { kind: 'retryable', reason: (err as Error).message, httpStatus: 401 };
    }

    const payload = {
      submission_id: request.idempotencyKey,
      tenant_metadata: {
        trn: request.sellerTrn,
        participant_id: request.sellerParticipantId,
        account_id: config.providerAccountId,
      },
      invoice_metadata: {
        peppol_uuid: request.peppolUuid,
        invoice_number: request.invoiceNumber,
        payable_amount: request.payableAmount,
        currency: request.currency,
        buyer_trn: request.buyerTrn,
      },
      payload: {
        mime_type: 'application/xml',
        encoding: 'base64',
        content_hash_sha256: request.ublSha256,
        ubl_xml: Buffer.from(request.ublXml, 'utf8').toString('base64'),
      },
    };

    try {
      const response = await fetch(new URL('/api/v1/invoices/submit', config.apiEndpoint), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          // Providers that honour this will collapse a duplicate retry into the
          // original submission rather than filing twice.
          'idempotency-key': request.idempotencyKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });

      const raw = await response.text();
      const parsed = safeJsonParse(raw);

      if (response.ok) {
        const reference =
          (parsed as { transmission_id?: string; submission_id?: string })?.transmission_id ??
          (parsed as { submission_id?: string })?.submission_id ??
          request.idempotencyKey;
        return {
          kind: 'accepted',
          transmissionReference: String(reference),
          httpStatus: response.status,
          raw: parsed,
        };
      }

      if (RETRYABLE_STATUSES.has(response.status)) {
        const retryAfter = Number(response.headers.get('retry-after'));
        return {
          kind: 'retryable',
          reason: `Provider returned ${response.status}`,
          httpStatus: response.status,
          retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1_000 : undefined,
          raw: parsed,
        };
      }

      // 4xx other than the retryable ones means the document itself is wrong.
      // Retrying an unchanged document against the same rules cannot help.
      const detail = (parsed as { error_details?: { code?: string; message?: string }[] })
        ?.error_details?.[0];
      return {
        kind: 'rejected',
        reason: detail?.message ?? `Provider rejected the invoice with status ${response.status}`,
        ruleCode: detail?.code,
        httpStatus: response.status,
        raw: parsed,
      };
    } catch (err) {
      // A timeout is the dangerous case: the provider may well have received
      // the document. The idempotency key is what makes the retry safe.
      logger.warn({ err, invoiceNumber: request.invoiceNumber }, 'ASP submission failed in transport');
      return { kind: 'retryable', reason: (err as Error).message };
    }
  }

  async getStatus(
    transmissionReference: string,
    config: AspTenantConfig,
  ): Promise<AspStatusOutcome> {
    try {
      const token = await this.accessToken(config);
      const response = await fetch(
        new URL(`/api/v1/invoices/status/${encodeURIComponent(transmissionReference)}`, config.apiEndpoint),
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        },
      );

      if (!response.ok) {
        return { kind: 'unknown', reason: `Provider returned ${response.status}` };
      }

      const body = (await response.json()) as {
        status?: string;
        cleared_at?: string;
        receipt?: string;
        error_details?: { code?: string; message?: string }[];
      };

      return this.mapStatus(body);
    } catch (err) {
      return { kind: 'unknown', reason: (err as Error).message };
    }
  }

  /** The one place a provider's status vocabulary is translated into ours. */
  private mapStatus(body: {
    status?: string;
    cleared_at?: string;
    receipt?: string;
    error_details?: { code?: string; message?: string }[];
  }): AspStatusOutcome {
    const status = (body.status ?? '').toUpperCase();

    if (['ACCEPTED', 'ACCEPTED_BY_FTA', 'CLEARED', 'DELIVERED'].includes(status)) {
      return {
        kind: 'accepted',
        clearedAt: body.cleared_at ?? new Date().toISOString(),
        receipt: body.receipt,
        raw: body,
      };
    }

    if (['REJECTED', 'REJECTED_BY_FTA', 'FAILED'].includes(status)) {
      const detail = body.error_details?.[0];
      return {
        kind: 'rejected',
        reason: detail?.message ?? 'Rejected by the tax authority.',
        ruleCode: detail?.code,
        raw: body,
      };
    }

    if (['PENDING', 'PROCESSING', 'IN_PROGRESS', 'SUBMITTED'].includes(status)) {
      return { kind: 'pending' };
    }

    return { kind: 'unknown', reason: `Unrecognised provider status '${body.status}'` };
  }

  verifyWebhookSignature(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
    config: AspTenantConfig,
  ): boolean {
    const secret = config.credentials.webhookSecret;
    if (!secret) return false;

    const header =
      headers['x-asp-signature'] ?? headers['x-signature'] ?? headers['x-hub-signature-256'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided) return false;

    // Accept either a bare hex digest or a `sha256=` prefixed one.
    const candidate = provided.startsWith('sha256=') ? provided.slice(7) : provided;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return safeEqual(candidate, expected);
  }

  parseWebhook(rawBody: string): AspWebhookEvent {
    const body = JSON.parse(rawBody) as {
      event_id?: string;
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
    const status = (data.status ?? '').toUpperCase();
    const error = data.error_details?.[0];

    return {
      deliveryId: body.event_id ?? `${data.transmission_id ?? 'unknown'}:${status}`,
      transmissionReference: data.transmission_id ?? null,
      peppolUuid: data.peppol_uuid ?? null,
      invoiceNumber: data.invoice_number ?? null,
      status: status.includes('ACCEPT')
        ? 'ACCEPTED'
        : status.includes('REJECT')
          ? 'REJECTED'
          : 'PENDING',
      reason: error?.message,
      ruleCode: error?.code,
      receipt: data.receipt,
      occurredAt: data.occurred_at,
    };
  }

  async testConnection(config: AspTenantConfig): Promise<{ ok: boolean; message: string }> {
    if (!config.apiEndpoint) {
      return { ok: false, message: 'No endpoint URL has been configured.' };
    }

    try {
      await this.accessToken(config);
      return { ok: true, message: 'Authenticated with the provider successfully.' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}
