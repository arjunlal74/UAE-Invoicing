import { REASON_CODE_LABELS, type DisputeAnalytics, type ReportKey } from '@uae/contracts';
import { formatAmount } from '@uae/domain';
import {
  FONT,
  INK,
  autoColumnWidths,
  drawTable,
  ensureSpace,
  formatDay,
  numericColumns,
  sectionHeading,
  startPdf,
} from './document.js';

/**
 * The §13.2 report library and the §13.1 KPI pack, on paper.
 *
 * Reports print landscape because every one of them is a wide table — the AP
 * inbound log is eleven columns and the alternative to landscape is a font
 * nobody can read. Column widths are measured from the data rather than fixed
 * per report, so a report whose SELECT list grows does not need a matching edit
 * here to stay legible.
 *
 * The period the report covers is stated on every page. A reconciliation run
 * with no dates on it is worthless the moment it leaves the screen it was run
 * on, and these are documents that get handed to an auditor.
 */

export interface ReportPdfInput {
  key: ReportKey;
  name: string;
  module: 'AR' | 'AP' | 'BOTH';
  description: string;
  columns: string[];
  rows: string[][];
  dateFrom: string | null;
  dateTo: string | null;
  tenantName: string;
  platformName: string;
  /** Truthful when the underlying query hit its row cap. */
  truncated: boolean;
}

export interface TenantDirectoryGroup {
  /** The tier, as a person names it. */
  title: string;
  columns: string[];
  rows: string[][];
}

export interface TenantDirectoryPdfInput {
  groups: TenantDirectoryGroup[];
  /** What the reader filtered to, so the paper says which list this is. */
  filterLabel: string;
  platformName: string;
  generatedFor: string;
}

/**
 * The tenant directory, one table per tier (SRS v2.1 §2).
 *
 * Grouped rather than sorted, because the tiers are not degrees of the same
 * thing: a channel partner resells capacity and never files, a managed
 * sub-tenant files against a slice it did not buy, and a direct tenant does
 * both. Their columns mean different things, and one flat table invites the
 * reader to compare a row against the row above it when that comparison is
 * meaningless.
 *
 * An empty tier is still printed, with a line saying so. "No channel partners"
 * is an answer; a missing section leaves the reader wondering whether the
 * report covers partners at all.
 */
export async function renderTenantDirectoryPdf(input: TenantDirectoryPdfInput): Promise<Buffer> {
  const pdf = startPdf({
    title: 'Tenant directory',
    subject: input.filterLabel,
    landscape: true,
    footerNote: `Tenant directory · ${input.platformName} · ${input.filterLabel}`,
  });

  const { doc } = pdf;
  const left = doc.page.margins.left;
  const width = pdf.width;

  drawMasthead(doc, left, width, {
    title: 'Tenant directory',
    subtitle: input.filterLabel,
    rightLines: [input.platformName, input.generatedFor],
  });

  doc.y += 14;

  for (const group of input.groups) {
    ensureSpace(doc, SECTION_KEEP_TOGETHER);
    sectionHeading(doc, `${group.title} (${group.rows.length})`);

    if (group.rows.length === 0) {
      doc.font(FONT.regular).fontSize(8.5).fillColor(INK.muted);
      doc.text('None on this list.', left, doc.y + 2, { width });
      doc.y += 18;
      continue;
    }

    const fontSize = 8;
    const headerFontSize = 6.5;
    // Measured per group rather than once for the whole document: the tiers
    // hold different things, and a width set by the widest partner name would
    // leave the sub-tenant table with a column of air beside it.
    const widths = autoColumnWidths(
      doc,
      group.columns,
      group.rows,
      width,
      fontSize,
      headerFontSize,
    );
    const numeric = numericColumns(group.rows, group.columns.length);

    drawTable(doc, {
      columns: group.columns.map((header, index) => ({
        header,
        width: widths[index]!,
        align: numeric[index] ? ('right' as const) : ('left' as const),
      })),
      rows: group.rows,
      fontSize,
      headerFontSize,
      onPageBreak: () => {
        doc.font(FONT.regular).fontSize(7).fillColor(INK.faint);
        doc.text(`${group.title} — continued`, left, doc.y, { width, lineBreak: false });
        doc.y += 10;
      },
    });

    doc.y += 14;
  }

  return pdf.done();
}

