import type { AspConfigResponse } from '@uae/contracts';
import { config } from '../../config.js';
import { withPlatformAccess, type Tx } from '../../db/client.js';
import { decryptSecret, encryptSecret, sha256Hex } from '../../lib/crypto.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { logger } from '../../logger.js';
import { GenericRestAspDriver } from './genericRestDriver.js';
import { MockAspDriver } from './mockDriver.js';
import { registerDriver, type AspCredentials, type AspTenantConfig } from './driver.js';

registerDriver(new MockAspDriver());
registerDriver(new GenericRestAspDriver());

/** Phase 2's native AS4 gateway is not built. Attempting to use it says so. */
registerDriver({
  providerType: 'NATIVE_AS4',
  async submitInvoice() {
    return {
      kind: 'retryable' as const,
      reason:
        'The native AS4 gateway is a Phase 2 capability and is not implemented. Route this tenant through a third-party ASP.',
    };
  },
  async getStatus() {
    return { kind: 'unknown' as const, reason: 'Native AS4 gateway not implemented.' };
  },
  verifyWebhookSignature() {
    return false;
  },
  parseWebhook() {
    throw new Error('Native AS4 gateway not implemented.');
  },
  async testConnection() {
    return {
      ok: false,
      message:
        'Native AS4 is a Phase 2 capability. It requires Peppol accreditation, HSM signing keys and SML/SMP discovery, none of which are in place.',
    };
  },
});

interface AspConfigRow {
  id: string;
  tenant_id: string;
  provider_type: AspTenantConfig['providerType'];
  display_name: string;
  api_endpoint: string;
  credentials_cipher: string | null;
  provider_account_id: string | null;
  status: AspConfigResponse['status'];
  notes: string | null;
  last_tested_at: Date | null;
  last_test_result: string | null;
  updated_at: Date;
}

export function webhookUrlFor(tenantId: string): string {
  return `${config().API_PUBLIC_URL}/api/v1/webhooks/asp/${tenantId}`;
}

export function toAspConfigResponse(row: AspConfigRow): AspConfigResponse {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    providerType: row.provider_type,
    displayName: row.display_name,
    apiEndpoint: row.api_endpoint,
    status: row.status,
    providerAccountId: row.provider_account_id,
    notes: row.notes,
    // Credentials are never returned, only their presence. An admin session
    // must not be a way to read back every tenant's provider secrets.
    hasCredentials: Boolean(row.credentials_cipher),
    webhookUrl: webhookUrlFor(row.tenant_id),
    lastTestedAt: row.last_tested_at?.toISOString() ?? null,
    lastTestResult: row.last_test_result,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function decodeCredentials(cipher: string | null): AspCredentials {
  if (!cipher) return {};
  try {
    return JSON.parse(decryptSecret(cipher)) as AspCredentials;
  } catch (err) {
    logger.error({ err }, 'failed to decrypt ASP credentials');
    throw badRequest(
      'The stored ASP credentials could not be decrypted. Re-enter them in the admin panel.',
    );
  }
}

export function encodeCredentials(credentials: AspCredentials): string {
  return encryptSecret(JSON.stringify(credentials));
}

/**
 * Load the ASP configuration a tenant's invoices route through.
 *
 * This is the "which ASP do we send to" decision, and it is deliberately a
 * lookup rather than a computation: one active configuration per tenant,
 * enforced by a partial unique index.
 */
export async function loadTenantAspConfig(
  tenantId: string,
  tx?: Tx,
): Promise<AspTenantConfig> {
  const run = async (t: Tx) =>
    t<AspConfigRow[]>`
      SELECT * FROM tenant_asp_configs WHERE tenant_id = ${tenantId} AND is_active
    `;

  const rows = tx ? await run(tx) : await withPlatformAccess(run);
  const row = rows[0];
  if (!row) throw notFound('ASP configuration');

  if (row.status !== 'ACTIVE') {
    throw badRequest(
      `This tenant's ASP connection is ${row.status.toLowerCase().replace(/_/g, ' ')}. Invoices cannot be transmitted until it is active.`,
    );
  }

  return {
    tenantId: row.tenant_id,
    configId: row.id,
    providerType: row.provider_type,
    displayName: row.display_name,
    apiEndpoint: row.api_endpoint,
    providerAccountId: row.provider_account_id,
    credentials: decodeCredentials(row.credentials_cipher),
  };
}

/** Same lookup, but tolerant — used by webhooks, which arrive unauthenticated. */
export async function loadTenantAspConfigUnchecked(
  tenantId: string,
): Promise<AspTenantConfig | null> {
  const rows = await withPlatformAccess(
    (tx) => tx<AspConfigRow[]>`
      SELECT * FROM tenant_asp_configs WHERE tenant_id = ${tenantId} AND is_active
    `,
  );

  const row = rows[0];
  if (!row) return null;

  return {
    tenantId: row.tenant_id,
    configId: row.id,
    providerType: row.provider_type,
    displayName: row.display_name,
    apiEndpoint: row.api_endpoint,
    providerAccountId: row.provider_account_id,
    credentials: decodeCredentials(row.credentials_cipher),
  };
}

export function webhookSecretHash(secret: string): string {
  return sha256Hex(secret);
}

export type { AspConfigRow };
