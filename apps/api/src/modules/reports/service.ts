import {
  REPORT_CATALOG,
  type DisputeAnalytics,
  type RejectionReasonCode,
  type ReportKey,
} from '@uae/contracts';
import { withTenant, type Tx } from '../../db/client.js';

/**
 * The dispute and AP analytics suite — SRS v2.7 §13.
 *
 * Every figure here is computed in PostgreSQL rather than by pulling rows into
 * Node and reducing them. These are portfolio-wide aggregates over a table that
 * grows without bound, and the moment a tenant has a year of invoices the
 * difference between "one grouped query" and "fetch and count" is the
 * difference between a dashboard and a timeout.
 *
 * The queries live here rather than in the route handlers because each report
 * now has two renderings — JSON for the portal's table and CSV, and a PDF for
 * the copy that gets filed or handed to an auditor. Two endpoints reading two
 * copies of the same SQL is how a report and its printout start disagreeing.
 */

const ALL_REASON_CODES: RejectionReasonCode[] = ['REF', 'PRI', 'QTY', 'ITM', 'DEL', 'NON', 'OTH'];

/**
 * Row caps, per report.
 *
 * Stated as data rather than buried in each query so that a caller can tell the
 * reader when a result was cut short. A report that silently stops at five
 * thousand rows reads as "these are all of them", which on a reconciliation
 * report is a materially wrong statement.
 */
const ROW_LIMITS: Record<ReportKey, number> = {
  'ap-inbound-log': 5000,
  'supplier-scorecard': 100,
  'input-tax-reconciliation': 5000,
  'ar-dispute-aging': 5000,
  'rejection-pareto': ALL_REASON_CODES.length,
  'fta-non-compliance': 1000,
};

export interface ReportResult {
  key: ReportKey;
  name: string;
  module: 'AR' | 'AP' | 'BOTH';
  description: string;
  columns: string[];
  rows: string[][];
  /** True when the query hit `ROW_LIMITS[key]` and there may be more. */
  truncated: boolean;
}

export async function runReport(
  tenantId: string,
  key: ReportKey,
  dateFrom: string | null,
  dateTo: string | null,
): Promise<ReportResult> {
  const data = await withTenant(tenantId, (tx) => reportRows(tx, tenantId, key, dateFrom, dateTo));
  const meta = REPORT_CATALOG.find((report) => report.key === key)!;

  return {
    key,
    name: meta.name,
    module: meta.module,
    description: meta.description,
    columns: data.columns,
    rows: data.rows,
    truncated: data.rows.length >= ROW_LIMITS[key],
  };
}

