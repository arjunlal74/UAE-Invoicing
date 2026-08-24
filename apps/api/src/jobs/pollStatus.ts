import { withPlatformAccess } from '../db/client.js';
import { logger } from '../logger.js';
import { getDriver } from '../modules/asp/driver.js';
import { loadTenantAspConfigUnchecked } from '../modules/asp/service.js';
import { applyStatusUpdate } from '../modules/webhooks/applyStatus.js';

/**
 * The safety net behind webhooks.
 *
 * Webhooks get lost: the provider's retry budget runs out while we are
 * mid-deploy, a network blip swallows a delivery, a signature check rejects a
 * malformed one. Without this sweep those invoices sit at SUBMITTED_TO_ASP
 * forever and nobody notices until a merchant asks why their filing never
 * cleared.
 *
 * Runs on a repeating schedule and asks the provider directly about anything
 * that has been silent for too long.
 */

const SILENT_AFTER_MINUTES = 10;
const BATCH_LIMIT = 100;

export async function pollStatusJob(): Promise<{ checked: number; resolved: number }> {
  const pending = await withPlatformAccess(
    (tx) => tx<
      {
        invoice_id: string;
        tenant_id: string;
        invoice_number: string;
        transmission_reference: string | null;
      }[]
    >`
      SELECT DISTINCT ON (i.id)
        i.id AS invoice_id, i.tenant_id, i.invoice_number,
        l.transmission_reference
      FROM invoices i
      LEFT JOIN transmission_logs l
        ON l.invoice_id = i.id AND l.transmission_reference IS NOT NULL
      -- Outbound only: a purchase invoice arrived already cleared, so there is
      -- no provider verdict outstanding on it to poll for.
      WHERE i.direction = 'OUTBOUND_SALES_AR'
        AND i.status = 'SUBMITTED_TO_ASP'
        AND i.submitted_at < now() - (${SILENT_AFTER_MINUTES} * interval '1 minute')
      ORDER BY i.id, l.created_at DESC
      LIMIT ${BATCH_LIMIT}
    `,
  );

  if (pending.length === 0) return { checked: 0, resolved: 0 };

  logger.info({ count: pending.length }, 'polling provider for silent transmissions');

  // Configurations are loaded once per tenant rather than once per invoice —
  // a hundred stuck invoices from one merchant should not mean a hundred
  // credential decryptions.
  const configCache = new Map<string, Awaited<ReturnType<typeof loadTenantAspConfigUnchecked>>>();
  let resolved = 0;

  for (const row of pending) {
    if (!row.transmission_reference) continue;

    try {
      if (!configCache.has(row.tenant_id)) {
        configCache.set(row.tenant_id, await loadTenantAspConfigUnchecked(row.tenant_id));
      }
      const config = configCache.get(row.tenant_id);
      if (!config) continue;

      const status = await getDriver(config.providerType).getStatus(
        row.transmission_reference,
        config,
      );

      if (status.kind === 'pending' || status.kind === 'unknown') continue;

      const result = await applyStatusUpdate({
        tenantId: row.tenant_id,
        invoiceId: row.invoice_id,
        transmissionReference: row.transmission_reference,
        verdict: status.kind === 'accepted' ? 'ACCEPTED' : 'REJECTED',
        reason: status.kind === 'rejected' ? status.reason : undefined,
        ruleCode: status.kind === 'rejected' ? status.ruleCode : undefined,
        receipt: status.kind === 'accepted' ? status.receipt : undefined,
        source: 'poll',
      });

      if (result.applied) resolved++;
    } catch (err) {
      // One tenant's broken provider configuration must not stop the sweep for
      // everyone else.
      logger.error({ err, invoiceId: row.invoice_id }, 'status poll failed for invoice');
    }
  }

  logger.info({ checked: pending.length, resolved }, 'status poll complete');
  return { checked: pending.length, resolved };
}
