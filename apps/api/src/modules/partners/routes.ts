import {
  CreateSubTenantRequest,
  UpdateSubTenantRequest,
  type PartnerOverview,
  type SubTenantSummary,
} from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import {
  createInvite,
  sendAdminPasswordReset,
  setMustRotatePassword,
} from '../../auth/service.js';
import { queueActivation } from '../../mail/outbox.js';
import { config } from '../../config.js';
import { jsonb, withPlatformAccess } from '../../db/client.js';
import { requireContext, requirePartner } from '../../http/context.js';
import { parsePeriod } from '../metering/period.js';
import { loadTenantStatement } from '../metering/report.js';
import { sendStatement } from '../metering/statementExport.js';
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
  legal_name_ar: string | null;
  registered_address: SubTenantSummary['registeredAddress'];
  trn: string | null;
  peppol_participant_id: string | null;
  status: SubTenantSummary['status'];
  is_locked: boolean;
  asp_status: SubTenantSummary['aspStatus'] | null;
  provisioning_mode: SubTenantSummary['provisioningMode'];
  custody_staff_count: string;
  invoice_count: string;
  user_count: string;
  created_at: Date;
}

function toSubTenant(row: SubTenantRow): SubTenantSummary {
  return {
    id: row.id,
    companyCode: row.company_code,
    legalNameEn: row.legal_name_en,
    legalNameAr: row.legal_name_ar,
    registeredAddress: row.registered_address,
    trn: row.trn,
    peppolParticipantId: row.peppol_participant_id,
    status: row.status,
    isLocked: row.is_locked,
    aspStatus: row.asp_status ?? 'NOT_CONFIGURED',
    provisioningMode: row.provisioning_mode,
    custodyStaffCount: Number(row.custody_staff_count ?? 0),
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
               -- Outbound only: a partner's roll-up is about what their clients
               -- have filed, which is also what draws down the master bundle.
               (SELECT count(*) FROM invoices i
                 WHERE i.direction = 'OUTBOUND_SALES_AR'
                   AND i.tenant_id IN (
                     SELECT id FROM tenants WHERE parent_tenant_id = p.id
                   ))::text AS invoice_count,
               (SELECT count(*) FROM invoices i
                 WHERE i.direction = 'OUTBOUND_SALES_AR'
                   AND i.status = 'ACCEPTED_BY_FTA'
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

  // --- Inventory statements, the partner's own and its clients' ------------
  //
  // The same statement the host reads about this partner, served to the partner
  // itself: bundles bought from the platform and slices allocated out. It may
  // also read one of its own sub-tenants' — that is its book of clients — but
  // the parent check below is what makes "its own" mean anything, so a guessed
  // id reads as not found rather than as somebody else's business.
  app.get(
    '/api/v1/partner/inventory/report',
    { preHandler: requirePartner() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const partnerId = partnerTenantId(ctx);
      const { tenantId } = request.query as { tenantId?: string };

      if (tenantId && tenantId !== partnerId) {
        const owned = await withPlatformAccess(
          (tx) => tx<{ id: string }[]>`
            SELECT id FROM tenants
            WHERE id = ${tenantId} AND parent_tenant_id = ${partnerId}
          `,
        );
        if (!owned[0]) throw notFound('Sub-tenant');
      }

      return reply.send(
        await loadTenantStatement(tenantId ?? partnerId, parsePeriod(request.query)),
      );
    },
  );

  // The same statement as a file. The ownership check above is repeated rather
  // than shared: a partner must not be able to print a statement it is not
  // allowed to read, and the cheapest way to guarantee that is for the export
  // route to make the same check itself instead of trusting a caller.
  for (const format of ['pdf', 'xlsx'] as const) {
    app.get(
      `/api/v1/partner/inventory/report.${format}`,
      { preHandler: requirePartner() },
      async (request, reply) => {
        const ctx = requireContext(request);
        const partnerId = partnerTenantId(ctx);
        const { tenantId } = request.query as { tenantId?: string };

        if (tenantId && tenantId !== partnerId) {
          const owned = await withPlatformAccess(
            (tx) => tx<{ id: string }[]>`
              SELECT id FROM tenants
              WHERE id = ${tenantId} AND parent_tenant_id = ${partnerId}
            `,
          );
          if (!owned[0]) throw notFound('Sub-tenant');
        }

        return sendStatement(
          request,
          reply,
          await loadTenantStatement(tenantId ?? partnerId, parsePeriod(request.query)),
          format,
        );
      },
    );
  }

  // --- The partner's sub-tenants -------------------------------------------
  app.get(
    '/api/v1/partner/sub-tenants',
    { preHandler: requirePartner() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const tenantId = partnerTenantId(ctx);
      // The dashboard counts a kind of trouble and links here; without the same
      // filters the partner lands on every client and has to find the rows the
      // tile was counting, which is the work the tile was supposed to have done.
      const query = request.query as {
        q?: string;
        status?: string;
        aspStatus?: string;
        invites?: string;
        mode?: string;
      };

      const rows = await withPlatformAccess(
        (tx) => tx<SubTenantRow[]>`
          SELECT t.id, t.company_code, t.legal_name_en, t.legal_name_ar, t.trn,
                 t.peppol_participant_id, t.registered_address, t.status, t.is_locked,
                 t.created_at, t.provisioning_mode,
                 c.status AS asp_status,
                 (SELECT count(*) FROM partner_custody_grants g
                   WHERE g.tenant_id = t.id AND g.revoked_at IS NULL) AS custody_staff_count,
                 (SELECT count(*) FROM invoices i WHERE i.tenant_id = t.id AND i.direction = 'OUTBOUND_SALES_AR') AS invoice_count,
                 (SELECT count(*) FROM users u WHERE u.tenant_id = t.id) AS user_count
          FROM tenants t
          LEFT JOIN tenant_asp_configs c ON c.tenant_id = t.id AND c.is_active
          WHERE t.parent_tenant_id = ${tenantId}
            AND (${query.q ?? null}::text IS NULL
                 OR t.legal_name_en ILIKE ${'%' + (query.q ?? '') + '%'}
                 OR t.company_code ILIKE ${'%' + (query.q ?? '') + '%'}
                 OR coalesce(t.trn, '') ILIKE ${'%' + (query.q ?? '') + '%'})
            AND (${query.status ?? null}::text IS NULL OR t.status::text = ${query.status ?? null})
            -- 'NOT_LIVE' is a connection that exists and is not live, which is
            -- what the dashboard tile linking here counts. A sub-tenant is given
            -- a configuration row the moment it is onboarded, so this reads the
            -- same way for every client in the book.
            AND (${query.aspStatus ?? null}::text IS NULL
                 OR (${query.aspStatus ?? null} = 'NOT_LIVE'
                     AND c.status IS NOT NULL AND c.status::text <> 'ACTIVE')
                 OR c.status::text = ${query.aspStatus ?? null})
            -- A client whose administrator never accepted the invitation. The
            -- partner sent it, so the partner is who chases it.
            AND (${query.invites ?? null}::text IS DISTINCT FROM 'pending'
                 OR EXISTS (SELECT 1 FROM users u
                            WHERE u.tenant_id = t.id AND u.password_hash IS NULL))
            -- §3: which clients the partner runs itself, and which run themselves.
            AND (${query.mode ?? null}::text IS NULL
                 OR t.provisioning_mode::text = ${query.mode ?? null})
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
        const partners = await tx<{ tenant_type: string; status: string; legal_name_en: string }[]>`
          SELECT tenant_type::text, status::text, legal_name_en
          FROM tenants WHERE id = ${tenantId}
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
            trn, registered_address, status, provisioning_mode
          ) VALUES (
            'MANAGED_SUB_TENANT', ${tenantId}, ${body.companyCode},
            ${body.legalNameEn}, ${body.legalNameAr}, ${body.trn},
            ${jsonb(tx, body.registeredAddress)}, 'PENDING',
            ${body.provisioningMode}::provisioning_mode
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

        // §3: a custody client has no administrator of its own. Creating one
        // "just in case" would leave a dormant login on an account the partner
        // is supposed to be holding, and an invitation nobody was expecting is
        // exactly the mail that gets reported as a phishing attempt.
        if (body.provisioningMode === 'FULLY_MANAGED_CUSTODY') {
          return { subTenantId, partnerName: partner.legal_name_en, invite: null };
        }

        const users = await tx<{ id: string }[]>`
          INSERT INTO users (tenant_id, email, full_name, role, is_active)
          VALUES (${subTenantId}, ${body.adminEmail!}, ${body.adminFullName!},
                  'COMPANY_ADMIN', FALSE)
          RETURNING id
        `;

        return {
          subTenantId,
          partnerName: partner.legal_name_en,
          invite: { userId: users[0]!.id, token: await createInvite(users[0]!.id, tx) },
        };
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
          provisioningMode: body.provisioningMode,
        },
      });

      if (!result.invite) {
        logger.info(
          { subTenantId: result.subTenantId },
          'custody sub-tenant created; no client administrator invited',
        );
        return reply.status(201).send({
          id: result.subTenantId,
          provisioningMode: body.provisioningMode,
          inviteUrl: null,
          emailed: false,
          emailMessage: null,
        });
      }

      const inviteUrl = `${config().PORTAL_ORIGIN}/accept-invite?token=${result.invite.token}`;

      // Template B rather than A: this client was provisioned by their
      // accountant, so the mail names the partner and points setup questions at
      // them instead of at a support desk that has never heard of the client.
      const mail = await queueActivation({
        to: body.adminEmail!,
        contactName: body.adminFullName!,
        companyName: body.legalNameEn,
        activationUrl: inviteUrl,
        partner: { name: result.partnerName, contactEmail: ctx.email },
        userId: result.invite.userId,
        tenantId: result.subTenantId,
      });

      logger.info(
        { subTenantId: result.subTenantId, emailed: mail.queued },
        'sub-tenant admin invite created',
      );

      return reply.status(201).send({
        id: result.subTenantId,
        provisioningMode: body.provisioningMode,
        inviteUrl,
        emailed: mail.queued,
        emailMessage: mail.reason ?? null,
      });
    },
  );

  // --- Correcting a client's record ----------------------------------------
  //
  // A partner keeps its clients' details up to date — a company renames itself,
  // an office moves — without going through the platform for it. What it cannot
  // touch is the TRN or the company code: those identify the company on every
  // document already filed under it, so changing one is not a correction but a
  // different company, and the contract does not carry them.
  app.patch(
    '/api/v1/partner/sub-tenants/:id',
    { preHandler: requirePartner() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const partnerId = partnerTenantId(ctx);
      const { id } = request.params as { id: string };
      const body = UpdateSubTenantRequest.parse(request.body);

      const changes = await withPlatformAccess(async (tx) => {
        const rows = await tx<
          {
            legal_name_en: string;
            legal_name_ar: string;
            registered_address: unknown;
            is_locked: boolean;
          }[]
        >`
          SELECT legal_name_en, legal_name_ar, registered_address, is_locked
          FROM tenants
          WHERE id = ${id} AND parent_tenant_id = ${partnerId}
        `;
        const before = rows[0];
        if (!before) throw notFound('Sub-tenant');

        // The platform's lock freezes the record against everyone, including
        // the partner that owns the client. A reseller cannot unlock it either
        // — that is the point of a lock the platform put on.
        if (before.is_locked) {
          throw badRequest(
            `${before.legal_name_en} is locked by the platform. Ask them to unlock it before editing.`,
          );
        }

        await tx`
          UPDATE tenants SET
            legal_name_en      = ${body.legalNameEn ?? before.legal_name_en},
            legal_name_ar      = ${body.legalNameAr ?? before.legal_name_ar},
            registered_address = ${jsonb(tx, body.registeredAddress ?? before.registered_address)}
          WHERE id = ${id}
        `;

        return {
          legalNameEn:
            body.legalNameEn && body.legalNameEn !== before.legal_name_en
              ? { from: before.legal_name_en, to: body.legalNameEn }
              : undefined,
          legalNameAr:
            body.legalNameAr && body.legalNameAr !== before.legal_name_ar
              ? { from: before.legal_name_ar, to: body.legalNameAr }
              : undefined,
          registeredAddress: body.registeredAddress ?? undefined,
        };
      });

      await audit(actorFromContext(ctx), {
        action: 'TENANT_UPDATED',
        resourceType: 'TENANT',
        resourceId: id,
        tenantId: id,
        changes: { by: 'channel partner', ...changes },
      });

      return reply.status(204).send();
    },
  );

  // --- Credential actions on sub-tenant users (SRS v2.3 §4.3) --------------
  //
  // A partner administers its clients' accounts, so it gets the same two
  // write-only actions a company admin has — but only over users belonging to
  // a sub-tenant it actually owns, which is what the parent check enforces.

  app.post(
    '/api/v1/partner/users/:id/send-reset',
    { preHandler: requirePartner() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };

      await assertUserUnderPartner(id, partnerTenantId(ctx));
      const result = await sendAdminPasswordReset(id, ctx.ip ?? null);

      await audit(actorFromContext(ctx), {
        action: 'PASSWORD_RESET_REQUESTED',
        resourceType: 'USER',
        resourceId: id,
        changes: { by: 'channel partner', emailed: result.sent },
      });

      return reply.send(result);
    },
  );

  app.post(
    '/api/v1/partner/users/:id/force-rotation',
    { preHandler: requirePartner() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };

      await assertUserUnderPartner(id, partnerTenantId(ctx));
      await setMustRotatePassword(id, true);

      await audit(actorFromContext(ctx), {
        action: 'PASSWORD_ROTATION_REQUIRED',
        resourceType: 'USER',
        resourceId: id,
      });

      return reply.status(204).send();
    },
  );
}

/**
 * The target must belong to a sub-tenant of this partner.
 *
 * Checked through tenants.parent_tenant_id rather than by trusting a tenant id
 * from the request, so a partner cannot reset an unrelated company's users by
 * guessing a user id.
 */
export async function assertUserUnderPartner(userId: string, partnerId: string): Promise<void> {
  const rows = await withPlatformAccess(
    (tx) => tx<{ id: string }[]>`
      SELECT u.id FROM users u
      JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = ${userId} AND t.parent_tenant_id = ${partnerId}
    `,
  );
  if (!rows[0]) throw notFound('User');
}
