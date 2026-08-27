import { REPORT_CATALOG, ReportKey } from '@uae/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { withTenant } from '../../db/client.js';
import { requireContext, requirePermission } from '../../http/context.js';
import { notFound } from '../../lib/errors.js';
import { formatDay } from '../../pdf/document.js';
import { sendPdf } from '../../pdf/reply.js';
import { renderAnalyticsPdf, renderReportPdf } from '../../pdf/report.js';
import { buildAnalytics, runReport } from './service.js';

/**
 * The §13 reporting endpoints.
 *
 * Every report is served twice: as JSON, which the portal draws as a table and
 * transforms into CSV client-side, and as a PDF for the copy that gets filed,
 * emailed or handed to an auditor. Both renderings call the same query in
 * `service.ts`, so the printout and the screen cannot disagree.
 */

export function registerReportRoutes(app: FastifyInstance) {
  // --- §13.1 the KPI dashboard ---------------------------------------------
  app.get(
    '/api/v1/reports/analytics',
    { preHandler: requirePermission('reports.read') },
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const { dateFrom, dateTo } = dates(request);
      return reply.send(await buildAnalytics(tenantId, dateFrom, dateTo));
    },
  );

  app.get(
    '/api/v1/reports/analytics/pdf',
    { preHandler: requirePermission('reports.read') },
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const { dateFrom, dateTo } = dates(request);

      const [analytics, tenantName] = await Promise.all([
        buildAnalytics(tenantId, dateFrom, dateTo),
        tenantNameOf(tenantId),
      ]);

      const pdf = await renderAnalyticsPdf({
        analytics,
        dateFrom,
        dateTo,
        tenantName,
        platformName: config().PLATFORM_NAME,
      });

      return sendPdf(request, reply, pdf, `dispute-analytics-${today()}`);
    },
  );

  // --- §13.2 the report catalogue ------------------------------------------
  app.get(
    '/api/v1/reports',
    { preHandler: requirePermission('reports.read') },
    async (_request, reply) => reply.send({ reports: REPORT_CATALOG }),
  );

  /**
   * One report as rows.
   *
   * Returned as JSON with an explicit column list rather than as a rendered
   * file. The portal draws the table and offers CSV from the same data, so
   * "export" is a client-side transform of exactly what the user is looking at
   * — which is the only way the two can be guaranteed to agree.
   */
  app.get(
    '/api/v1/reports/:key',
    { preHandler: requirePermission('reports.read') },
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const { dateFrom, dateTo } = dates(request);
      const key = ReportKey.parse((request.params as { key: string }).key);

      return reply.send(await runReport(tenantId, key, dateFrom, dateTo));
    },
  );

  /** The same report, typeset. */
  app.get(
    '/api/v1/reports/:key/pdf',
    { preHandler: requirePermission('reports.read') },
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const { dateFrom, dateTo } = dates(request);
      const key = ReportKey.parse((request.params as { key: string }).key);

      const [report, tenantName] = await Promise.all([
        runReport(tenantId, key, dateFrom, dateTo),
        tenantNameOf(tenantId),
      ]);

      const pdf = await renderReportPdf({
        ...report,
        dateFrom,
        dateTo,
        tenantName,
        platformName: config().PLATFORM_NAME,
      });

      return sendPdf(request, reply, pdf, `${key}-${today()}`);
    },
  );
}

// ---------------------------------------------------------------------------

function tenantOf(request: FastifyRequest): string {
  const ctx = requireContext(request);
  if (!ctx.tenantId) throw notFound('Tenant');
  return ctx.tenantId;
}

function dates(request: FastifyRequest): { dateFrom: string | null; dateTo: string | null } {
  const query = request.query as { dateFrom?: string; dateTo?: string };
  return { dateFrom: query.dateFrom || null, dateTo: query.dateTo || null };
}

async function tenantNameOf(tenantId: string): Promise<string> {
  const rows = await withTenant(
    tenantId,
    (tx) => tx<{ legal_name_en: string }[]>`
      SELECT legal_name_en FROM tenants WHERE id = ${tenantId}
    `,
  );
  return rows[0]?.legal_name_en ?? 'Unknown tenant';
}

function today(): string {
  return formatDay(new Date()).replace(/ /g, '-');
}
