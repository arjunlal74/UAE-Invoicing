import {
  CreateSubTenantRequest,
  type PartnerOverview,
  type SubTenantSummary,
} from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { createInvite } from '../../auth/service.js';
import { config } from '../../config.js';
import { jsonb, withPlatformAccess } from '../../db/client.js';
import { requireContext, requirePartner } from '../../http/context.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { logger } from '../../logger.js';

/**
 * The channel partner portal (SRS v2.1 §2).
 *
 * A partner administrator manages the companies underneath it and nothing else:
 * these routes never expose a sub-tenant's invoices or staged rows, only the
 * roll-up a reseller needs to see who is onboarded and how much they are
 * filing. Every query is anchored on `parent_tenant_id = <the caller's tenant>`,
 * so one partner cannot read another's book of clients even by guessing ids.
 *
 * Reads run through `withPlatformAccess` because row-level security scopes a
 * connection to a single tenant, and a partner legitimately spans several. The
 * parent filter below is what replaces RLS here, so it is not optional.
 */

interface SubTenantRow {
  id: string;
  company_code: string;
  legal_name_en: string;
  trn: string | null;
  status: SubTenantSummary['status'];
  asp_status: SubTenantSummary['aspStatus'] | null;
  invoice_count: string;
  user_count: string;
  created_at: Date;
}

function toSubTenant(row: SubTenantRow): SubTenantSummary {
  return {
    id: row.id,
    companyCode: row.company_code,
    legalNameEn: row.legal_name_en,
    trn: row.trn,
    status: row.status,
    aspStatus: row.asp_status ?? 'NOT_CONFIGURED',
    invoiceCount: Number(row.invoice_count ?? 0),
    userCount: Number(row.user_count ?? 0),
    createdAt: row.created_at.toISOString(),
  };
}

/** The caller's own tenant, which must be the channel partner itself. */
function partnerTenantId(ctx: { tenantId: string | null }): string {
  if (!ctx.tenantId) throw forbidden('A partner administrator must belong to a partner tenant.');
  return ctx.tenantId;
}