/** A heading plus a header row and two data rows — enough to be worth the paper. */
const SECTION_KEEP_TOGETHER = 74;

const MODULE_TONES: Record<string, { fill: string; text: string }> = {
  AR: { fill: '#dbeafe', text: INK.accent },
  AP: { fill: '#d1fae5', text: INK.ok },
  BOTH: { fill: '#e2e8f0', text: INK.muted },
};

/** "1 Jan 2025 – 31 Mar 2025", or an honest description of an open end. */
function periodLabel(from: string | null, to: string | null): string {
  if (from && to) return `${formatDay(from)} – ${formatDay(to)}`;
  if (from) return `From ${formatDay(from)}`;
  if (to) return `Up to ${formatDay(to)}`;
  return 'All dates';
}

export async function renderReportPdf(input: ReportPdfInput): Promise<Buffer> {
  const period = periodLabel(input.dateFrom, input.dateTo);

  const pdf = startPdf({
    title: input.name,
    subject: input.description,
    landscape: true,
    footerNote: `${input.name} · ${input.tenantName} · ${period}`,
  });

  const { doc } = pdf;
  const left = doc.page.margins.left;
  const width = pdf.width;

  drawMasthead(doc, left, width, {
    title: input.name,
    subtitle: input.description,
    chipLabel: input.module === 'BOTH' ? null : input.module,
    chipTone: MODULE_TONES[input.module] ?? MODULE_TONES.BOTH!,
    rightLines: [input.tenantName, period],
  });

  doc.y += 14;

  if (input.rows.length === 0) {
    doc.font(FONT.italic).fontSize(10).fillColor(INK.muted);
    doc.text('No rows matched this report for the selected period.', left, doc.y, { width });
    return pdf.done();
  }

  const fontSize = 8;
  const headerFontSize = 6.5;
  const widths = autoColumnWidths(
    doc,
    input.columns,
    input.rows,
    width,
    fontSize,
    headerFontSize,
  );
  const numeric = numericColumns(input.rows, input.columns.length);

  drawTable(doc, {
    columns: input.columns.map((header, index) => ({
      header,
      width: widths[index]!,
      align: numeric[index] ? ('right' as const) : ('left' as const),
    })),
    rows: input.rows,
    fontSize,
    headerFontSize,
    onPageBreak: () => {
      doc.font(FONT.regular).fontSize(7).fillColor(INK.faint);
      doc.text(`${input.name} — continued · ${period}`, left, doc.y, { width, lineBreak: false });
      doc.y += 10;
    },
  });

  doc.y += 8;
  doc.font(FONT.regular).fontSize(7.5).fillColor(INK.muted);
  doc.text(
    `${input.rows.length.toLocaleString('en-GB')} row${input.rows.length === 1 ? '' : 's'}` +
      (input.truncated
        ? ' — capped at the query limit; narrow the date range to see the rest.'
        : ''),
    left,
    doc.y,
    { width },
  );

  return pdf.done();
}

// ---------------------------------------------------------------------------
// §13.1 KPI pack
// ---------------------------------------------------------------------------

export interface AnalyticsPdfInput {
  analytics: DisputeAnalytics;
  dateFrom: string | null;
  dateTo: string | null;
  tenantName: string;
  platformName: string;
}