async function reportRows(
  tx: Tx,
  tenantId: string,
  key: ReportKey,
  from: string | null,
  to: string | null,
): Promise<{ columns: string[]; rows: string[][] }> {
  switch (key) {
    case 'ap-inbound-log':
      return {
        columns: [
          'Invoice number',
          'Issue date',
          'Supplier',
          'Supplier TRN',
          'FTA IRN',
          'PO reference',
          'Net (AED)',
          'VAT (AED)',
          'Total (AED)',
          'Verdict',
          'AP posting',
        ],
        rows: (
          await tx<Record<string, string>[]>`
            SELECT i.invoice_number,
                   to_char(i.issue_date, 'YYYY-MM-DD') AS issue_date,
                   coalesce(s.supplier_name_en, i.seller_name) AS supplier,
                   i.seller_trn,
                   coalesce(i.fta_irn, '') AS fta_irn,
                   coalesce(i.po_reference, '') AS po_reference,
                   i.tax_exclusive_amount::text AS net,
                   i.vat_total_amount::text AS vat,
                   i.payable_amount_aed::text AS total,
                   coalesce(i.latest_response_code::text, 'Not reviewed') AS verdict,
                   i.ap_posting_status::text AS ap_posting
            FROM invoices i
            LEFT JOIN suppliers s ON s.id = i.supplier_id
            WHERE i.tenant_id = ${tenantId}
              AND i.direction = 'INBOUND_PURCHASE_AP'
              AND (${from}::date IS NULL OR i.issue_date >= ${from}::date)
              AND (${to}::date IS NULL OR i.issue_date <= ${to}::date)
            ORDER BY i.issue_date DESC
            LIMIT ${ROW_LIMITS['ap-inbound-log']}
          `
        ).map(Object.values),
      };

    case 'supplier-scorecard': {
      const rows = await supplierScorecard(tx, tenantId);
      return {
        columns: [
          'Supplier',
          'TRN',
          'Received',
          'Queried',
          'Rejected',
          'Rejection rate %',
          'Top reason',
        ],
        rows: rows.map((r) => [
          r.supplierName,
          r.trn ?? '',
          String(r.received),
          String(r.queried),
          String(r.rejected),
          r.rejectionRatePct.toFixed(1),
          r.topReason ?? '',
        ]),
      };
    }

    case 'input-tax-reconciliation':
      return {
        columns: [
          'Period',
          'Supplier',
          'Invoice number',
          'FTA IRN',
          'Taxable (AED)',
          'Input VAT (AED)',
          'Status',
          'Claimable',
        ],
        rows: (
          await tx<Record<string, string>[]>`
            SELECT to_char(i.issue_date, 'YYYY-MM') AS period,
                   coalesce(s.supplier_name_en, i.seller_name) AS supplier,
                   i.invoice_number,
                   coalesce(i.fta_irn, '') AS fta_irn,
                   i.tax_exclusive_amount::text AS taxable,
                   i.vat_total_amount::text AS input_vat,
                   i.status::text AS status,
                   CASE WHEN i.latest_response_code = 'AP' THEN 'Yes' ELSE 'No' END AS claimable
            FROM invoices i
            LEFT JOIN suppliers s ON s.id = i.supplier_id
            WHERE i.tenant_id = ${tenantId}
              AND i.direction = 'INBOUND_PURCHASE_AP'
              AND i.vat_total_amount <> 0
              AND (${from}::date IS NULL OR i.issue_date >= ${from}::date)
              AND (${to}::date IS NULL OR i.issue_date <= ${to}::date)
            ORDER BY i.issue_date DESC
            LIMIT ${ROW_LIMITS['input-tax-reconciliation']}
          `
        ).map(Object.values),
      };

    case 'ar-dispute-aging': {
      // `tx.unsafe` here only because the bucket expression is a shared
      // constant rather than a value — every actual value is still bound.
      const rows = await tx.unsafe<Record<string, string>[]>(
        `SELECT i.invoice_number,
                i.buyer_name,
                coalesce(i.fta_irn, '') AS fta_irn,
                i.payable_amount_aed::text AS amount,
                coalesce(i.latest_response_reason_code::text, '') AS reason,
                to_char(i.dispute_opened_at, 'YYYY-MM-DD') AS opened,
                extract(day from now() - i.dispute_opened_at)::int::text AS days_open,
                ${AGING_CASE_SQL} AS bucket,
                CASE WHEN i.corrective_credit_note_id IS NULL THEN 'No' ELSE 'Yes' END
                  AS credited
         FROM invoices i
         WHERE i.tenant_id = $1
           AND i.direction = 'OUTBOUND_SALES_AR'
           AND i.is_commercial_dispute
           AND NOT i.dispute_resolved
         ORDER BY i.dispute_opened_at
         LIMIT ${ROW_LIMITS['ar-dispute-aging']}`,
        [tenantId],
      );
      return {
        columns: [
          'Invoice number',
          'Buyer',
          'FTA IRN',
          'Amount (AED)',
          'Reason',
          'Opened',
          'Days open',
          'Bucket',
          'Credit note issued',
        ],
        rows: rows.map(Object.values),
      };
    }

    case 'rejection-pareto': {
      const rows = await paretoByReason(tx, tenantId, from, to);
      return {
        columns: ['Reason code', 'Outbound (AR)', 'Inbound (AP)', 'Total', 'Cumulative %'],
        rows: rows.map((r) => [
          r.reasonCode,
          String(r.outbound),
          String(r.inbound),
          String(r.total),
          r.cumulativePct.toFixed(1),
        ]),
      };
    }

    case 'fta-non-compliance': {
      const rows = await nonComplianceLog(tx, tenantId);
      return {
        columns: [
          'Invoice number',
          'Counterparty',
          'Reason',
          'Opened',
          'Days open',
          'Amount (AED)',
        ],
        rows: rows.map((r) => [
          r.invoiceNumber,
          r.counterpartyName,
          r.reasonCode ?? '',
          r.disputeOpenedAt?.slice(0, 10) ?? '',
          String(r.daysOpen),
          r.amountAed,
        ]),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// §13.1 the KPI dashboard
// ---------------------------------------------------------------------------

export async function buildAnalytics(
  tenantId: string,
  dateFrom: string | null,
  dateTo: string | null,
): Promise<DisputeAnalytics> {
  const from = dateFrom;
  const to = dateTo;

  const analytics = await withTenant(tenantId, async (tx) => {
    const totals = await tx<
      {
        outbound_total: string;
        outbound_disputed: string;
        inbound_total: string;
        inbound_rejected: string;
        input_vat_claimable: string;
        input_vat_blocked: string;
        open_disputes: string;
        unresolved_over_30: string;
        avg_resolution_days: string | null;
      }[]
    >`
      SELECT
        count(*) FILTER (WHERE direction = 'OUTBOUND_SALES_AR')::text
          AS outbound_total,
        count(*) FILTER (
          WHERE direction = 'OUTBOUND_SALES_AR' AND is_commercial_dispute
        )::text AS outbound_disputed,
        count(*) FILTER (WHERE direction = 'INBOUND_PURCHASE_AP')::text
          AS inbound_total,
        count(*) FILTER (
          WHERE direction = 'INBOUND_PURCHASE_AP' AND latest_response_code IN ('RE', 'UQ')
        )::text AS inbound_rejected,
        -- §13.1: input VAT is claimable once the AP desk has accepted the
        -- bill, and blocked while it is queried or rejected. A bill nobody
        -- has looked at yet is in neither bucket — it is not blocked, it is
        -- simply not yet claimed.
        coalesce(sum(vat_total_amount) FILTER (
          WHERE direction = 'INBOUND_PURCHASE_AP' AND latest_response_code = 'AP'
        ), 0)::text AS input_vat_claimable,
        coalesce(sum(vat_total_amount) FILTER (
          WHERE direction = 'INBOUND_PURCHASE_AP' AND latest_response_code IN ('RE', 'UQ')
        ), 0)::text AS input_vat_blocked,
        count(*) FILTER (WHERE is_commercial_dispute AND NOT dispute_resolved)::text
          AS open_disputes,
        count(*) FILTER (
          WHERE is_commercial_dispute AND NOT dispute_resolved
            AND dispute_opened_at < now() - interval '30 days'
        )::text AS unresolved_over_30,
        -- Mean time to resolution across everything that HAS resolved.
        -- Including the open ones would make the figure fall every time a
        -- new dispute is raised, which is the opposite of what it means.
        round(avg(
          extract(epoch from (dispute_resolved_at - dispute_opened_at)) / 86400
        ) FILTER (
          WHERE dispute_resolved AND dispute_opened_at IS NOT NULL
            AND dispute_resolved_at IS NOT NULL
        ), 1)::text AS avg_resolution_days
      FROM invoices
      WHERE tenant_id = ${tenantId}
        AND status <> 'DRAFT'
        AND (${from}::date IS NULL OR issue_date >= ${from}::date)
        AND (${to}::date IS NULL OR issue_date <= ${to}::date)
    `;

    const aging = await agingBuckets(tx, tenantId);
    const pareto = await paretoByReason(tx, tenantId, from, to);
    const scorecard = await supplierScorecard(tx, tenantId);
    const nonCompliance = await nonComplianceLog(tx, tenantId);

    return { totals: totals[0]!, aging, pareto, scorecard, nonCompliance };
  });

  const t = analytics.totals;
  const outboundTotal = Number(t.outbound_total);
  const inboundTotal = Number(t.inbound_total);

  return {
    kpis: {
      outboundTotal,
      outboundDisputed: Number(t.outbound_disputed),
      salesDisputeRatePct: rate(Number(t.outbound_disputed), outboundTotal),
      inboundTotal,
      inboundRejected: Number(t.inbound_rejected),
      purchaseDisputeRatePct: rate(Number(t.inbound_rejected), inboundTotal),
      inputVatClaimableAed: t.input_vat_claimable,
      inputVatBlockedAed: t.input_vat_blocked,
      averageResolutionDays:
        t.avg_resolution_days === null ? null : Number(t.avg_resolution_days),
      openDisputes: Number(t.open_disputes),
      unresolvedOver30Days: Number(t.unresolved_over_30),
    },
    aging: analytics.aging,
    pareto: analytics.pareto,
    supplierScorecard: analytics.scorecard,
    nonCompliance: analytics.nonCompliance,
  };
}

// ---------------------------------------------------------------------------
// Shared aggregates
// ---------------------------------------------------------------------------

/**
 * §13.2 report 4's buckets, written once.
 *
 * Inlined into the SQL rather than computed in Node because the aging report
 * groups by it and the detail report displays it; two definitions of "31–60
 * days" would eventually disagree by one day and nobody would notice which.
 */
const AGING_CASE_SQL = `
  CASE
    WHEN i.dispute_opened_at IS NULL THEN 'Unknown'
    WHEN i.dispute_opened_at > now() - interval '15 days'  THEN '0-15 days'
    WHEN i.dispute_opened_at > now() - interval '30 days'  THEN '16-30 days'
    WHEN i.dispute_opened_at > now() - interval '60 days'  THEN '31-60 days'
    ELSE '60+ days'
  END
`;

const AGING_ORDER = ['0-15 days', '16-30 days', '31-60 days', '60+ days', 'Unknown'];

async function agingBuckets(tx: Tx, tenantId: string): Promise<DisputeAnalytics['aging']> {
  const rows = await tx.unsafe<{ bucket: string; count: string; amount: string }[]>(
    `SELECT ${AGING_CASE_SQL} AS bucket,
            count(*)::text AS count,
            coalesce(sum(i.payable_amount_aed), 0)::text AS amount
     FROM invoices i
     WHERE i.tenant_id = $1
       AND i.direction = 'OUTBOUND_SALES_AR'
       AND i.is_commercial_dispute
       AND NOT i.dispute_resolved
     GROUP BY 1`,
    [tenantId],
  );

  const found = new Map(rows.map((r) => [r.bucket, r]));
  // Every bucket appears even when empty: a gap in the chart reads as missing
  // data, whereas a zero reads as good news.
  return AGING_ORDER.filter((b) => b !== 'Unknown' || found.has(b)).map((bucket) => ({
    bucket,
    count: Number(found.get(bucket)?.count ?? 0),
    amountAed: found.get(bucket)?.amount ?? '0.00',
  }));
}

async function paretoByReason(
  tx: Tx,
  tenantId: string,
  from: string | null,
  to: string | null,
): Promise<DisputeAnalytics['pareto']> {
  const rows = await tx<{ reason: RejectionReasonCode; outbound: string; inbound: string }[]>`
    SELECT r.status_reason_code AS reason,
           count(*) FILTER (WHERE i.direction = 'OUTBOUND_SALES_AR')::text AS outbound,
           count(*) FILTER (WHERE i.direction = 'INBOUND_PURCHASE_AP')::text AS inbound
    FROM invoice_responses r
    JOIN invoices i ON i.id = r.invoice_id
    WHERE r.tenant_id = ${tenantId}
      AND r.status_reason_code IS NOT NULL
      AND r.response_code IN ('RE', 'UQ')
      AND (${from}::date IS NULL OR i.issue_date >= ${from}::date)
      AND (${to}::date IS NULL OR i.issue_date <= ${to}::date)
    GROUP BY r.status_reason_code
  `;

  const counts = new Map(
    rows.map((r) => [r.reason, { outbound: Number(r.outbound), inbound: Number(r.inbound) }]),
  );

  const ranked = ALL_REASON_CODES.map((reasonCode) => {
    const entry = counts.get(reasonCode) ?? { outbound: 0, inbound: 0 };
    return { reasonCode, ...entry, total: entry.outbound + entry.inbound };
  })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);

  // A Pareto chart is only a Pareto chart once the running percentage is on it;
  // without it the reader has to add the bars up themselves to find the 80% line.
  const grandTotal = ranked.reduce((sum, r) => sum + r.total, 0);
  let running = 0;
  return ranked.map((r) => {
    running += r.total;
    return {
      ...r,
      cumulativePct: grandTotal === 0 ? 0 : Math.round((running / grandTotal) * 1000) / 10,
    };
  });
}

async function supplierScorecard(
  tx: Tx,
  tenantId: string,
): Promise<DisputeAnalytics['supplierScorecard']> {
  const rows = await tx<
    {
      supplier_id: string | null;
      supplier_name: string;
      trn: string | null;
      received: string;
      rejected: string;
      queried: string;
      top_reason: RejectionReasonCode | null;
    }[]
  >`
    SELECT i.supplier_id,
           coalesce(s.supplier_name_en, i.seller_name) AS supplier_name,
           coalesce(s.trn, nullif(i.seller_trn, '')) AS trn,
           count(*)::text AS received,
           count(*) FILTER (WHERE i.latest_response_code = 'RE')::text AS rejected,
           count(*) FILTER (WHERE i.latest_response_code = 'UQ')::text AS queried,
           (
             SELECT r.status_reason_code
             FROM invoice_responses r
             JOIN invoices ri ON ri.id = r.invoice_id
             WHERE ri.supplier_id IS NOT DISTINCT FROM i.supplier_id
               AND r.tenant_id = ${tenantId}
               AND r.status_reason_code IS NOT NULL
             GROUP BY r.status_reason_code
             ORDER BY count(*) DESC
             LIMIT 1
           ) AS top_reason
    FROM invoices i
    LEFT JOIN suppliers s ON s.id = i.supplier_id
    WHERE i.tenant_id = ${tenantId}
      AND i.direction = 'INBOUND_PURCHASE_AP'
    GROUP BY i.supplier_id, s.supplier_name_en, i.seller_name, s.trn, i.seller_trn
    -- Worst offenders first: the report exists to start a supplier conversation.
    ORDER BY count(*) FILTER (WHERE i.latest_response_code IN ('RE', 'UQ')) DESC,
             count(*) DESC
    LIMIT ${ROW_LIMITS['supplier-scorecard']}
  `;

  return rows.map((r) => {
    const received = Number(r.received);
    const rejected = Number(r.rejected);
    return {
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      trn: r.trn,
      received,
      rejected,
      queried: Number(r.queried),
      rejectionRatePct: rate(rejected, received),
      topReason: r.top_reason,
    };
  });
}

/**
 * §13.2 report 6 — the audit exposure.
 *
 * A sales invoice a buyer rejected more than 30 days ago with no corrective
 * credit note is an unreversed output tax liability sitting on a return. This
 * is the one report whose rows a tax auditor would ask about directly.
 */
async function nonComplianceLog(
  tx: Tx,
  tenantId: string,
): Promise<DisputeAnalytics['nonCompliance']> {
  const rows = await tx<
    {
      id: string;
      invoice_number: string;
      counterparty: string;
      dispute_opened_at: Date | null;
      days_open: string;
      reason: RejectionReasonCode | null;
      amount: string;
    }[]
  >`
    SELECT i.id, i.invoice_number,
           CASE WHEN i.direction = 'OUTBOUND_SALES_AR'
                THEN i.buyer_name ELSE i.seller_name END AS counterparty,
           i.dispute_opened_at,
           extract(day from now() - i.dispute_opened_at)::int::text AS days_open,
           i.latest_response_reason_code AS reason,
           i.payable_amount_aed::text AS amount
    FROM invoices i
    WHERE i.tenant_id = ${tenantId}
      AND i.is_commercial_dispute
      AND NOT i.dispute_resolved
      AND i.corrective_credit_note_id IS NULL
      AND i.dispute_opened_at < now() - interval '30 days'
    ORDER BY i.dispute_opened_at
    LIMIT ${ROW_LIMITS['fta-non-compliance']}
  `;

  return rows.map((r) => ({
    invoiceId: r.id,
    invoiceNumber: r.invoice_number,
    counterpartyName: r.counterparty,
    disputeOpenedAt: r.dispute_opened_at?.toISOString() ?? null,
    daysOpen: Number(r.days_open),
    reasonCode: r.reason,
    amountAed: r.amount,
  }));
}

function rate(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}
