import {
  CreatePartnerStaffRequest,
  UpdatePartnerStaffRequest,
  type PartnerStaffMember,
  type Role,
} from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { createInvite } from '../../auth/service.js';
import { config } from '../../config.js';
import { sql, withPlatformAccess } from '../../db/client.js';
import { requireContext, requirePartner } from '../../http/context.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { logger } from '../../logger.js';
import { queueActivation } from '../../mail/outbox.js';

/**
 * The channel partner's own people.
 *
 * A firm managing thirty clients has more than one person doing it, and until
 * now the only way to add the second was for the platform to do it. These
 * routes give a partner the same authority over its own staff that a company
 * administrator has over theirs — invite, correct, lock out — bounded by
 * `tenant_id = <the caller's partner>` on every statement, so one firm cannot
 * reach another's people even by guessing an id.
 *
 * Everyone here is a PARTNER_ADMIN. It is the only role that means anything at
 * a partner tenant: the console, and the custody sessions opened from it, are
 * behind `partner.read`, which no other role holds. What separates a junior
 * from a signatory is not their role at the firm but the role their custody
 * grant carries inside each client's books — see custody.ts.
 */

const PARTNER_STAFF_ROLE: Role = 'PARTNER_ADMIN';

interface StaffRow {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  has_signed_in: boolean;
  mfa_enabled: boolean;
  last_login_at: Date | null;
  created_at: Date;
}

const STAFF_COLUMNS = `
  id, email, full_name, role, is_active,
  password_hash IS NOT NULL AS has_signed_in,
  mfa_enabled, last_login_at, created_at
`;