export function registerPartnerRoutes(app: FastifyInstance) {
  // --- Roll-up across the partner's book -----------------------------------
  app.get('/api/v1/partner/overview', { preHandler: requirePartner() }, async (request, reply) => {
    const ctx = requireContext(request);
    const tenantId = partnerTenantId(ctx);

    const rows = await withPlatformAccess(
      (tx) => tx<
        {
          partner_name: string;
          sub_tenant_count: string;
          active_sub_tenant_count: string;
          invoice_count: string;
          accepted_invoice_count: string;
        }[]
      >`
        SELECT p.legal_name_en AS partner_name,
               count(s.id)::text AS sub_tenant_count,
               count(s.id) FILTER (WHERE s.status = 'ACTIVE')::text AS active_sub_tenant_count,
               (SELECT count(*) FROM invoices i
                 WHERE i.tenant_id IN (
                   SELECT id FROM tenants WHERE parent_tenant_id = p.id
                 ))::text AS invoice_count,
               (SELECT count(*) FROM invoices i
                 WHERE i.status = 'ACCEPTED_BY_FTA'
                   AND i.tenant_id IN (
                     SELECT id FROM tenants WHERE parent_tenant_id = p.id
                   ))::text AS accepted_invoice_count
        FROM tenants p
        LEFT JOIN tenants s ON s.parent_tenant_id = p.id
        WHERE p.id = ${tenantId}
        GROUP BY p.id, p.legal_name_en
      `,
    );

    const row = rows[0];
    if (!row) throw notFound('Partner');

    const overview: PartnerOverview = {
      partnerName: row.partner_name,
      subTenantCount: Number(row.sub_tenant_count),
      activeSubTenantCount: Number(row.active_sub_tenant_count),
      invoiceCount: Number(row.invoice_count),
      acceptedInvoiceCount: Number(row.accepted_invoice_count),
    };
    return reply.send(overview);
  });

  // --- The partner's sub-tenants -------------------------------------------
  app.get(
    '/api/v1/partner/sub-tenants',
    { preHandler: requirePartner() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const tenantId = partnerTenantId(ctx);
      const query = request.query as { q?: string; status?: string };

      const rows = await withPlatformAccess(
        (tx) => tx<SubTenantRow[]>`
          SELECT t.id, t.company_code, t.legal_name_en, t.trn, t.status, t.created_at,
                 c.status AS asp_status,
                 (SELECT count(*) FROM invoices i WHERE i.tenant_id = t.id) AS invoice_count,
                 (SELECT count(*) FROM users u WHERE u.tenant_id = t.id) AS user_count
          FROM tenants t
          LEFT JOIN tenant_asp_configs c ON c.tenant_id = t.id AND c.is_active
          WHERE t.parent_tenant_id = ${tenantId}
            AND (${query.q ?? null}::text IS NULL
                 OR t.legal_name_en ILIKE ${'%' + (query.q ?? '') + '%'}
                 OR t.company_code ILIKE ${'%' + (query.q ?? '') + '%'}
                 OR coalesce(t.trn, '') ILIKE ${'%' + (query.q ?? '') + '%'})
            AND (${query.status ?? null}::text IS NULL OR t.status::text = ${query.status ?? null})
          ORDER BY t.created_at DESC
        `,
      );

      return reply.send({
        items: rows.map(toSubTenant),
        total: rows.length,
        page: 1,
        pageSize: rows.length,
      });
    },
  );

  // --- Onboard a sub-tenant -------------------------------------------------
  app.post(
    '/api/v1/partner/sub-tenants',
    { preHandler: requirePartner() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const tenantId = partnerTenantId(ctx);
      const body = CreateSubTenantRequest.parse(request.body);

      const result = await withPlatformAccess(async (tx) => {
        const partners = await tx<{ tenant_type: string; status: string }[]>`
          SELECT tenant_type::text, status::text FROM tenants WHERE id = ${tenantId}
        `;
        const partner = partners[0];
        if (!partner) throw notFound('Partner');
        if (partner.tenant_type !== 'CHANNEL_PARTNER') {
          throw forbidden('Only a channel partner can onboard sub-tenants.');
        }
        // A suspended reseller must not be able to keep growing its book.
        if (partner.status === 'SUSPENDED' || partner.status === 'ARCHIVED') {
          throw badRequest('This partner account is not active, so sub-tenants cannot be added.');
        }

        const inserted = await tx<{ id: string }[]>`
          INSERT INTO tenants (
            tenant_type, parent_tenant_id, company_code, legal_name_en, legal_name_ar,
            trn, registered_address, status
          ) VALUES (
            'MANAGED_SUB_TENANT', ${tenantId}, ${body.companyCode},
            ${body.legalNameEn}, ${body.legalNameAr}, ${body.trn},
            ${jsonb(tx, body.registeredAddress)}, 'PENDING'
          )
          RETURNING id
        `;
        const subTenantId = inserted[0]!.id;

        // Same reasoning as direct onboarding: a config row always exists so
        // the provider screen has something concrete to edit.
        await tx`
          INSERT INTO tenant_asp_configs (tenant_id, provider_type, display_name, status)
          VALUES (${subTenantId}, ${config().ASP_DEFAULT_DRIVER}::asp_provider_type,
                  'Not yet selected', 'NOT_CONFIGURED')
        `;

        const users = await tx<{ id: string }[]>`
          INSERT INTO users (tenant_id, email, full_name, role, is_active)
          VALUES (${subTenantId}, ${body.adminEmail}, ${body.adminFullName},
                  'COMPANY_ADMIN', FALSE)
          RETURNING id
        `;

        return { subTenantId, inviteToken: await createInvite(users[0]!.id, tx) };
      });

      await audit(actorFromContext(ctx), {
        action: 'SUB_TENANT_CREATED',
        resourceType: 'TENANT',
        resourceId: result.subTenantId,
        tenantId: result.subTenantId,
        changes: {
          parentTenantId: tenantId,
          companyCode: body.companyCode,
          legalNameEn: body.legalNameEn,
          trn: body.trn,
        },
      });

      const inviteUrl = `${config().PORTAL_ORIGIN}/accept-invite?token=${result.inviteToken}`;
      logger.info({ subTenantId: result.subTenantId, inviteUrl }, 'sub-tenant admin invite created');

      return reply.status(201).send({ id: result.subTenantId, inviteUrl });
    },
  );
}
