import {
  CreateTenantRequest,
  TENANT_TYPE_LABELS,
  UpdateTenantRequest,
  UpdateTenantStatusRequest,
  can,
  type Role,
  type TenantDetail,
  type TenantSummary,
  type TenantType,
} from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit, diff } from '../../audit/audit.js';
import { renderWorkbookXlsx } from '../../excel/report.js';
import { sendXlsx } from '../../excel/reply.js';
import { renderTenantDirectoryPdf } from '../../pdf/report.js';
import { sendPdf } from '../../pdf/reply.js';
import { createInvite } from '../../auth/service.js';
import { config } from '../../config.js';
import { jsonb, sql, withPlatformAccess } from '../../db/client.js';
import { ctxCan, requireAuth, requireContext, requirePlatform } from '../../http/context.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { logger } from '../../logger.js';
import { queueActivation } from '../../mail/outbox.js';

/**
 * Tenant management — the admin panel's core.
 *
 * Onboarding deliberately leaves a tenant in PENDING. A merchant is not usable
 * until their ASP registration completes, which is an external process with a
 * lead time, and pretending otherwise would let them upload hundreds of
 * invoices only to discover at submission that they have no route to the FTA.
 */

interface TenantRow {
  id: string;
  tenant_type: TenantType;
  parent_tenant_id: string | null;
  parent_name: string | null;
  company_code: string;
  legal_name_en: string;
  legal_name_ar: string;
  // Null for a channel partner, which never files under its own TRN.
  trn: string | null;
  is_vat_group: boolean;
  vat_group_trn: string | null;
  registered_address: unknown;
  status: TenantSummary['status'];
  is_locked: boolean;
  asp_status: TenantDetail['aspStatus'] | null;
  invoice_count: string;
  user_count?: string;
  sub_tenant_count?: string;
  created_at: Date;
  updated_at: Date;
}

function toSummary(row: TenantRow): TenantSummary {
  return {
    id: row.id,
    tenantType: row.tenant_type,
    parentTenantId: row.parent_tenant_id,
    parentName: row.parent_name,
    companyCode: row.company_code,
    legalNameEn: row.legal_name_en,
    legalNameAr: row.legal_name_ar,
    trn: row.trn,
    status: row.status,
    isLocked: row.is_locked,
    aspStatus: row.asp_status ?? 'NOT_CONFIGURED',
    invoiceCount: Number(row.invoice_count ?? 0),
    createdAt: row.created_at.toISOString(),
  };
}

interface TenantListFilters {
  q?: string;
  status?: string;
  tenantType?: string;
  /**
   * The dashboard counts tenants whose provider connection is not live and
   * links here. Without a filter the operator lands on every tenant and has to
   * find the ones the tile was counting, which is the work the tile was
   * supposed to have done.
   */
  aspStatus?: string;
}

/**
 * One query for the screen and for the files it exports.
 *
 * A printed directory that quietly covered a different set from the list it
 * was printed from would be worse than none: the reader has no way to tell,
 * and these get filed.
 */
async function listTenants(query: TenantListFilters) {
  return withPlatformAccess(
      (tx) => tx<TenantRow[]>`
        SELECT t.*,
               p.legal_name_en AS parent_name,
               c.status AS asp_status,
               (SELECT count(*) FROM invoices i WHERE i.tenant_id = t.id AND i.direction = 'OUTBOUND_SALES_AR') AS invoice_count
        FROM tenants t
        LEFT JOIN tenants p ON p.id = t.parent_tenant_id
        LEFT JOIN tenant_asp_configs c ON c.tenant_id = t.id AND c.is_active
        WHERE (${query.q ?? null}::text IS NULL
               OR t.legal_name_en ILIKE ${'%' + (query.q ?? '') + '%'}
               OR t.company_code ILIKE ${'%' + (query.q ?? '') + '%'}
               OR coalesce(t.trn, '') ILIKE ${'%' + (query.q ?? '') + '%'})
          AND (${query.status ?? null}::text IS NULL OR t.status::text = ${query.status ?? null})
          AND (${query.tenantType ?? null}::text IS NULL
               OR t.tenant_type::text = ${query.tenantType ?? null})
          -- 'NOT_LIVE' is a connection that exists and is not live, which is
          -- what the dashboard tile linking here counts. Deliberately not
          -- "has no configuration": a channel partner resells capacity and
          -- never files, so having no provider connection is correct for it
          -- rather than a fault, and sweeping it in would send the operator
          -- to fix something that is not broken.
          AND (${query.aspStatus ?? null}::text IS NULL
               OR (${query.aspStatus ?? null} = 'NOT_LIVE'
                   AND c.status IS NOT NULL AND c.status::text <> 'ACTIVE')
               OR c.status::text = ${query.aspStatus ?? null})
        ORDER BY t.created_at DESC
      `,
  );
}

