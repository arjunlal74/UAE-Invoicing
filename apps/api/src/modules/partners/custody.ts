import {
  ChangeProvisioningModeRequest,
  GrantCustodyAccessRequest,
  type CustodyGrant,
  type PartnerStaffMember,
  type ProvisioningMode,
  type Role,
} from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { createInvite, issueCustodySession } from '../../auth/service.js';
import { config } from '../../config.js';
import { sql, withPlatformAccess } from '../../db/client.js';
import { requireContext, requirePartner } from '../../http/context.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { logger } from '../../logger.js';
import { queueActivation } from '../../mail/outbox.js';

/**
 * Fully managed custody (SRS §3).
 *
 * The second of the two ways a managed sub-tenant exists. In the collaborative
 * mode the client is invited and works for itself; in custody the partner —
 * typically an auditing firm — holds the account, and its own staff sign in and
 * act for the client. Everything that makes that safe lives in this file:
 *
 *   - a named authorisation per member of staff, per client, carrying the role
 *     they hold *inside that client's books*;
 *   - a session that is scoped to the client rather than to the partner, so
 *     row-level security is doing the isolation rather than a promise not to
 *     read the wrong rows;
 *   - an audit trail that says which of the partner's people did it.
 *
 * A partner administrator is not implicitly authorised for its own clients.
 * That looks like an inconvenience and is the point: "who was allowed into this
 * company's tax records, and who let them in" has to be answerable from one
 * table with no exceptions in it, and an implicit grant is an exception that
 * never appears in the answer.
 */

/** The caller's own tenant, which must be the channel partner itself. */
function partnerTenantId(ctx: { tenantId: string | null }): string {
  if (!ctx.tenantId) throw forbidden('A partner administrator must belong to a partner tenant.');
  return ctx.tenantId;
}

interface SubTenantRecord {
  id: string;
  legal_name_en: string;
  status: string;
  provisioning_mode: ProvisioningMode;
}

/**
 * The client, if it really is one of this partner's.
 *
 * A tenant that is not theirs reads as not found rather than as forbidden: a
 * partner has no business learning which ids exist elsewhere on the platform.
 */
async function subTenantOf(partnerId: string, tenantId: string): Promise<SubTenantRecord> {
  const rows = await withPlatformAccess(
    (tx) => tx<SubTenantRecord[]>`
      SELECT id, legal_name_en, status::text AS status, provisioning_mode
      FROM tenants
      WHERE id = ${tenantId} AND parent_tenant_id = ${partnerId}
    `,
  );
  const row = rows[0];
  if (!row) throw notFound('Sub-tenant');
  return row;
}

function assertCustody(client: SubTenantRecord): void {
  if (client.provisioning_mode !== 'FULLY_MANAGED_CUSTODY') {
    throw badRequest(
      `${client.legal_name_en} is a collaborative client and runs its own account. Move it into fully managed custody first.`,
    );
  }
}

