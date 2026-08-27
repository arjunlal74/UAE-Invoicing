import { withPlatformAccess } from '../db/client.js';
import { logger } from '../logger.js';
import { queueInventoryBuffer } from '../mail/outbox.js';
import {
  findBufferBreaches,
  markAlerted,
  rearmRecoveredBuffers,
  type BufferBreach,
} from '../modules/metering/inventory.js';

/**
 * The §15.5 minimum quantity sweep.
 *
 * A floor is breached two ways — the balance falls, or somebody raises the
 * threshold — and only the first passes through `consumeUnits`. Checking on a
 * schedule catches both. It also catches the case that matters most and would
 * otherwise never fire at all: an account that stops filing entirely sits below
 * its buffer indefinitely without another deduction to trigger anything.
 *
 * Idempotent by construction. A breach is announced once, recorded, and not
 * announced again until the balance climbs back over the line and re-arms it.
 */

/** Who can actually do something about it, per tier (§15.5's "automated action"). */
const RECIPIENT_ROLES: Record<BufferBreach['tier'], string[]> = {
  // The host's own buffer is a procurement problem, so it goes to the people
  // who hold the provider contract.
  HOST: ['GLOBAL_ADMIN'],
  // §15.5 tier 4 routes a sub-tenant's shortfall to the partner as well as the
  // sub-tenant, because the partner is the one holding the 1-click top-up.
  MANAGED_SUB_TENANT: ['COMPANY_ADMIN', 'TAX_APPROVER_CFO'],
  CHANNEL_PARTNER: ['PARTNER_ADMIN'],
  ENTERPRISE_TENANT: ['COMPANY_ADMIN', 'TAX_APPROVER_CFO'],
};

const TIER_LABELS: Record<BufferBreach['tier'], string> = {
  HOST: 'Global admin main account',
  CHANNEL_PARTNER: 'Channel partner pool',
  ENTERPRISE_TENANT: 'Direct tenant',
  MANAGED_SUB_TENANT: 'Managed sub-tenant',
};

/** Where the recipient goes to fix it. */
function consolePathFor(tier: BufferBreach['tier']): string {
  if (tier === 'HOST') return '/admin/inventory';
  if (tier === 'CHANNEL_PARTNER') return '/partner';
  return '/settings/usage';
}

interface Recipient {
  email: string;
  full_name: string;
  user_id: string;
}

async function recipientsFor(breach: BufferBreach): Promise<Recipient[]> {
  const roles = RECIPIENT_ROLES[breach.tier];

  return withPlatformAccess(async (tx) => {
    if (breach.tier === 'HOST') {
      return tx<Recipient[]>`
        SELECT email, full_name, id AS user_id FROM users
        WHERE tenant_id IS NULL AND is_active AND role = 'GLOBAL_ADMIN'
      `;
    }

    const own = await tx<Recipient[]>`
      SELECT email, full_name, id AS user_id FROM users
      WHERE tenant_id = ${breach.tenantId}
        AND is_active
        AND role = ANY(${roles}::user_role[])
    `;

    if (breach.tier !== 'MANAGED_SUB_TENANT') return own;

    // The sub-tenant cannot buy its own units — its slice comes from the
    // partner's pool — so the partner is told too, and is the one who can act.
    const partner = await tx<Recipient[]>`
      SELECT u.email, u.full_name, u.id AS user_id
      FROM users u
      JOIN tenants sub ON sub.parent_tenant_id = u.tenant_id
      WHERE sub.id = ${breach.tenantId}
        AND u.is_active
        AND u.role = 'PARTNER_ADMIN'
    `;

    return [...own, ...partner];
  });
}

export async function inventorySweepJob(): Promise<{ breaches: number; rearmed: number }> {
  // Re-arm first. An account that was topped up since the last sweep and has
  // fallen below again in the meantime should get a fresh warning, not silence
  // because the old flag was still set when the breach query ran.
  const rearmed = await rearmRecoveredBuffers();
  const breaches = await findBufferBreaches();

  for (const breach of breaches) {
    let dispatched = false;
    try {
      const recipients = await recipientsFor(breach);

      for (const recipient of recipients) {
        await queueInventoryBuffer({
          to: recipient.email,
          contactName: recipient.full_name,
          accountName: breach.tenantName,
          tierLabel: TIER_LABELS[breach.tier],
          thresholdUnits: breach.thresholdUnits,
          remainingUnits: breach.unitsRemaining,
          dailyRunRate: breach.dailyRunRate,
          critical: breach.severity === 'CRITICAL',
          consolePath: consolePathFor(breach.tier),
          userId: recipient.user_id,
          tenantId: breach.tenantId,
        });
        dispatched = true;
      }

      if (recipients.length === 0) {
        logger.warn(
          { tier: breach.tier, tenantId: breach.tenantId },
          'inventory: buffer breached but no active recipient holds the role that can act on it',
        );
      }
    } catch (err) {
      logger.error({ err, tier: breach.tier, tenantId: breach.tenantId }, 'inventory: alert failed');
    }

    // Recorded either way, and the row says whether mail actually went out.
    // Marking it only on success would re-send on every sweep for an account
    // whose administrators have all been deactivated.
    await markAlerted(breach, dispatched);
  }

  if (breaches.length > 0 || rearmed > 0) {
    logger.info({ breaches: breaches.length, rearmed }, 'inventory: buffer sweep complete');
  }

  return { breaches: breaches.length, rearmed };
}
