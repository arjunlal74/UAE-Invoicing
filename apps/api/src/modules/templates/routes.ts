import { ALL_RULES } from '@uae/domain';
import type { FastifyInstance } from 'fastify';
import { withTenant } from '../../db/client.js';
import { requireAuth, requireContext, requirePermission } from '../../http/context.js';
import { notFound } from '../../lib/errors.js';
import { buildTemplate } from '../../excel/template.js';

export function registerTemplateRoutes(app: FastifyInstance) {
  /**
   * The template is generated per tenant rather than served as a static file,
   * so the merchant's own supplier TRN and legal name arrive pre-filled and
   * locked. Those two columns are otherwise a steady source of upload errors.
   */
  app.get(
    '/api/v1/templates/invoice-template.xlsx',
    { preHandler: requirePermission('invoice.read') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const rows = await withTenant(
        ctx.tenantId,
        (tx) => tx<{ trn: string; legal_name_en: string; company_code: string }[]>`
          SELECT trn, legal_name_en, company_code FROM tenants WHERE id = ${ctx.tenantId}
        `,
      );

      const tenant = rows[0];
      if (!tenant) throw notFound('Tenant');

      const buffer = await buildTemplate({
        supplierTrn: tenant.trn,
        supplierName: tenant.legal_name_en,
      });

      const stamp = new Date().toISOString().slice(0, 10);
      return reply
        .header(
          'content-type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        .header(
          'content-disposition',
          `attachment; filename="UAE-Invoice-Template-${tenant.company_code}-${stamp}.xlsx"`,
        )
        .send(buffer);
    },
  );

  /**
   * The rule catalogue, so the portal can show users what is checked and the
   * admin panel can list the rule vocabulary without duplicating it.
   */
  app.get('/api/v1/validation-rules', { preHandler: requireAuth() }, async (_request, reply) => {
    return reply.send({
      items: ALL_RULES.map((rule) => ({
        code: rule.code,
        severity: rule.severity,
        title: rule.title,
        xpath: rule.xpath ?? null,
      })),
      total: ALL_RULES.length,
      note: 'Hand-implemented against the UAE rule vocabulary. Replace with the FTA published Schematron when available.',
    });
  });
}