/** What the reader filtered to, in words, for the head of a printed copy. */
function filterLabel(query: TenantListFilters): string {
  const parts: string[] = [];
  if (query.q) parts.push(`matching "${query.q}"`);
  if (query.status) parts.push(`status ${query.status.toLowerCase()}`);
  if (query.tenantType) parts.push(TENANT_TYPE_LABELS[query.tenantType as TenantType] ?? query.tenantType);
  if (query.aspStatus === 'NOT_LIVE') parts.push('provider connection not live');
  else if (query.aspStatus) parts.push(`provider ${query.aspStatus.toLowerCase()}`);

  return parts.length === 0 ? 'Every tenant' : `Filtered: ${parts.join(', ')}`;
}

/**
 * The tiers, in the order the units travel: the host sells to a partner or a
 * direct tenant, and a partner allocates to its own sub-tenants.
 */
/**
 * The directory's sections, in the order units travel down the hierarchy.
 *
 * Managed sub-tenants break out one section per partner rather than sitting in
 * one list. A sub-tenant's balance comes out of its partner's master pool, so
 * "who is under Gulf Advisory" is the question actually asked of this tier —
 * and answering it from a single list means reading a Parent column and
 * grouping by eye, which is the work the report is for.
 *
 * A partner with no sub-tenants still gets a section saying so. Silence would
 * read as "not covered" rather than "none yet".
 */
function directoryGroups(
  tenants: ReturnType<typeof toSummary>[],
): { title: string; rows: string[][] }[] {
  const of = (tier: TenantType) => tenants.filter((tenant) => tenant.tenantType === tier);

  const partners = of('CHANNEL_PARTNER');
  const managed = of('MANAGED_SUB_TENANT');

  const groups = [
    { title: TENANT_TYPE_LABELS.CHANNEL_PARTNER, rows: partners.map(directoryRow) },
    { title: TENANT_TYPE_LABELS.ENTERPRISE_TENANT, rows: of('ENTERPRISE_TENANT').map(directoryRow) },
  ];

  for (const partner of partners) {
    groups.push({
      title: `${TENANT_TYPE_LABELS.MANAGED_SUB_TENANT} — under ${partner.legalNameEn}`,
      rows: managed.filter((tenant) => tenant.parentName === partner.legalNameEn).map(directoryRow),
    });
  }

  // Anything whose partner is not on this list — filtered out, or an orphan.
  // Dropping them silently would make the sections add up to less than the
  // total on the front of the report.
  const named = new Set(partners.map((partner) => partner.legalNameEn));
  const unplaced = managed.filter((tenant) => !tenant.parentName || !named.has(tenant.parentName));
  if (unplaced.length > 0) {
    groups.push({
      title: `${TENANT_TYPE_LABELS.MANAGED_SUB_TENANT} — partner not on this list`,
      rows: unplaced.map(directoryRow),
    });
  }

  return groups;
}

const DIRECTORY_COLUMNS = [
  'Company',
  'Code',
  'TRN',
  'Account',
  'Provider',
  'Parent',
  'Invoices',
  'Onboarded',
];

function directoryRow(tenant: ReturnType<typeof toSummary>): string[] {
  return [
    tenant.legalNameEn,
    tenant.companyCode,
    tenant.trn ?? '—',
    tenant.status,
    tenant.aspStatus,
    tenant.parentName ?? '—',
    String(tenant.invoiceCount),
    tenant.createdAt.slice(0, 10),
  ];
}

