import {
  AddressSchema,
  UpdatePlatformCompanyRequest,
  type PlatformCompany,
} from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { config } from '../../config.js';
import { jsonb, withPlatformAccess } from '../../db/client.js';
import { requireContext, requirePermission, requirePlatform } from '../../http/context.js';
import { badRequest, notFound } from '../../lib/errors.js';

/**
 * The platform owner's own company profile.
 *
 * The system knew every tenant's legal identity and nothing about the company
 * running it, which held only as long as nobody had to answer "who issued this
 * bundle invoice". One row, created by its migration and edited here — never
 * created, never deleted, because a platform without an identity is not a
 * state worth being able to reach.
 */

interface CompanyRow {
  legal_name_en: string;
  legal_name_ar: string;
  trading_name: string | null;
  trn: string | null;
  registered_address: unknown;
  contact_email: string | null;
  contact_phone: string | null;
  website: string | null;
  logo_mime: string | null;
  logo_file_name: string | null;
  logo_updated_at: Date | null;
  updated_at: Date;
}

/**
 * What a browser will render inline and a PDF can embed. SVG is accepted
 * because a logo is line art and scales, but it is served with a content type
 * and never inlined into a page, so a script inside one has nothing to run in.
 */
const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']);
const LOGO_MAX_BYTES = 512 * 1024;

function toCompany(row: CompanyRow): PlatformCompany {
  // The column starts as `{}` and an address is only an address once it names
  // an emirate, so a partial one reads as absent rather than as a parse failure
  // on the very first GET of a fresh install.
  const address = AddressSchema.safeParse(row.registered_address ?? {});

  return {
    legalNameEn: row.legal_name_en,
    legalNameAr: row.legal_name_ar,
    tradingName: row.trading_name,
    trn: row.trn,
    registeredAddress: address.success ? address.data : null,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    website: row.website,
    hasLogo: row.logo_mime !== null,
    logoFileName: row.logo_file_name,
    logoUpdatedAt: row.logo_updated_at ? row.logo_updated_at.toISOString() : null,
    updatedAt: row.updated_at.toISOString(),
  };
}

const COMPANY_SELECT = `
  legal_name_en, legal_name_ar, trading_name, trn, registered_address,
  contact_email, contact_phone, website, logo_mime, logo_file_name,
  logo_updated_at, updated_at
`;

async function load(): Promise<CompanyRow> {
  const rows = await withPlatformAccess((tx) =>
    tx.unsafe<CompanyRow[]>(`SELECT ${COMPANY_SELECT} FROM platform_company WHERE id`, []),
  );
  const row = rows[0];
  if (!row) throw notFound('Platform company');
  return row;
}