export async function renderAnalyticsPdf(input: AnalyticsPdfInput): Promise<Buffer> {
  const { analytics } = input;
  const { kpis } = analytics;
  const period = periodLabel(input.dateFrom, input.dateTo);

  const pdf = startPdf({
    title: 'Dispute analytics',
    subject: 'Outbound sales disputes and inbound purchase rejections',
    footerNote: `Dispute analytics · ${input.tenantName} · ${period}`,
  });

  const { doc } = pdf;
  const left = doc.page.margins.left;
  const width = pdf.width;

  drawMasthead(doc, left, width, {
    title: 'Dispute analytics',
    subtitle: 'Outbound sales disputes and inbound purchase rejections across both modules.',
    chipLabel: null,
    chipTone: MODULE_TONES.BOTH!,
    rightLines: [input.tenantName, period],
  });

  doc.y += 16;

  // The exposure warning goes above the numbers, because it is the one line on
  // the page that describes money currently at risk rather than history.
  if (kpis.unresolvedOver30Days > 0) {
    const height = 30;
    doc.rect(left, doc.y, width, height).fill('#fef2f2');
    doc.rect(left, doc.y, 2.5, height).fill(INK.danger);
    doc.font(FONT.bold).fontSize(8.5).fillColor(INK.danger);
    doc.text('FTA audit exposure', left + 12, doc.y + 7, { width: width - 24 });
    doc.font(FONT.regular).fontSize(8).fillColor(INK.body);
    doc.text(
      `${kpis.unresolvedOver30Days} disputed document${kpis.unresolvedOver30Days === 1 ? ' has' : 's have'} been open for more than 30 days with no corrective credit note. Until one is issued the output tax stands unreversed on the return.`,
      left + 12,
      doc.y,
      { width: width - 24 },
    );
    doc.y += 12;
  }

  drawTiles(doc, left, width, [
    {
      label: 'Sales dispute rate',
      value: `${kpis.salesDisputeRatePct}%`,
      hint: `${kpis.outboundDisputed.toLocaleString('en-GB')} of ${kpis.outboundTotal.toLocaleString('en-GB')} outbound`,
      tone: kpis.salesDisputeRatePct > 5 ? INK.danger : INK.heading,
    },
    {
      label: 'Purchase dispute rate',
      value: `${kpis.purchaseDisputeRatePct}%`,
      hint: `${kpis.inboundRejected.toLocaleString('en-GB')} of ${kpis.inboundTotal.toLocaleString('en-GB')} inbound`,
      tone: kpis.purchaseDisputeRatePct > 5 ? INK.warn : INK.heading,
    },
    {
      label: 'Input VAT claimable',
      value: `AED ${formatAmount(kpis.inputVatClaimableAed)}`,
      hint: 'On accepted purchase invoices',
      tone: INK.ok,
    },
    {
      label: 'Input VAT blocked',
      value: `AED ${formatAmount(kpis.inputVatBlockedAed)}`,
      hint: 'Held behind a query or rejection',
      tone: Number(kpis.inputVatBlockedAed) > 0 ? INK.danger : INK.heading,
    },
  ]);

  drawTiles(doc, left, width, [
    {
      label: 'Open disputes',
      value: kpis.openDisputes.toLocaleString('en-GB'),
      hint: 'Awaiting resolution',
      tone: kpis.openDisputes > 0 ? INK.warn : INK.ok,
    },
    {
      label: 'Average resolution',
      value: kpis.averageResolutionDays === null ? '—' : `${kpis.averageResolutionDays} days`,
      hint: 'Dispute logged to credit note received',
      tone: INK.heading,
    },
    {
      label: 'Open beyond 30 days',
      value: kpis.unresolvedOver30Days.toLocaleString('en-GB'),
      hint: 'Unreversed output tax',
      tone: kpis.unresolvedOver30Days > 0 ? INK.danger : INK.ok,
    },
  ]);

  const continued = (heading: string) => () => {
    doc.font(FONT.regular).fontSize(7).fillColor(INK.faint);
    doc.text(`${heading} — continued`, left, doc.y, { width, lineBreak: false });
    doc.y += 10;
  };

  // --- Aging ---------------------------------------------------------------
  ensureSpace(doc, SECTION_KEEP_TOGETHER);
  sectionHeading(doc, 'Outbound dispute aging');
  drawSection(doc, left, width, {
    empty: analytics.aging.every((bucket) => bucket.count === 0),
    emptyText: 'No open sales disputes.',
    columns: [
      { header: 'Bucket', width: width * 0.4 },
      { header: 'Invoices', width: width * 0.25, align: 'right' },
      { header: 'Value (AED)', width: width * 0.35, align: 'right' },
    ],
    rows: analytics.aging.map((bucket) => [
      bucket.bucket,
      String(bucket.count),
      formatAmount(bucket.amountAed),
    ]),
    onPageBreak: continued('Outbound dispute aging'),
  });

  // --- Pareto --------------------------------------------------------------
  ensureSpace(doc, SECTION_KEEP_TOGETHER);
  sectionHeading(doc, 'Rejection Pareto by reason code');
  drawSection(doc, left, width, {
    empty: analytics.pareto.length === 0,
    emptyText: 'No rejections recorded.',
    columns: [
      { header: 'Reason', width: width * 0.4 },
      { header: 'Outbound (AR)', width: width * 0.15, align: 'right' },
      { header: 'Inbound (AP)', width: width * 0.15, align: 'right' },
      { header: 'Total', width: width * 0.13, align: 'right' },
      { header: 'Cumulative', width: width * 0.17, align: 'right' },
    ],
    rows: analytics.pareto.map((row) => [
      `${row.reasonCode} — ${REASON_CODE_LABELS[row.reasonCode]}`,
      String(row.outbound),
      String(row.inbound),
      String(row.total),
      `${row.cumulativePct}%`,
    ]),
    onPageBreak: continued('Rejection Pareto by reason code'),
  });

  // --- Supplier scorecard --------------------------------------------------
  ensureSpace(doc, SECTION_KEEP_TOGETHER);
  sectionHeading(doc, 'Supplier dispute scorecard');
  drawSection(doc, left, width, {
    empty: analytics.supplierScorecard.length === 0,
    emptyText: 'No purchase invoices received yet.',
    columns: [
      { header: 'Supplier', width: width * 0.26 },
      { header: 'TRN', width: width * 0.17 },
      { header: 'Received', width: width * 0.09, align: 'right' },
      { header: 'Queried', width: width * 0.09, align: 'right' },
      { header: 'Rejected', width: width * 0.09, align: 'right' },
      { header: 'Rate', width: width * 0.08, align: 'right' },
      { header: 'Top reason', width: width * 0.22 },
    ],
    rows: analytics.supplierScorecard.map((row) => [
      row.supplierName,
      row.trn ?? '—',
      String(row.received),
      String(row.queried),
      String(row.rejected),
      `${row.rejectionRatePct}%`,
      row.topReason ? `${row.topReason} — ${REASON_CODE_LABELS[row.topReason]}` : '—',
    ]),
    onPageBreak: continued('Supplier dispute scorecard'),
  });

  // --- Non-compliance ------------------------------------------------------
  ensureSpace(doc, SECTION_KEEP_TOGETHER);
  sectionHeading(doc, 'FTA audit non-compliance log');
  drawSection(doc, left, width, {
    empty: analytics.nonCompliance.length === 0,
    emptyText:
      'Nothing outstanding. Every disputed document either has a corrective credit note or was raised within the last 30 days.',
    columns: [
      { header: 'Document', width: width * 0.18 },
      { header: 'Counterparty', width: width * 0.26 },
      { header: 'Reason', width: width * 0.26 },
      { header: 'Days open', width: width * 0.13, align: 'right' },
      { header: 'Amount (AED)', width: width * 0.17, align: 'right' },
    ],
    rows: analytics.nonCompliance.map((row) => [
      row.invoiceNumber,
      row.counterpartyName,
      row.reasonCode ? `${row.reasonCode} — ${REASON_CODE_LABELS[row.reasonCode]}` : '—',
      String(row.daysOpen),
      formatAmount(row.amountAed),
    ]),
    onPageBreak: continued('FTA audit non-compliance log'),
  });

  return pdf.done();
}

