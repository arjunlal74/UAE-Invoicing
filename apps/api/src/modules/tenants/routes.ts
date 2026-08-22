import {
  CreateTenantRequest,
  UpdateTenantRequest,
  UpdateTenantStatusRequest,
  can,
  type TenantDetail,
  type TenantSummary,
  type TenantType,
} from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit, diff } from '../../audit/audit.js';
import { createInvite } from '../../auth/service.js';
import { config } from '../../config.js';
import { jsonb, sql, withPlatformAccess } from '../../db/client.js';
import { requireAuth, requireContext, requirePlatform } from '../../http/context.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { logger } from '../../logger.js';

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
    aspStatus: row.asp_status ?? 'NOT_CONFIGURED',
    invoiceCount: Number(row.invoice_count ?? 0),
    createdAt: row.created_at.toISOString(),
  };
}

export function registerTenantRoutes(app: FastifyInstance) {
  // --- Platform: list ------------------------------------------------------
  app.get('/api/v1/admin/tenants', { preHandler: requirePlatform() }, async (request, reply) => {
    const query = request.query as { q?: string; status?: string; tenantType?: string };

    const rows = await withPlatformAccess(
      (tx) => tx<TenantRow[]>`
        SELECT t.*,
               p.legal_name_en AS parent_name,
               c.status AS asp_status,
               (SELECT count(*) FROM invoices i WHERE i.tenant_id = t.id) AS invoice_count
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
        ORDER BY t.created_at DESC
      `,
    );

    return reply.send({ items: rows.map(toSummary), total: rows.length, page: 1, pageSize: rows.length });
  });

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

      // Every tenant gets an ASP configuration row up front, in the
      // NOT_CONFIGURED state, so the admin panel always has something concrete
      // to show and edit rather than a special "no config yet" case.
      await tx`
        INSERT INTO tenant_asp_configs (tenant_id, provider_type, display_name, status)
        VALUES (${tenantId}, ${config().ASP_DEFAULT_DRIVER}::asp_provider_type,
                'Not yet selected', 'NOT_CONFIGURED')
      `;

      let inviteToken: string | null = null;
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
      }

      return { tenantId, inviteToken };
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

    // No mail transport is wired up, so the invite link is returned to the
    // admin to pass on. Replace with an email send when SES/SMTP is chosen.
    if (result.inviteToken) {
      logger.info(
        { tenantId: result.tenantId, inviteUrl: `${config().PORTAL_ORIGIN}/accept-invite?token=${result.inviteToken}` },
        'tenant admin invite created',
      );
    }

    return reply.status(201).send({
      id: result.tenantId,
      inviteUrl: result.inviteToken
        ? `${config().PORTAL_ORIGIN}/accept-invite?token=${result.inviteToken}`
        : null,
    });
  });

  // --- Platform: detail ----------------------------------------------------
  app.get('/api/v1/admin/tenants/:id', { preHandler: requirePlatform() }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const rows = await withPlatformAccess(
      (tx) => tx<TenantRow[]>`
        SELECT t.*,
               p.legal_name_en AS parent_name,
               c.status AS asp_status,
               (SELECT count(*) FROM invoices i WHERE i.tenant_id = t.id) AS invoice_count,
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
        const rows = await tx<{ status: string }[]>`SELECT status FROM tenants WHERE id = ${id}`;
        if (!rows[0]) throw notFound('Tenant');

        if (body.status === 'ACTIVE') {
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
             (SELECT count(*) FROM invoices i WHERE i.tenant_id = t.id) AS invoice_count,
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
    if (!can(ctx.role, 'tenant.profile.manage')) {
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