export function registerPartnerCustodyRoutes(app: FastifyInstance) {
  // --- A client's own users ------------------------------------------------
  //
  // Read by the dialog that moves a client into custody: taking an account over
  // while its former staff still hold live logins is the mistake this list
  // exists to make visible, and the deactivation below is how it is fixed.
  app.get(
    '/api/v1/partner/sub-tenants/:id/users',
    { preHandler: requirePartner() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const partnerId = partnerTenantId(ctx);
      const { id } = request.params as { id: string };

      await subTenantOf(partnerId, id);

      const rows = await withPlatformAccess(
        (tx) => tx<
          {
            id: string;
            email: string;
            full_name: string;
            role: Role;
            is_active: boolean;
            has_signed_in: boolean;
            mfa_enabled: boolean;
            last_login_at: Date | null;
            created_at: Date;
          }[]
        >`
          SELECT id, email, full_name, role, is_active,
                 password_hash IS NOT NULL AS has_signed_in,
                 mfa_enabled, last_login_at, created_at
          FROM users WHERE tenant_id = ${id}
          ORDER BY full_name
        `,
      );

      // The client's people, in the same shape as the partner's own: this list
      // is read beside that one, and two shapes for "a person with a login"
      // would be two things to keep in step.
      const items: PartnerStaffMember[] = rows.map((row) => ({
        id: row.id,
        email: row.email,
        fullName: row.full_name,
        role: row.role,
        isActive: row.is_active,
        hasSignedIn: row.has_signed_in,
        mfaEnabled: row.mfa_enabled,
        lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
        createdAt: row.created_at.toISOString(),
      }));

      return reply.send({ items, total: items.length, page: 1, pageSize: items.length });
    },
  );

  // --- Who may act for one custody client ----------------------------------
  app.get(
    '/api/v1/partner/sub-tenants/:id/custody-staff',
    { preHandler: requirePartner() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const partnerId = partnerTenantId(ctx);
      const { id } = request.params as { id: string };

      await subTenantOf(partnerId, id);
      return reply.send({ items: await liveGrants(id) });
    },
  );

  app.post(
    '/api/v1/partner/sub-tenants/:id/custody-staff',
    { preHandler: requirePartner() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const partnerId = partnerTenantId(ctx);
      const { id } = request.params as { id: string };
      const body = GrantCustodyAccessRequest.parse(request.body);

      const client = await subTenantOf(partnerId, id);
      assertCustody(client);

      const granted = await withPlatformAccess(async (tx) => {
        // The person must be the partner's own. Checked here rather than
        // trusted from the request: this is the line between "my firm's staff"
        // and "any user id on the platform".
        const staff = await tx<{ id: string; full_name: string; is_active: boolean }[]>`
          SELECT id, full_name, is_active FROM users
          WHERE id = ${body.userId} AND tenant_id = ${partnerId}
        `;
        const member = staff[0];
        if (!member) throw notFound('Member of staff');
        if (!member.is_active) {
          throw badRequest('That account is deactivated and cannot be authorised.');
        }

        const existing = await tx<{ id: string }[]>`
          SELECT id FROM partner_custody_grants
          WHERE tenant_id = ${id} AND user_id = ${body.userId} AND revoked_at IS NULL
        `;
        if (existing[0]) {
          throw badRequest(
            `${member.full_name} is already authorised for this client. Withdraw the authorisation first to give them a different role.`,
          );
        }

        const inserted = await tx<{ id: string }[]>`
          INSERT INTO partner_custody_grants (tenant_id, user_id, role, granted_by_user_id)
          VALUES (${id}, ${body.userId}, ${body.role}::user_role, ${ctx.userId})
          RETURNING id
        `;
        return { grantId: inserted[0]!.id, fullName: member.full_name };
      });

      await audit(actorFromContext(ctx), {
        action: 'CUSTODY_ACCESS_GRANTED',
        resourceType: 'TENANT',
        resourceId: id,
        tenantId: id,
        changes: { userId: body.userId, staffName: granted.fullName, role: body.role },
      });

      logger.info(
        { tenantId: id, userId: body.userId, role: body.role },
        'custody access granted',
      );

      return reply.status(201).send({ id: granted.grantId });
    },
  );

  app.delete(
    '/api/v1/partner/custody-grants/:grantId',
    { preHandler: requirePartner() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const partnerId = partnerTenantId(ctx);
      const { grantId } = request.params as { grantId: string };

      const revoked = await withPlatformAccess(async (tx) => {
        const rows = await tx<{ id: string; tenant_id: string; user_id: string }[]>`
          SELECT g.id, g.tenant_id, g.user_id
          FROM partner_custody_grants g
          JOIN tenants t ON t.id = g.tenant_id
          WHERE g.id = ${grantId} AND t.parent_tenant_id = ${partnerId} AND g.revoked_at IS NULL
        `;
        const grant = rows[0];
        if (!grant) throw notFound('Authorisation');

        await tx`
          UPDATE partner_custody_grants SET revoked_at = CURRENT_TIMESTAMP WHERE id = ${grantId}
        `;
        return grant;
      });

      // Withdrawing an authorisation has to end the sessions it opened.
      // Leaving them alive would mean access continues for as long as somebody
      // keeps a tab open, which is not what anyone means by "withdrawn".
      await sql()`
        UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP
        WHERE user_id = ${revoked.user_id}
          AND acting_tenant_id = ${revoked.tenant_id}
          AND revoked_at IS NULL
      `;

      await audit(actorFromContext(ctx), {
        action: 'CUSTODY_ACCESS_REVOKED',
        resourceType: 'TENANT',
        resourceId: revoked.tenant_id,
        tenantId: revoked.tenant_id,
        changes: { userId: revoked.user_id, grantId },
      });

      return reply.status(204).send();
    },
  );

  // --- Working inside a client ---------------------------------------------
  //
  // The session that comes back is scoped to the client: its tenant is the
  // client, its role is the one the grant carries, and it refreshes as itself
  // until the authorisation is withdrawn. The partner's own session is
  // untouched — the portal keeps it and swaps back when they leave — so this
  // is an additional session rather than a transformation of one, and either
  // can be ended without disturbing the other.
  app.post(
    '/api/v1/partner/sub-tenants/:id/custody-session',
    { preHandler: requirePartner() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const partnerId = partnerTenantId(ctx);
      const { id } = request.params as { id: string };

      const client = await subTenantOf(partnerId, id);
      assertCustody(client);
      if (client.status === 'ARCHIVED') {
        throw badRequest('This client is archived. Its books are closed to new sessions.');
      }

      const rows = await withPlatformAccess(
        (tx) => tx<{ role: Role; partner_name: string }[]>`
          SELECT g.role, p.legal_name_en AS partner_name
          FROM partner_custody_grants g
          JOIN tenants p ON p.id = ${partnerId}
          WHERE g.tenant_id = ${id} AND g.user_id = ${ctx.userId} AND g.revoked_at IS NULL
        `,
      );
      const grant = rows[0];
      if (!grant) {
        throw forbidden(
          `You are not authorised to act for ${client.legal_name_en}. A partner administrator can add you to its authorised staff.`,
        );
      }

      const session = await issueCustodySession(
        ctx.userId,
        {
          tenantId: client.id,
          tenantName: client.legal_name_en,
          tenantStatus: client.status,
          role: grant.role,
          partnerTenantId: partnerId,
          partnerName: grant.partner_name,
        },
        { ip: ctx.ip, userAgent: ctx.userAgent },
      );

      await audit(actorFromContext(ctx), {
        action: 'CUSTODY_SESSION_STARTED',
        resourceType: 'TENANT',
        resourceId: id,
        tenantId: id,
        changes: { actingRole: grant.role, partnerTenantId: partnerId },
      });

      logger.info(
        { tenantId: id, userId: ctx.userId, role: grant.role },
        'custody session opened',
      );

      return reply.send(session);
    },
  );

  // --- Moving a client between the two modes -------------------------------
  app.patch(
    '/api/v1/partner/sub-tenants/:id/provisioning-mode',
    { preHandler: requirePartner() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const partnerId = partnerTenantId(ctx);
      const { id } = request.params as { id: string };
      const body = ChangeProvisioningModeRequest.parse(request.body);

      const client = await subTenantOf(partnerId, id);
      if (client.provisioning_mode === body.provisioningMode) {
        return reply.send({ id, provisioningMode: body.provisioningMode, inviteUrl: null });
      }

      const outcome =
        body.provisioningMode === 'FULLY_MANAGED_CUSTODY'
          ? await takeIntoCustody(id)
          : await handBackToClient(id, client.legal_name_en, body, {
              name: await partnerName(partnerId),
              contactEmail: ctx.email,
            });

      await audit(actorFromContext(ctx), {
        action: 'SUB_TENANT_MODE_CHANGED',
        resourceType: 'TENANT',
        resourceId: id,
        tenantId: id,
        changes: {
          from: client.provisioning_mode,
          to: body.provisioningMode,
          invitedAdministrator: outcome.invitedEmail ?? null,
        },
      });

      return reply.send({
        id,
        provisioningMode: body.provisioningMode,
        ...outcome.reply,
      });
    },
  );

  // --- Taking a client's own logins out of use -----------------------------
  //
  // The other half of taking an account into custody. Deliberately deactivation
  // and not deletion: the person stays on the record as the author of whatever
  // they filed, and the partner can put them back if the arrangement changes.
  app.post(
    '/api/v1/partner/users/:id/deactivate',
    { preHandler: requirePartner() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const partnerId = partnerTenantId(ctx);
      const { id } = request.params as { id: string };

      const user = await withPlatformAccess(async (tx) => {
        const rows = await tx<{ id: string; tenant_id: string; email: string }[]>`
          SELECT u.id, u.tenant_id, u.email
          FROM users u
          JOIN tenants t ON t.id = u.tenant_id
          WHERE u.id = ${id} AND t.parent_tenant_id = ${partnerId}
        `;
        const found = rows[0];
        if (!found) throw notFound('User');

        await tx`UPDATE users SET is_active = FALSE WHERE id = ${id}`;
        return found;
      });

      await sql()`
        UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP
        WHERE user_id = ${id} AND revoked_at IS NULL
      `;

      await audit(actorFromContext(ctx), {
        action: 'USER_DEACTIVATED',
        resourceType: 'USER',
        resourceId: id,
        tenantId: user.tenant_id,
        changes: { by: 'channel partner', email: user.email },
      });

      return reply.status(204).send();
    },
  );
}