// ---------------------------------------------------------------------------
// Shared blocks
// ---------------------------------------------------------------------------

function drawMasthead(
  doc: PDFKit.PDFDocument,
  left: number,
  width: number,
  options: {
    title: string;
    subtitle: string;
    /** Omitted where it would only restate the title. */
    chipLabel?: string | null;
    chipTone?: { fill: string; text: string };
    rightLines: string[];
  },
): void {
  const height = 56;
  const top = doc.y;
  doc.rect(left, top, width, height).fill(INK.band);

  doc.font(FONT.bold).fontSize(14).fillColor(INK.paper);
  doc.text(options.title, left + 14, top + 11, { width: width * 0.6, lineBreak: false });

  doc.font(FONT.regular).fontSize(7.5).fillColor('#c7d7ea');
  doc.text(options.subtitle, left + 14, top + 30, { width: width * 0.6, height: 18 });

  let y = top + 12;
  for (const line of options.rightLines) {
    doc.font(y === top + 12 ? FONT.bold : FONT.regular).fontSize(y === top + 12 ? 9 : 8);
    doc.fillColor(y === top + 12 ? INK.paper : '#c7d7ea');
    doc.text(line, left, y, { width: width - 14, align: 'right', lineBreak: false });
    y += 13;
  }

  // A chip that says "BOTH" narrows nothing: the reader already knows which
  // report they asked for, and a badge that is always true on a document is
  // furniture. Drawn only where it actually tells them something.
  if (options.chipLabel && options.chipTone) {
    doc.font(FONT.bold).fontSize(6.5);
    const label = options.chipLabel.toUpperCase();
    const chipWidth = doc.widthOfString(label) + 12;
    doc.roundedRect(left + width - 14 - chipWidth, top + height - 20, chipWidth, 12, 3).fill(
      options.chipTone.fill,
    );
    doc.fillColor(options.chipTone.text);
    doc.text(label, left + width - 14 - chipWidth + 6, top + height - 16.5, { lineBreak: false });
  }

  doc.y = top + height;
  doc.fillColor(INK.body);
}

