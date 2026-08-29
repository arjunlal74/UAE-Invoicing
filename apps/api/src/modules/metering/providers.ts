import {
  CreateProviderRequest,
  UpdateProviderRequest,
  type ProviderSummary,
} from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { withPlatformAccess } from '../../db/client.js';
import { requireContext, requirePermission, requirePlatform } from '../../http/context.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { parsePeriod, toReportingPeriod, type ParsedPeriod } from './period.js';

/**
 * The accredited provider master.
 *
 * §15.1 records a purchase against a provider name typed into the contract
 * form. Two contracts keyed "Accredited ASP UAE" and "accredited asp uae" are
 * then two providers as far as any cost report is concerned, which defeats the
 * point of recording the cost at all. The MoF publishes a finite list; a
 * platform deals with one or two of them.
 *
 * Nothing here is ever deleted. A provider that has sold the platform units is
 * part of the record of where its capacity came from, so retiring one is
 * `isActive = false` — it leaves the picker and its contracts stay legible.
 */

interface ProviderRow {
  id: string;
  name: string;
  accreditation_reference: string | null;
  accreditation_from: Date | null;
  accreditation_valid_until: Date | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  website: string | null;
  default_cost_per_unit_aed: string | null;
  is_active: boolean;
  is_locked: boolean;
  notes: string | null;
  created_at: Date;
  contract_count: string;
  total_units: string;
  total_spend: string;
  lifetime_contract_count: string;
  last_purchase_date: Date | null;
  last_cost_per_unit_aed: string | null;
}