export function registerPlatformCompanyRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/admin/platform/company',
    { preHandler: requirePlatform() },
    async (_request, reply) => {
      const company = toCompany(await load());
      // The deployment's own name is the fallback until someone fills the
      // record in, so a fresh install shows something rather than a blank.
      if (!company.legalNameEn) company.legalNameEn = config().PLATFORM_NAME;
      return reply.send(company);
    },
  );

  app.patch(
    '/api/v1/admin/platform/company',
    { preHandler: requirePermission('platform.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const body = UpdatePlatformCompanyRequest.parse(request.body);

      await withPlatformAccess(async (tx) => {
        // `coalesce` per column so an omitted field is left alone, while an
        // explicit null clears it — a PATCH should be able to express both.
        await tx`
          UPDATE platform_company SET
            legal_name_en      = coalesce(${body.legalNameEn ?? null}, legal_name_en),
            legal_name_ar      = coalesce(${body.legalNameAr ?? null}, legal_name_ar),
            trading_name       = ${
              body.tradingName === undefined ? tx.unsafe('trading_name') : body.tradingName
            },
            trn                = ${body.trn === undefined ? tx.unsafe('trn') : body.trn},
            registered_address = coalesce(
              ${body.registeredAddress ? jsonb(tx, body.registeredAddress) : null},
              registered_address
            ),
            contact_email      = ${
              body.contactEmail === undefined ? tx.unsafe('contact_email') : body.contactEmail
            },
            contact_phone      = ${
              body.contactPhone === undefined ? tx.unsafe('contact_phone') : body.contactPhone
            },
            website            = ${body.website === undefined ? tx.unsafe('website') : body.website}
          WHERE id
        `;
      });

      await audit(actorFromContext(ctx), {
        action: 'PLATFORM_COMPANY_UPDATED',
        resourceType: 'PLATFORM_COMPANY',
        resourceId: null,
        tenantId: null,
        changes: { fields: Object.keys(body) },
      });

      return reply.send(toCompany(await load()));
    },
  );

  // --- The logo ------------------------------------------------------------
  app.post(
    '/api/v1/admin/platform/company/logo',
    { preHandler: requirePermission('platform.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);

      const file = await request.file();
      if (!file) throw badRequest('No file was uploaded.');
      if (!LOGO_TYPES.has(file.mimetype)) {
        throw badRequest('A logo must be a PNG, JPEG, SVG or WebP image.');
      }

      const buffer = await file.toBuffer();
      // The multipart limit is sized for invoice workbooks and would let a
      // 50MB "logo" through, so the real bound is here.
      if (file.file.truncated || buffer.length > LOGO_MAX_BYTES) {
        throw badRequest(`A logo must be smaller than ${LOGO_MAX_BYTES / 1024}KB.`);
      }
      if (buffer.length === 0) throw badRequest('That file is empty.');

      await withPlatformAccess(async (tx) => {
        await tx`
          UPDATE platform_company SET
            logo_bytes      = ${buffer},
            logo_mime       = ${file.mimetype},
            logo_file_name  = ${file.filename ?? 'logo'},
            logo_updated_at = now()
          WHERE id
        `;
      });

      await audit(actorFromContext(ctx), {
        action: 'PLATFORM_LOGO_SET',
        resourceType: 'PLATFORM_COMPANY',
        resourceId: null,
        tenantId: null,
        changes: { fileName: file.filename, mimeType: file.mimetype, sizeBytes: buffer.length },
      });

      return reply.send(toCompany(await load()));
    },
  );

  app.delete(
    '/api/v1/admin/platform/company/logo',
    { preHandler: requirePermission('platform.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);

      await withPlatformAccess(async (tx) => {
        await tx`
          UPDATE platform_company SET
            logo_bytes = NULL, logo_mime = NULL,
            logo_file_name = NULL, logo_updated_at = NULL
          WHERE id
        `;
      });

      await audit(actorFromContext(ctx), {
        action: 'PLATFORM_LOGO_CLEARED',
        resourceType: 'PLATFORM_COMPANY',
        resourceId: null,
        tenantId: null,
        changes: {},
      });

      return reply.send(toCompany(await load()));
    },
  );

  /**
   * The logo itself, unauthenticated.
   *
   * An `<img>` carries no bearer token, and this is the one part of the record
   * meant to be looked at: it is branding, it goes on correspondence, and it is
   * shown on screens a user reaches before signing in. Bytes only — the name,
   * the TRN and the address stay behind the authenticated route above.
   */
  app.get('/api/v1/platform/logo', async (_request, reply) => {
    const rows = await withPlatformAccess(
      (tx) => tx<{ logo_bytes: Buffer | null; logo_mime: string | null }[]>`
        SELECT logo_bytes, logo_mime FROM platform_company WHERE id
      `,
    );
    const row = rows[0];
    if (!row?.logo_bytes || !row.logo_mime) throw notFound('Logo');

    // Revalidate every time rather than cache for a day: replacing a logo and
    // then being told to clear your browser cache is a poor answer.
    return reply
      .header('content-type', row.logo_mime)
      .header('cache-control', 'no-cache')
      .send(row.logo_bytes);
  });
}