interface Tile {
  label: string;
  value: string;
  hint: string;
  tone: string;
}

/** The largest size in [min, max] at which `text` fits `width` on one line. */
function fittedSize(
  doc: PDFKit.PDFDocument,
  text: string,
  width: number,
  max: number,
  min: number,
): number {
  for (let size = max; size > min; size -= 0.5) {
    doc.fontSize(size);
    if (doc.widthOfString(text) <= width) return size;
  }
  return min;
}

function drawTiles(doc: PDFKit.PDFDocument, left: number, width: number, tiles: Tile[]): void {
  const gap = 10;
  const tileWidth = (width - gap * (tiles.length - 1)) / tiles.length;
  const height = 52;
  const top = doc.y + 8;

  tiles.forEach((tile, index) => {
    const x = left + index * (tileWidth + gap);
    doc.rect(x, top, tileWidth, height).fill(INK.zebra);
    doc.rect(x, top, tileWidth, height).lineWidth(0.5).strokeColor(INK.rule).stroke();

    doc.font(FONT.regular).fontSize(6.5).fillColor(INK.muted);
    doc.text(tile.label.toUpperCase(), x + 9, top + 8, {
      width: tileWidth - 18,
      characterSpacing: 0.4,
      lineBreak: false,
    });

    // The figure sets its own size. A fixed 14pt turns "AED 1,284,902.55" into
    // the word "AED" plus an ellipsis, which is the one thing on a KPI tile that
    // must never be the part that gets dropped.
    doc.font(FONT.bold).fillColor(tile.tone);
    doc.fontSize(fittedSize(doc, tile.value, tileWidth - 18, 14, 8));
    doc.text(tile.value, x + 9, top + 20, { width: tileWidth - 18, lineBreak: false });

    doc.font(FONT.regular).fontSize(6.5).fillColor(INK.faint);
    doc.text(tile.hint, x + 9, top + 38, { width: tileWidth - 18, height: 9, ellipsis: true });
  });

  doc.y = top + height;
  doc.fillColor(INK.body);
}

function drawSection(
  doc: PDFKit.PDFDocument,
  left: number,
  width: number,
  options: {
    empty: boolean;
    emptyText: string;
    columns: { header: string; width: number; align?: 'left' | 'right' }[];
    rows: string[][];
    onPageBreak: () => void;
  },
): void {
  if (options.empty) {
    doc.font(FONT.italic).fontSize(8).fillColor(INK.muted);
    doc.text(options.emptyText, left, doc.y, { width });
    doc.fillColor(INK.body);
    return;
  }

  drawTable(doc, {
    columns: options.columns,
    rows: options.rows,
    fontSize: 8,
    headerFontSize: 6.5,
    onPageBreak: options.onPageBreak,
  });
}