function toSummary(row: ProviderRow): ProviderSummary {
  return {
    id: row.id,
    name: row.name,
    accreditationReference: row.accreditation_reference,
    accreditationFrom: row.accreditation_from
      ? row.accreditation_from.toISOString().slice(0, 10)
      : null,
    accreditationValidUntil: row.accreditation_valid_until
      ? row.accreditation_valid_until.toISOString().slice(0, 10)
      : null,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    website: row.website,
    defaultCostPerUnitAed: row.default_cost_per_unit_aed,
    isActive: row.is_active,
    isLocked: row.is_locked,
    notes: row.notes,
    contractCount: Number(row.contract_count),
    totalUnitsPurchased: Number(row.total_units),
    totalSpendAed: row.total_spend,
    lifetimeContractCount: Number(row.lifetime_contract_count),
    lastPurchaseDate: row.last_purchase_date
      ? row.last_purchase_date.toISOString().slice(0, 10)
      : null,
    lastCostPerUnitAed: row.last_cost_per_unit_aed,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The roll-up that makes a retirement decision an informed one: "this provider
 * supplied 1.2m units across four contracts" is what you want to see before
 * taking them out of the picker.
 *
 * Scoped to a period. A lifetime total only grows, so within a year or two it
 * stops distinguishing a provider you buy from every quarter from one you used
 * once in 2026 — which is exactly the question the roll-up exists to answer.
 * `lifetime_contract_count` stays unscoped alongside it, because "none this
 * period" and "none ever" are different facts and only the second makes a
 * provider safe to retire.
 *
 * `$1`/`$2` are the period bounds; a null bound means open-ended on that side.
 */
const PROVIDER_SELECT = `
  v.id, v.name, v.accreditation_reference,
  v.accreditation_from, v.accreditation_valid_until,
  v.contact_name, v.contact_email,
  v.contact_phone, v.website, v.is_active, v.is_locked, v.notes, v.created_at,
  v.default_cost_per_unit_aed::text AS default_cost_per_unit_aed,
  (SELECT count(*) FROM asp_bundle_procurements p
    WHERE p.asp_provider_id = v.id
      AND ($1::date IS NULL OR p.purchase_date >= $1::date)
      AND ($2::date IS NULL OR p.purchase_date <= $2::date))::text AS contract_count,
  (SELECT coalesce(sum(p.total_units), 0) FROM asp_bundle_procurements p
    WHERE p.asp_provider_id = v.id
      AND ($1::date IS NULL OR p.purchase_date >= $1::date)
      AND ($2::date IS NULL OR p.purchase_date <= $2::date))::text AS total_units,
  (SELECT coalesce(sum(p.total_cost_aed), 0) FROM asp_bundle_procurements p
    WHERE p.asp_provider_id = v.id
      AND ($1::date IS NULL OR p.purchase_date >= $1::date)
      AND ($2::date IS NULL OR p.purchase_date <= $2::date))::text AS total_spend,
  (SELECT count(*) FROM asp_bundle_procurements p WHERE p.asp_provider_id = v.id)::text
    AS lifetime_contract_count,
  -- The last contract and its rate, unscoped for the same reason: what this
  -- provider last charged is the figure a renewal is argued from, and hiding it
  -- because it fell outside the window being reported on helps nobody.
  (SELECT p.purchase_date FROM asp_bundle_procurements p
    WHERE p.asp_provider_id = v.id
    ORDER BY p.purchase_date DESC, p.created_at DESC LIMIT 1) AS last_purchase_date,
  (SELECT p.cost_per_unit_aed::text FROM asp_bundle_procurements p
    WHERE p.asp_provider_id = v.id
    ORDER BY p.purchase_date DESC, p.created_at DESC LIMIT 1) AS last_cost_per_unit_aed
`;

/**
 * A locked record accepts exactly one change: the unlock itself.
 *
 * Enforced on the server rather than by hiding buttons, because the point of
 * the lock is that confirmed details stop drifting whatever the caller is —
 * the portal, a script, or someone with a token and curl.
 */
function isoDay(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/**
 * An accreditation cannot lapse before it starts.
 *
 * The table carries the same rule as a CHECK; this is here so the answer is a
 * sentence rather than a constraint name, which is what the operator who typed
 * the dates the wrong way round needs to read.
 */
function assertAccreditationOrdered(from?: string | null, until?: string | null): void {
  if (from && until && until < from) {
    throw badRequest('An accreditation cannot expire before it starts.');
  }
}

export function isUnlockOnly(body: UpdateProviderRequest): boolean {
  const keys = Object.keys(body);
  return keys.length === 1 && keys[0] === 'isLocked' && body.isLocked === false;
}

/**
 * Which of the four provider verbs a PATCH amounts to. The lock and the
 * retirement are separate states, so they are separate entries in the trail:
 * "who froze this record" and "who stopped us buying from them" are different
 * questions asked months apart.
 */
export function providerAuditAction(body: UpdateProviderRequest) {
  if (body.isLocked === true) return 'PROVIDER_LOCKED' as const;
  if (body.isLocked === false) return 'PROVIDER_UNLOCKED' as const;
  if (body.isActive === false) return 'PROVIDER_RETIRED' as const;
  return 'PROVIDER_UPDATED' as const;
}

async function loadOne(id: string, period: ParsedPeriod): Promise<ProviderRow> {
  const rows = await withPlatformAccess((tx) =>
    tx.unsafe<ProviderRow[]>(
      `SELECT ${PROVIDER_SELECT} FROM asp_providers v WHERE v.id = $3`,
      [period.from, period.to, id],
    ),
  );
  const row = rows[0];
  if (!row) throw notFound('Provider');
  return row;
}

export function registerProviderRoutes(app: FastifyInstance) {
  // --- List ----------------------------------------------------------------
  app.get(
    '/api/v1/admin/providers',
    { preHandler: requirePlatform() },
    async (request, reply) => {
      const { includeInactive } = request.query as { includeInactive?: string };
      const period = parsePeriod(request.query);

      const rows = await withPlatformAccess((tx) =>
        tx.unsafe<ProviderRow[]>(
          `SELECT ${PROVIDER_SELECT}
           FROM asp_providers v
           ${includeInactive === 'true' ? '' : 'WHERE v.is_active'}
           ORDER BY v.is_active DESC, v.name`,
          [period.from, period.to],
        ),
      );

      return reply.send({ items: rows.map(toSummary), period: toReportingPeriod(period) });
    },
  );

  // --- Create --------------------------------------------------------------
  app.post(
    '/api/v1/admin/providers',
    { preHandler: requirePermission('platform.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const body = CreateProviderRequest.parse(request.body);
      assertAccreditationOrdered(body.accreditationFrom, body.accreditationValidUntil);

      const id = await withPlatformAccess(async (tx) => {
        // Checked case-insensitively, because the whole point of the master is
        // that "Accredited ASP UAE" and "accredited asp uae" are one provider.
        // The unique index is still the authority; this makes the answer a
        // sentence rather than a constraint name.
        const clash = await tx<{ name: string }[]>`
          SELECT name FROM asp_providers WHERE lower(name) = lower(${body.name})
        `;
        if (clash[0]) {
          throw badRequest(`"${clash[0].name}" is already on the provider list.`);
        }

        const rows = await tx<{ id: string }[]>`
          INSERT INTO asp_providers (
            name, accreditation_reference,
            accreditation_from, accreditation_valid_until,
            contact_name, contact_email,
            contact_phone, website, default_cost_per_unit_aed, notes,
            created_by_user_id
          ) VALUES (
            ${body.name}, ${body.accreditationReference ?? null},
            ${body.accreditationFrom ?? null}, ${body.accreditationValidUntil ?? null},
            ${body.contactName ?? null}, ${body.contactEmail ?? null},
            ${body.contactPhone ?? null}, ${body.website ?? null},
            ${body.defaultCostPerUnitAed ?? null}, ${body.notes ?? null},
            ${ctx.userId}
          )
          RETURNING id
        `;
        return rows[0]!.id;
      });

      await audit(actorFromContext(ctx), {
        action: 'PROVIDER_CREATED',
        resourceType: 'ASP_PROVIDER',
        resourceId: id,
        tenantId: null,
        changes: { name: body.name, accreditation: body.accreditationReference ?? null },
      });

      return reply.status(201).send(toSummary(await loadOne(id, parsePeriod({}))));
    },
  );

  // --- Update, including retirement ----------------------------------------
  app.patch(
    '/api/v1/admin/providers/:id',
    { preHandler: requirePermission('platform.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      const body = UpdateProviderRequest.parse(request.body);

      const before = await loadOne(id, parsePeriod({}));

      // Checked against the merged record, not the patch: sending only a new
      // start date must still be judged against the expiry already on file.
      assertAccreditationOrdered(
        body.accreditationFrom === undefined
          ? isoDay(before.accreditation_from)
          : body.accreditationFrom,
        body.accreditationValidUntil === undefined
          ? isoDay(before.accreditation_valid_until)
          : body.accreditationValidUntil,
      );

      if (before.is_locked && !isUnlockOnly(body)) {
        throw badRequest(`"${before.name}" is locked. Unlock it before editing or retiring it.`);
      }

      await withPlatformAccess(async (tx) => {
        if (body.name && body.name.toLowerCase() !== before.name.toLowerCase()) {
          const clash = await tx<{ name: string }[]>`
            SELECT name FROM asp_providers
            WHERE lower(name) = lower(${body.name}) AND id <> ${id}
          `;
          if (clash[0]) {
            throw badRequest(`"${clash[0].name}" is already on the provider list.`);
          }
        }

        // `coalesce` on each column so an omitted field is left alone, while an
        // explicit null clears it — the two are different intentions and a
        // PATCH should be able to express both.
        await tx`
          UPDATE asp_providers SET
            name                      = coalesce(${body.name ?? null}, name),
            accreditation_reference   = ${
              body.accreditationReference === undefined
                ? tx.unsafe('accreditation_reference')
                : body.accreditationReference
            },
            accreditation_from        = ${
              body.accreditationFrom === undefined
                ? tx.unsafe('accreditation_from')
                : body.accreditationFrom
            },
            accreditation_valid_until = ${
              body.accreditationValidUntil === undefined
                ? tx.unsafe('accreditation_valid_until')
                : body.accreditationValidUntil
            },
            contact_name              = ${
              body.contactName === undefined ? tx.unsafe('contact_name') : body.contactName
            },
            contact_email             = ${
              body.contactEmail === undefined ? tx.unsafe('contact_email') : body.contactEmail
            },
            contact_phone             = ${
              body.contactPhone === undefined ? tx.unsafe('contact_phone') : body.contactPhone
            },
            website                   = ${
              body.website === undefined ? tx.unsafe('website') : body.website
            },
            default_cost_per_unit_aed = ${
              body.defaultCostPerUnitAed === undefined
                ? tx.unsafe('default_cost_per_unit_aed')
                : body.defaultCostPerUnitAed
            },
            notes                     = ${
              body.notes === undefined ? tx.unsafe('notes') : body.notes
            },
            is_active                 = coalesce(${body.isActive ?? null}, is_active),
            is_locked                 = coalesce(${body.isLocked ?? null}, is_locked)
          WHERE id = ${id}
        `;
      });

      await audit(actorFromContext(ctx), {
        action: providerAuditAction(body),
        resourceType: 'ASP_PROVIDER',
        resourceId: id,
        tenantId: null,
        changes: {
          name: body.name ?? before.name,
          isActive: body.isActive,
          isLocked: body.isLocked,
        },
      });

      return reply.send(toSummary(await loadOne(id, parsePeriod({}))));
    },
  );
}

export { loadOne as loadProvider };