function toStaff(row: StaffRow): PartnerStaffMember {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    isActive: row.is_active,
    hasSignedIn: row.has_signed_in,
    mfaEnabled: row.mfa_enabled,
    lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

function partnerTenantId(ctx: { tenantId: string | null }): string {
  if (!ctx.tenantId) throw forbidden('A partner administrator must belong to a partner tenant.');
  return ctx.tenantId;
}

/** The person, if they really are one of this partner's own. */
async function staffOf(partnerId: string, userId: string): Promise<StaffRow> {
  const rows = await withPlatformAccess(
    (tx) => tx<StaffRow[]>`
      SELECT ${tx.unsafe(STAFF_COLUMNS)} FROM users
      WHERE id = ${userId} AND tenant_id = ${partnerId}
    `,
  );
  if (!rows[0]) throw notFound('Member of staff');
  return rows[0];
}

export function registerPartnerStaffRoutes(app: FastifyInstance) {
  app.get('/api/v1/partner/staff', { preHandler: requirePartner() }, async (request, reply) => {
    const ctx = requireContext(request);
    const partnerId = partnerTenantId(ctx);
    const query = request.query as { q?: string; status?: string };

    const rows = await withPlatformAccess(
      (tx) => tx<StaffRow[]>`
        SELECT ${tx.unsafe(STAFF_COLUMNS)} FROM users
        WHERE tenant_id = ${partnerId}
          AND (${query.q ?? null}::text IS NULL
               OR full_name ILIKE ${'%' + (query.q ?? '') + '%'}
               OR email ILIKE ${'%' + (query.q ?? '') + '%'})
          -- Locked accounts stay in the list by default. A firm asking "who has
          -- access" needs to see the ones that do not, which is why they are
          -- filtered rather than hidden.
          AND (${query.status ?? null}::text IS NULL
               OR (${query.status ?? null} = 'active' AND is_active)
               OR (${query.status ?? null} = 'locked' AND NOT is_active)
               OR (${query.status ?? null} = 'pending' AND password_hash IS NULL))
        ORDER BY full_name
      `,
    );

    const items = rows.map(toStaff);
    return reply.send({ items, total: items.length, page: 1, pageSize: items.length });
  });

  app.post('/api/v1/partner/staff', { preHandler: requirePartner() }, async (request, reply) => {
    const ctx = requireContext(request);
    const partnerId = partnerTenantId(ctx);
    const body = CreatePartnerStaffRequest.parse(request.body);

    const created = await withPlatformAccess(async (tx) => {
      // The address is unique across the platform, so the useful answer is not
      // "that failed" but which of the two things happened: your own colleague
      // is already here, or the address belongs to somebody else entirely.
      const clash = await tx<{ tenant_id: string | null }[]>`
        SELECT tenant_id FROM users WHERE email = ${body.email}
      `;
      if (clash[0]) {
        throw badRequest(
          clash[0].tenant_id === partnerId
            ? 'Somebody on your staff already uses that address.'
            : 'That e-mail address is already in use on the platform.',
        );
      }

      // Active from the moment they are invited, unlike the other invite paths
      // in this codebase, because on this screen `is_active` is the lock. An
      // account created inactive would arrive wearing the badge that means "a
      // partner administrator shut this person out", and the lock button beside
      // it would have nothing left to do. Nothing is granted by it: sign-in
      // refuses an account with no password at all, so what actually gates them
      // is the invitation they have not accepted yet.
      const rows = await tx<{ id: string }[]>`
        INSERT INTO users (tenant_id, email, full_name, role, is_active)
        VALUES (${partnerId}, ${body.email}, ${body.fullName},
                ${PARTNER_STAFF_ROLE}::user_role, TRUE)
        RETURNING id
      `;
      const userId = rows[0]!.id;

      const partners = await tx<{ legal_name_en: string }[]>`
        SELECT legal_name_en FROM tenants WHERE id = ${partnerId}
      `;

      return {
        userId,
        partnerName: partners[0]?.legal_name_en ?? 'your firm',
        token: await createInvite(userId, tx),
      };
    });

    await audit(actorFromContext(ctx), {
      action: 'USER_INVITED',
      resourceType: 'USER',
      resourceId: created.userId,
      tenantId: partnerId,
      changes: { email: body.email, role: PARTNER_STAFF_ROLE, by: 'channel partner' },
    });

    const inviteUrl = `${config().PORTAL_ORIGIN}/accept-invite?token=${created.token}`;
    const mail = await queueActivation({
      to: body.email,
      contactName: body.fullName,
      companyName: created.partnerName,
      activationUrl: inviteUrl,
      userId: created.userId,
      tenantId: partnerId,
    });

    logger.info(
      { userId: created.userId, emailed: mail.queued },
      'partner staff invite created',
    );

    return reply.status(201).send({
      id: created.userId,
      inviteUrl,
      emailed: mail.queued,
      emailMessage: mail.reason ?? null,
    });
  });

  app.patch(
    '/api/v1/partner/staff/:id',
    { preHandler: requirePartner() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const partnerId = partnerTenantId(ctx);
      const { id } = request.params as { id: string };
      const body = UpdatePartnerStaffRequest.parse(request.body);

      const before = await staffOf(partnerId, id);

      // Once somebody has signed in, their address is the credential they sign
      // in with and the one every notification has gone to. Before that it is
      // an unaccepted invitation with a typo in it, which is worth fixing.
      if (body.email && body.email !== before.email && before.has_signed_in) {
        throw badRequest(
          'This person has already signed in, so their e-mail address is how they log in and cannot be changed here. They can change it themselves, or you can lock the account and invite them again.',
        );
      }

      if (body.email && body.email !== before.email) {
        const clash = await withPlatformAccess(
          (tx) => tx<{ id: string }[]>`SELECT id FROM users WHERE email = ${body.email!}`,
        );
        if (clash[0]) throw badRequest('That e-mail address is already in use on the platform.');
      }

      await withPlatformAccess(
        (tx) => tx`
          UPDATE users SET
            full_name = ${body.fullName ?? before.full_name},
            email     = ${body.email ?? before.email}
          WHERE id = ${id}
        `,
      );

      await audit(actorFromContext(ctx), {
        action: 'USER_UPDATED',
        resourceType: 'USER',
        resourceId: id,
        tenantId: partnerId,
        changes: {
          by: 'channel partner',
          fullName:
            body.fullName && body.fullName !== before.full_name
              ? { from: before.full_name, to: body.fullName }
              : undefined,
          email:
            body.email && body.email !== before.email
              ? { from: before.email, to: body.email }
              : undefined,
        },
      });

      return reply.status(204).send();
    },
  );

  // --- Locking somebody out, and letting them back in ----------------------
  //
  // One switch on a login: locked means they cannot sign in, and every screen
  // that calls the same flag "deactivated" is talking about this. Deliberately
  // not a delete — the person stays on the record as the author of whatever
  // they filed, and the account can be opened again if they come back.
  for (const [verb, active] of [
    ['lock', false],
    ['unlock', true],
  ] as const) {
    app.post(
      `/api/v1/partner/staff/:id/${verb}`,
      { preHandler: requirePartner() },
      async (request, reply) => {
        const ctx = requireContext(request);
        const partnerId = partnerTenantId(ctx);
        const { id } = request.params as { id: string };

        // Locking yourself out of the console you are holding is never what
        // anybody meant, and there may be nobody else left to undo it.
        if (id === ctx.userId && !active) {
          throw badRequest('You cannot lock your own account.');
        }

        const before = await staffOf(partnerId, id);
        if (before.is_active === active) return reply.status(204).send();

        await withPlatformAccess(
          (tx) => tx`UPDATE users SET is_active = ${active} WHERE id = ${id}`,
        );

        // Locking has to end what is already open, including any custody
        // session this person has inside a client's books. An account somebody
        // can keep using until their tab is closed is not locked.
        if (!active) {
          await sql()`
            UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP
            WHERE user_id = ${id} AND revoked_at IS NULL
          `;
        }

        await audit(actorFromContext(ctx), {
          action: active ? 'USER_UPDATED' : 'USER_DEACTIVATED',
          resourceType: 'USER',
          resourceId: id,
          tenantId: partnerId,
          changes: { by: 'channel partner', locked: !active, email: before.email },
        });

        return reply.status(204).send();
      },
    );
  }
}