export function registerTenantRoutes(app: FastifyInstance) {
  // --- Platform: list ------------------------------------------------------
  app.get('/api/v1/admin/tenants', { preHandler: requirePlatform() }, async (request, reply) => {
    const rows = await listTenants(request.query as TenantListFilters);
    return reply.send({ items: rows.map(toSummary), total: rows.length, page: 1, pageSize: rows.length });
  });

  // --- Platform: the same list on paper, and in a workbook -----------------
  //
  // Grouped by tier rather than sorted by it. The tiers are not degrees of one
  // thing — a partner resells capacity and never files, a sub-tenant files
  // against a slice it did not buy — so a flat table invites a comparison
  // between neighbouring rows that does not mean anything.
  for (const format of ['pdf', 'xlsx'] as const) {
    app.get(
      `/api/v1/admin/tenants.${format}`,
      { preHandler: requirePlatform() },
      async (request, reply) => {
        const query = request.query as TenantListFilters;
        const tenants = (await listTenants(query)).map(toSummary);
        const label = filterLabel(query);
        const stamp = new Date().toISOString().slice(0, 10);

        const groups = directoryGroups(tenants);

        if (format === 'xlsx') {
          // A tab per tier: the grouping survives sorting, which it would not
          // if the three tables were stacked on one sheet.
          return sendXlsx(
            reply,
            await renderWorkbookXlsx(
              groups.map((group) => ({
                // Excel caps a tab name at 31 characters, so a long partner
                // name is trimmed there rather than losing the tier prefix.
                sheetName: group.title.replace('Managed sub-tenant — under ', 'Under '),
                title: 'Tenant directory',
                subtitle: group.title,
                periodLabel: label,
                holderName: config().PLATFORM_NAME,
                columns: DIRECTORY_COLUMNS,
                rows: group.rows,
              })),
            ),
            `tenant-directory-${stamp}`,
          );
        }

        const pdf = await renderTenantDirectoryPdf({
          groups: groups.map((group) => ({
            title: group.title,
            columns: DIRECTORY_COLUMNS,
            rows: group.rows,
          })),
          filterLabel: label,
          platformName: config().PLATFORM_NAME,
          generatedFor: `${tenants.length} tenant${tenants.length === 1 ? '' : 's'}`,
        });

        return sendPdf(request, reply, pdf, `tenant-directory-${stamp}`);
      },
    );
  }

  // --- Platform: create ----------------------------------------------------
  app.post('/api/v1/admin/tenants', { preHandler: requirePlatform() }, async (request, reply) => {
    const ctx = requireContext(request);
    const body = CreateTenantRequest.parse(request.body);

    if (body.adminEmail && !body.adminFullName) {
      throw badRequest('Provide a name for the first administrator.');
    }

    const result = await withPlatformAccess(async (tx) => {
      // The database enforces this too, but failing here produces a message
      // the administrator can act on rather than a constraint violation.
      if (body.parentTenantId) {
        const parents = await tx<{ tenant_type: TenantType }[]>`
          SELECT tenant_type FROM tenants WHERE id = ${body.parentTenantId}
        `;
        if (!parents[0]) throw notFound('Parent tenant');
        if (parents[0].tenant_type !== 'CHANNEL_PARTNER') {
          throw badRequest('A managed sub-tenant must sit under a channel partner.');
        }
      }

      const inserted = await tx<{ id: string }[]>`
        INSERT INTO tenants (
          tenant_type, parent_tenant_id, company_code, legal_name_en, legal_name_ar, trn,
          is_vat_group, vat_group_trn, registered_address, status
        ) VALUES (
          ${body.tenantType}::tenant_type, ${body.parentTenantId ?? null},
          ${body.companyCode}, ${body.legalNameEn}, ${body.legalNameAr}, ${body.trn ?? null},
          ${body.isVatGroup}, ${body.vatGroupTrn ?? null},
          ${jsonb(tx, body.registeredAddress)}, 'PENDING'
        )
        RETURNING id
      `;

      const tenantId = inserted[0]!.id;

      // Every tenant gets an ASP configuration row up front, so the admin
      // panel always has something concrete to show and edit rather than a
      // special "no config yet" case.
      //
      // Naming a provider fills in the half of that row that belongs to the
      // provider — how it is talked to, and where. What it cannot fill is the
      // credentials and the account identifier, which the provider issues per
      // merchant, so the connection lands in PENDING_REGISTRATION rather than
      // ACTIVE: addressed and named, but not yet authenticated. Claiming
      // otherwise would let the tenant be activated and fail at submission.
      interface ChosenProvider {
        id: string;
        name: string;
        provider_type: string;
        api_endpoint: string;
        provider_account_id: string | null;
      }
      let chosen: ChosenProvider | null = null;

      if (body.aspProviderId) {
        const found = await tx<ChosenProvider[]>`
          SELECT id, name, provider_type, api_endpoint, provider_account_id
          FROM asp_providers
          WHERE id = ${body.aspProviderId} AND is_active
        `;
        chosen = found[0] ?? null;
        if (!chosen) {
          throw badRequest('That accredited provider is not on file, or has been retired.');
        }
      }

      await tx`
        INSERT INTO tenant_asp_configs (
          tenant_id, asp_provider_id, provider_type, display_name, api_endpoint,
          provider_account_id, status
        )
        VALUES (
          ${tenantId},
          ${chosen?.id ?? null},
          ${(chosen?.provider_type ?? config().ASP_DEFAULT_DRIVER)}::asp_provider_type,
          ${chosen?.name ?? 'Not yet selected'},
          ${chosen?.api_endpoint ?? ''},
          ${chosen?.provider_account_id ?? null},
          ${chosen ? 'PENDING_REGISTRATION' : 'NOT_CONFIGURED'}
        )
      `;

      let inviteToken: string | null = null;
      let inviteUserId: string | null = null;
      let inviteRole: Role | null = null;
      if (body.adminEmail && body.adminFullName) {
        // A channel partner's first user administers sub-tenants, not invoices.
        const adminRole = body.tenantType === 'CHANNEL_PARTNER' ? 'PARTNER_ADMIN' : 'COMPANY_ADMIN';
        const users = await tx<{ id: string }[]>`
          INSERT INTO users (tenant_id, email, full_name, role, is_active)
          VALUES (${tenantId}, ${body.adminEmail}, ${body.adminFullName},
                  ${adminRole}::user_role, FALSE)
          RETURNING id
        `;
        inviteToken = await createInvite(users[0]!.id, tx);
        inviteUserId = users[0]!.id;
        inviteRole = adminRole;
      }

      return { tenantId, inviteToken, inviteUserId, inviteRole };
    });

    await audit(actorFromContext(ctx), {
      action: 'TENANT_CREATED',
      resourceType: 'TENANT',
      resourceId: result.tenantId,
      tenantId: result.tenantId,
      changes: {
        companyCode: body.companyCode,
        tenantType: body.tenantType,
        parentTenantId: body.parentTenantId ?? null,
        trn: body.trn ?? null,
        legalNameEn: body.legalNameEn,
      },
    });

    // The link is returned as well as e-mailed. Mail can be delayed or
    // filtered, and the administrator onboarding the tenant is the one who
    // gets asked why the first sign-in never happened.
    let inviteUrl: string | null = null;
    let emailed = false;
    let emailMessage: string | null = null;

    if (result.inviteToken) {
      inviteUrl = `${config().PORTAL_ORIGIN}/accept-invite?token=${result.inviteToken}`;

      // Template A: a direct tenant or a channel partner, provisioned by the
      // platform itself rather than by an intermediary.
      const mail = await queueActivation({
        to: body.adminEmail!,
        contactName: body.adminFullName!,
        companyName: body.legalNameEn,
        activationUrl: inviteUrl,
        userId: result.inviteUserId,
        tenantId: result.tenantId,
      });

      emailed = mail.queued;
      emailMessage = mail.reason ?? null;
      logger.info({ tenantId: result.tenantId, emailed }, 'tenant admin invite created');
    }

    return reply.status(201).send({ id: result.tenantId, inviteUrl, emailed, emailMessage });
  });

  // --- Platform: detail ----------------------------------------------------
  app.get('/api/v1/admin/tenants/:id', { preHandler: requirePlatform() }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const rows = await withPlatformAccess(
      (tx) => tx<TenantRow[]>`
        SELECT t.*,
               p.legal_name_en AS parent_name,
               c.status AS asp_status,
               (SELECT count(*) FROM invoices i WHERE i.tenant_id = t.id AND i.direction = 'OUTBOUND_SALES_AR') AS invoice_count,
               (SELECT count(*) FROM users u WHERE u.tenant_id = t.id) AS user_count,
               (SELECT count(*) FROM tenants s WHERE s.parent_tenant_id = t.id) AS sub_tenant_count
        FROM tenants t
        LEFT JOIN tenants p ON p.id = t.parent_tenant_id
        LEFT JOIN tenant_asp_configs c ON c.tenant_id = t.id AND c.is_active
        WHERE t.id = ${id}
      `,
    );

    const row = rows[0];
    if (!row) throw notFound('Tenant');

    const detail: TenantDetail = {
      ...toSummary(row),
      subTenantCount: Number(row.sub_tenant_count ?? 0),
      isVatGroup: row.is_vat_group,
      vatGroupTrn: row.vat_group_trn,
      registeredAddress: row.registered_address as TenantDetail['registeredAddress'],
      userCount: Number(row.user_count ?? 0),
      updatedAt: row.updated_at.toISOString(),
    };

    return reply.send(detail);
  });

  // --- Platform: update ----------------------------------------------------
  app.patch('/api/v1/admin/tenants/:id', { preHandler: requirePlatform() }, async (request, reply) => {
    const ctx = requireContext(request);
    const { id } = request.params as { id: string };
    const body = UpdateTenantRequest.parse(request.body);

    const updated = await withPlatformAccess(async (tx) => {
      const existing = await tx<TenantRow[]>`SELECT * FROM tenants WHERE id = ${id}`;
      const before = existing[0];
      if (!before) throw notFound('Tenant');

      // Locked means locked. The one edit that gets through is the unlock
      // itself, or the lock would be a door with no handle on the inside.
      const keys = Object.keys(body);
      const unlockOnly = keys.length === 1 && keys[0] === 'isLocked' && body.isLocked === false;
      if (before.is_locked && !unlockOnly) {
        throw badRequest(
          `${before.legal_name_en} is locked. Unlock it before editing. Locking does not affect filing — use Suspend for that.`,
        );
      }

      // A tenant that claims VAT group membership must name the group, whether
      // the flag or the TRN was the field being edited.
      const isVatGroup = body.isVatGroup ?? before.is_vat_group;
      const vatGroupTrn =
        body.vatGroupTrn !== undefined ? body.vatGroupTrn : before.vat_group_trn;
      if (isVatGroup && !vatGroupTrn) {
        throw badRequest('A VAT group TRN is required when the tenant is part of a VAT group.');
      }

      await tx`
        UPDATE tenants SET
          is_locked          = ${body.isLocked ?? before.is_locked},
          legal_name_en      = ${body.legalNameEn ?? before.legal_name_en},
          legal_name_ar      = ${body.legalNameAr ?? before.legal_name_ar},
          is_vat_group       = ${isVatGroup},
          vat_group_trn      = ${vatGroupTrn},
          registered_address = ${jsonb(tx, body.registeredAddress ?? before.registered_address)}
        WHERE id = ${id}
      `;

      return diff(before as unknown as Record<string, unknown>, {
        legal_name_en: body.legalNameEn,
        legal_name_ar: body.legalNameAr,
        is_vat_group: body.isVatGroup,
        vat_group_trn: body.vatGroupTrn,
      });
    });

    await audit(actorFromContext(ctx), {
      action: 'TENANT_UPDATED',
      resourceType: 'TENANT',
      resourceId: id,
      tenantId: id,
      changes: updated,
    });

    return reply.status(204).send();
  });

  // --- Platform: status ----------------------------------------------------
  app.post(
    '/api/v1/admin/tenants/:id/status',
    { preHandler: requirePlatform() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      const body = UpdateTenantStatusRequest.parse(request.body);

      await withPlatformAccess(async (tx) => {
        const rows = await tx<{ status: string; tenant_type: TenantType }[]>`
          SELECT status, tenant_type FROM tenants WHERE id = ${id}
        `;
        if (!rows[0]) throw notFound('Tenant');

        // A channel partner resells capacity and never files, so it has no
        // provider connection to check — and holding it to one made a
        // suspended partner impossible to reactivate through any screen. The
        // promise activation makes is "this account can do its job", and a
        // partner's job is onboarding sub-tenants, not submitting documents.
        if (body.status === 'ACTIVE' && rows[0].tenant_type !== 'CHANNEL_PARTNER') {
          // Activation is a promise that invoices can actually be filed. If the
          // provider connection is not live, that promise is false, and the
          // merchant would discover it only at submission time.
          const configs = await tx<{ status: string }[]>`
            SELECT status FROM tenant_asp_configs WHERE tenant_id = ${id} AND is_active
          `;
          if (configs[0]?.status !== 'ACTIVE') {
            throw badRequest(
              'This tenant cannot be activated until their ASP connection is configured and marked active.',
            );
          }
        }

        await tx`
          UPDATE tenants SET status = ${body.status}::tenant_status, status_reason = ${body.reason ?? null}
          WHERE id = ${id}
        `;
      });

      await audit(actorFromContext(ctx), {
        action: 'TENANT_STATUS_CHANGED',
        resourceType: 'TENANT',
        resourceId: id,
        tenantId: id,
        changes: { status: body.status, reason: body.reason ?? null },
      });

      return reply.status(204).send();
    },
  );

  // --- Merchant: own profile ----------------------------------------------
  app.get('/api/v1/tenant/profile', { preHandler: requireAuth() }, async (request, reply) => {
    const ctx = requireContext(request);
    if (!ctx.tenantId) throw notFound('Tenant');

    const rows = await sql()<TenantRow[]>`
      SELECT t.*, p.legal_name_en AS parent_name, c.status AS asp_status,
             (SELECT count(*) FROM invoices i WHERE i.tenant_id = t.id AND i.direction = 'OUTBOUND_SALES_AR') AS invoice_count,
             (SELECT count(*) FROM users u WHERE u.tenant_id = t.id) AS user_count,
             (SELECT count(*) FROM tenants s WHERE s.parent_tenant_id = t.id) AS sub_tenant_count
      FROM tenants t
      LEFT JOIN tenants p ON p.id = t.parent_tenant_id
      LEFT JOIN tenant_asp_configs c ON c.tenant_id = t.id AND c.is_active
      WHERE t.id = ${ctx.tenantId}
    `;

    const row = rows[0];
    if (!row) throw notFound('Tenant');

    return reply.send({
      ...toSummary(row),
      subTenantCount: Number(row.sub_tenant_count ?? 0),
      isVatGroup: row.is_vat_group,
      vatGroupTrn: row.vat_group_trn,
      registeredAddress: row.registered_address,
      userCount: Number(row.user_count ?? 0),
      updatedAt: row.updated_at.toISOString(),
    });
  });

  // A merchant may correct their own presentation details. The TRN and company
  // code are not editable here — they are identity, they appear on filed
  // invoices, and changing them is a platform-administrator action.
  app.patch('/api/v1/tenant/profile', { preHandler: requireAuth() }, async (request, reply) => {
    const ctx = requireContext(request);
    if (!ctx.tenantId) throw notFound('Tenant');
    if (!ctxCan(ctx, 'tenant.profile.manage')) {
      throw forbidden('Only a company administrator can change the company profile.');
    }

    const body = UpdateTenantRequest.pick({
      legalNameEn: true,
      legalNameAr: true,
      registeredAddress: true,
    }).parse(request.body);

    await sql()`
      UPDATE tenants SET
        legal_name_en      = coalesce(${body.legalNameEn ?? null}, legal_name_en),
        legal_name_ar      = coalesce(${body.legalNameAr ?? null}, legal_name_ar),
        registered_address = ${
          body.registeredAddress ? jsonb(sql(), body.registeredAddress) : sql()`registered_address`
        }
      WHERE id = ${ctx.tenantId}
    `;

    await audit(actorFromContext(ctx), {
      action: 'TENANT_UPDATED',
      resourceType: 'TENANT',
      resourceId: ctx.tenantId,
      tenantId: ctx.tenantId,
      changes: body,
    });

    return reply.status(204).send();
  });
}