async function partnerName(partnerId: string): Promise<string> {
  const rows = await withPlatformAccess(
    (tx) => tx<{ legal_name_en: string }[]>`
      SELECT legal_name_en FROM tenants WHERE id = ${partnerId}
    `,
  );
  if (!rows[0]) throw notFound('Partner');
  return rows[0].legal_name_en;
}

async function liveGrants(tenantId: string): Promise<CustodyGrant[]> {
  const rows = await withPlatformAccess(
    (tx) => tx<
      {
        id: string;
        tenant_id: string;
        user_id: string;
        user_name: string;
        user_email: string;
        role: Role;
        granted_by_name: string | null;
        created_at: Date;
      }[]
    >`
      SELECT g.id, g.tenant_id, g.user_id, u.full_name AS user_name, u.email AS user_email,
             g.role, b.full_name AS granted_by_name, g.created_at
      FROM partner_custody_grants g
      JOIN users u ON u.id = g.user_id
      LEFT JOIN users b ON b.id = g.granted_by_user_id
      WHERE g.tenant_id = ${tenantId} AND g.revoked_at IS NULL
      ORDER BY u.full_name
    `,
  );

  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    role: row.role,
    grantedByName: row.granted_by_name,
    createdAt: row.created_at.toISOString(),
  }));
}

