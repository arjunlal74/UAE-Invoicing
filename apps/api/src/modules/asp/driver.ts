/**
 * The ASP boundary.
 *
 * Phase 1 routes invoices through an accredited third party; Phase 2 replaces
 * that with our own AS4 gateway. Both live behind this one interface so the
 * switch is a driver registration, not a rewrite — and so that the entire
 * pipeline can be built and tested against a mock before any provider contract
 * is signed.
 */

export interface AspTenantConfig {
  tenantId: string;
  configId: string;
  providerType: 'MOCK' | 'GENERIC_REST' | 'NATIVE_AS4';
  displayName: string;
  apiEndpoint: string;
  providerAccountId: string | null;
  credentials: AspCredentials;
}

export interface AspCredentials {
  clientId?: string;
  clientSecret?: string;
  apiKey?: string;
  webhookSecret?: string;
}

export interface AspSubmissionRequest {
  /** Stable per-invoice key. Re-sending the same key must not file twice. */
  idempotencyKey: string;
  peppolUuid: string;
  invoiceNumber: string;
  sellerTrn: string;
  /**
   * The seller's Peppol address. Sent alongside the TRN because they are not
   * interchangeable: the TRN identifies the taxpayer, this routes the document.
   */
  sellerParticipantId: string | null;
  buyerTrn: string | null;
  payableAmount: string;
  currency: string;
  ublXml: string;
  ublSha256: string;
}

export type AspSubmissionOutcome =
  /** The provider has the document. A verdict follows asynchronously. */
  | { kind: 'accepted'; transmissionReference: string; httpStatus: number; raw?: unknown }
  /** The provider rejected it outright — malformed, or a rule it enforces itself. */
  | { kind: 'rejected'; reason: string; ruleCode?: string; httpStatus: number; raw?: unknown }
  /** Transient. The job should be retried. */
  | { kind: 'retryable'; reason: string; httpStatus?: number; retryAfterMs?: number; raw?: unknown };

/**
 * A Peppol ApplicationResponse on its way out (SRS v2.7 §12.3).
 *
 * The AP desk's verdict on a supplier's invoice travels the same network as an
 * invoice does, so it goes through the same driver — but it is a different
 * document with a different recipient, which is why it is not squeezed into
 * `submitInvoice`.
 */
export interface AspResponseRequest {
  idempotencyKey: string;
  responseUuid: string;
  /** The invoice the response is about. */
  invoiceNumber: string;
  /** The supplier's participant identifier — where the response is going. */
  recipientTrn: string | null;
  responseCode: string;
  reasonCode: string | null;
  responseXml: string;
}

export type AspResponseOutcome =
  | { kind: 'sent'; transmissionReference: string; httpStatus?: number; raw?: unknown }
  | { kind: 'rejected'; reason: string; httpStatus?: number; raw?: unknown }
  | { kind: 'retryable'; reason: string; httpStatus?: number; raw?: unknown };

export type AspStatusOutcome =
  | { kind: 'pending' }
  | {
      kind: 'accepted';
      clearedAt: string;
      receipt?: string;
      /** SRS v2.7 §10.6: the FTA Invoice Reference Number. */
      irn?: string;
      cryptographicStamp?: string;
      raw?: unknown;
    }
  | { kind: 'rejected'; reason: string; ruleCode?: string; raw?: unknown }
  | { kind: 'unknown'; reason: string };

/** Normalised shape of an inbound provider webhook. */
export interface AspWebhookEvent {
  deliveryId: string;
  transmissionReference: string | null;
  peppolUuid: string | null;
  invoiceNumber: string | null;
  status: 'ACCEPTED' | 'REJECTED' | 'PENDING';
  reason?: string;
  ruleCode?: string;
  receipt?: string;
  /** §10.6: the clearance identifier, captured onto the invoice. */
  irn?: string;
  cryptographicStamp?: string;
  /** Peppol Message Level Status, when the provider reports one. */
  mlsStatus?: string;
  occurredAt?: string;
}

export interface AspDriver {
  readonly providerType: AspTenantConfig['providerType'];

  submitInvoice(
    request: AspSubmissionRequest,
    config: AspTenantConfig,
  ): Promise<AspSubmissionOutcome>;

  getStatus(transmissionReference: string, config: AspTenantConfig): Promise<AspStatusOutcome>;

  /**
   * Transmit an ApplicationResponse to the party that issued the invoice.
   *
   * Optional on the interface: a Phase 1 provider that only carries invoices is
   * a real possibility, and the AP desk still has to work against it — the
   * verdict is recorded locally and the transmission is reported as unsupported
   * rather than silently succeeding.
   */
  sendResponse?(
    request: AspResponseRequest,
    config: AspTenantConfig,
  ): Promise<AspResponseOutcome>;

  /**
   * Verify a webhook came from the provider. Returning false must cause the
   * delivery to be rejected — this endpoint is public, and without the check
   * anyone could mark invoices as cleared.
   */
  verifyWebhookSignature(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
    config: AspTenantConfig,
  ): boolean;

  /** Parse a verified webhook body into the normalised event shape. */
  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): AspWebhookEvent;

  /** Cheap liveness probe, surfaced by the admin panel's "test connection". */
  testConnection(config: AspTenantConfig): Promise<{ ok: boolean; message: string }>;
}

const registry = new Map<string, AspDriver>();

export function registerDriver(driver: AspDriver): void {
  registry.set(driver.providerType, driver);
}

export function getDriver(providerType: string): AspDriver {
  const driver = registry.get(providerType);
  if (!driver) {
    throw new Error(
      `No ASP driver registered for provider type '${providerType}'. Configure the tenant's ASP connection in the admin panel.`,
    );
  }
  return driver;
}

export function listDrivers(): string[] {
  return [...registry.keys()];
}
