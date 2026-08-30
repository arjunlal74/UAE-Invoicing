import { REASON_CODE_LABELS, REPORT_CATALOG, ReportKey } from '@uae/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { withTenant } from '../../db/client.js';
import { requireContext, requirePermission } from '../../http/context.js';
import { notFound } from '../../lib/errors.js';
import { renderReportXlsx, renderWorkbookXlsx } from '../../excel/report.js';
import { sendXlsx } from '../../excel/reply.js';
import { formatDay } from '../../pdf/document.js';
import { sendPdf } from '../../pdf/reply.js';
import { renderAnalyticsPdf, renderReportPdf } from '../../pdf/report.js';
import { buildAnalytics, runReport } from './service.js';

/**
 * The §13 reporting endpoints.
 *
 * Every report is served three ways: as JSON, which the portal draws as a
 * table; as a PDF for the copy that gets filed, emailed or handed to an
 * auditor; and as a workbook for the reader who is going to pivot it. All
 * three call the same query in `service.ts`, so no two of them can disagree.
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

  app.get(
    '/api/v1/reports/analytics/xlsx',
    { preHandler: requirePermission('reports.read') },
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const { dateFrom, dateTo } = dates(request);

      const [analytics, tenantName] = await Promise.all([
        buildAnalytics(tenantId, dateFrom, dateTo),
        tenantNameOf(tenantId),
      ]);

      const period = periodLabel(dateFrom, dateTo);
      const common = { periodLabel: period, holderName: tenantName };

      // Four tabs rather than one sheet with four tables stacked on it: a
      // stacked sheet cannot be sorted or filtered without destroying the
      // tables below the one being worked on.
      const workbook = await renderWorkbookXlsx([
        {
          ...common,
          sheetName: 'KPIs',
          title: 'Dispute Analytics',
          subtitle: 'Key figures',
          columns: ['Measure', 'Value'],
          rows: [
            ['Outbound documents', analytics.kpis.outboundTotal],
            ['Outbound disputed', analytics.kpis.outboundDisputed],
            ['Sales dispute rate %', analytics.kpis.salesDisputeRatePct],
            ['Inbound documents', analytics.kpis.inboundTotal],
            ['Inbound rejected', analytics.kpis.inboundRejected],
            ['Purchase dispute rate %', analytics.kpis.purchaseDisputeRatePct],
            ['Input VAT claimable (AED)', analytics.kpis.inputVatClaimableAed],
            ['Input VAT blocked (AED)', analytics.kpis.inputVatBlockedAed],
            ['Average resolution (days)', analytics.kpis.averageResolutionDays ?? 'No resolutions yet'],
            ['Open disputes', analytics.kpis.openDisputes],
            ['Unresolved over 30 days', analytics.kpis.unresolvedOver30Days],
          ],
        },
        {
          ...common,
          sheetName: 'Dispute aging',
          title: 'Outbound dispute aging',
          columns: ['Bucket', 'Count', 'Amount (AED)'],
          rows: analytics.aging.map((row) => [row.bucket, row.count, row.amountAed]),
        },
        {
          ...common,
          sheetName: 'Reason Pareto',
          title: 'Rejection reasons',
          columns: ['Reason', 'Outbound', 'Inbound', 'Total', 'Cumulative %'],
          rows: analytics.pareto.map((row) => [
            `${row.reasonCode} — ${REASON_CODE_LABELS[row.reasonCode]}`,
            row.outbound,
            row.inbound,
            row.total,
            row.cumulativePct,
          ]),
        },
        {
          ...common,
          sheetName: 'Supplier scorecard',
          title: 'Supplier scorecard',
          columns: ['Supplier', 'TRN', 'Received', 'Rejected', 'Queried', 'Rejection rate %', 'Top reason'],
          rows: analytics.supplierScorecard.map((row) => [
            row.supplierName,
            row.trn ?? '—',
            row.received,
            row.rejected,
            row.queried,
            row.rejectionRatePct,
            row.topReason ? `${row.topReason} — ${REASON_CODE_LABELS[row.topReason]}` : '—',
          ]),
        },
      ]);

      return sendXlsx(reply, workbook, `dispute-analytics-${today()}`);
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

  /** The same report, in a spreadsheet. */
  app.get(
    '/api/v1/reports/:key/xlsx',
    { preHandler: requirePermission('reports.read') },
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const { dateFrom, dateTo } = dates(request);
      const key = ReportKey.parse((request.params as { key: string }).key);

      const [report, tenantName] = await Promise.all([
        runReport(tenantId, key, dateFrom, dateTo),
        tenantNameOf(tenantId),
      ]);

      const workbook = await renderReportXlsx({
        sheetName: report.name,
        title: report.name,
        subtitle: report.description,
        periodLabel: periodLabel(dateFrom, dateTo),
        holderName: tenantName,
        columns: report.columns,
        rows: report.rows,
        truncated: report.truncated,
      });

      return sendXlsx(reply, workbook, `${key}-${today()}`);
    },
  );
}

/** "From 1 Jan 2026 to 31 Mar 2026", or an honest description of an open end. */
function periodLabel(from: string | null, to: string | null): string {
  if (from && to) return `From ${formatDay(from)} to ${formatDay(to)}`;
  if (from) return `From ${formatDay(from)}`;
  if (to) return `Up to ${formatDay(to)}`;
  return 'All dates';
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