interface ModeChangeOutcome {
  invitedEmail?: string;
  reply: { inviteUrl: string | null; emailed?: boolean; clientUsersStillActive?: number };
}

/**
 * Collaborative → custody.
 *
 * The client's own logins are left alone. Disabling somebody's access to their
 * own tax records as a side effect of a switch the partner made is not a
 * decision this endpoint gets to take quietly — so it reports how many are
 * still live and leaves the partner to deactivate them deliberately.
 */
async function takeIntoCustody(tenantId: string): Promise<ModeChangeOutcome> {
  const rows = await withPlatformAccess(async (tx) => {
    await tx`
      UPDATE tenants SET provisioning_mode = 'FULLY_MANAGED_CUSTODY' WHERE id = ${tenantId}
    `;
    return tx<{ count: string }[]>`
      SELECT count(*)::text AS count FROM users WHERE tenant_id = ${tenantId} AND is_active
    `;
  });

  return {
    reply: { inviteUrl: null, clientUsersStillActive: Number(rows[0]?.count ?? 0) },
  };
}

/**
 * Custody → collaborative: handing the keys over.
 *
 * Two things happen together because they are the same act. The client gets an
 * administrator — the one it already has, or a new one who is invited now —
 * and every custody authorisation ends, along with the sessions those
 * authorisations opened. Acting on behalf of a company is a custody
 * arrangement; once the company runs itself, the partner's staff work in it as
 * its own invited users or not at all.
 */
async function handBackToClient(
  tenantId: string,
  clientName: string,
  body: { adminEmail?: string; adminFullName?: string },
  partner: { name: string; contactEmail: string },
): Promise<ModeChangeOutcome> {
  const result = await withPlatformAccess(async (tx) => {
    const admins = await tx<{ id: string }[]>`
      SELECT id FROM users
      WHERE tenant_id = ${tenantId} AND role = 'COMPANY_ADMIN' AND is_active
    `;

    if (!admins[0] && !(body.adminEmail && body.adminFullName)) {
      throw badRequest(
        'This client has no administrator of its own. Give the name and e-mail of the person who will run the account.',
      );
    }

    await tx`UPDATE tenants SET provisioning_mode = 'COLLABORATIVE' WHERE id = ${tenantId}`;

    const ended = await tx<{ user_id: string }[]>`
      UPDATE partner_custody_grants SET revoked_at = CURRENT_TIMESTAMP
      WHERE tenant_id = ${tenantId} AND revoked_at IS NULL
      RETURNING user_id
    `;

    if (admins[0]) return { invite: null, endedUserIds: ended.map((r) => r.user_id) };

    const users = await tx<{ id: string }[]>`
      INSERT INTO users (tenant_id, email, full_name, role, is_active)
      VALUES (${tenantId}, ${body.adminEmail!}, ${body.adminFullName!}, 'COMPANY_ADMIN', FALSE)
      RETURNING id
    `;

    return {
      invite: { userId: users[0]!.id, token: await createInvite(users[0]!.id, tx) },
      endedUserIds: ended.map((r) => r.user_id),
    };
  });

  for (const userId of result.endedUserIds) {
    await sql()`
      UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP
      WHERE user_id = ${userId} AND acting_tenant_id = ${tenantId} AND revoked_at IS NULL
    `;
  }

  if (!result.invite) return { reply: { inviteUrl: null } };

  const inviteUrl = `${config().PORTAL_ORIGIN}/accept-invite?token=${result.invite.token}`;
  const mail = await queueActivation({
    to: body.adminEmail!,
    contactName: body.adminFullName!,
    companyName: clientName,
    activationUrl: inviteUrl,
    // Template B again: the client is hearing from the firm that has been
    // running its account, not from a support desk it has never dealt with.
    partner,
    userId: result.invite.userId,
    tenantId,
  });

  return {
    invitedEmail: body.adminEmail,
    reply: { inviteUrl, emailed: mail.queued },
  };
}
