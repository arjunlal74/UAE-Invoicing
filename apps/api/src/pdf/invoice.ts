import {
  REASON_CODE_LABELS,
  RESPONSE_CODE_LABELS,
  REVERSAL_MODE_LABELS,
  type InvoiceDirection,
  type InvoiceStatus,
  type InvoiceTypeDb,
  type RejectionReasonCode,
  type ResponseStatusCode,
  type ReversalMode,
} from '@uae/contracts';
import { VAT_CATEGORIES, VAT_CATEGORY_CODES, formatAmount } from '@uae/domain';
import QRCode from 'qrcode';
import {
  FONT,
  INK,
  chip,
  drawTable,
  formatDay,
  labelledValue,
  sectionHeading,
  startPdf,
} from './document.js';

/**
 * The printed tax invoice, credit note and debit note.
 *
 * This is the only artefact in the system a person outside the merchant's
 * organisation is expected to read, so it is laid out as the statutory document
 * of Article 59 of the VAT Executive Regulation rather than as a rendering of
 * the portal's detail screen: the words "Tax Invoice", both parties' names,
 * addresses and TRNs, a sequential number, the date of issue, a description of
 * each supply with its unit price, quantity, tax rate and tax amount, the value
 * of any discount, and the totals in AED.
 *
 * The platform's own identifiers — the FTA IRN, the Peppol UUID, the archived
 * XML digest — sit below that, because they are what makes a specific piece of
 * paper traceable back to a specific cleared filing when somebody queries it two
 * years later.
 *
 * A document that has not been cleared gets a watermark. It is the single most
 * important thing on the page: a PDF of a draft is indistinguishable from a PDF
 * of a filed invoice at a glance, and one of them is a legal document.
 */

export interface PrintableParty {
  name: string;
  trn: string | null;
  addressLines: string[];
  contactEmail?: string | null;
  contactPhone?: string | null;
}

export interface PrintableLine {
  lineNumber: number;
  description: string;
  hsCode: string | null;
  quantity: string;
  uom: string;
  unitPrice: string;
  discount: string;
  vatCategory: string;
  vatRate: string;
  net: string;
  vat: string;
  total: string;
}

export interface PrintableDocument {
  invoiceNumber: string;
  invoiceType: InvoiceTypeDb;
  direction: InvoiceDirection;
  status: InvoiceStatus;
  issueDate: string;
  issueTime: string;
  currencyCode: string;
  exchangeRate: string;
  seller: PrintableParty;
  buyer: PrintableParty;
  ftaIrn: string | null;
  peppolUuid: string;
  poReference: string | null;
  grnReference: string | null;
  qrCodeData: string | null;
  ublXmlSha256: string | null;
  clearedAt: string | null;
  /** Present on a credit or debit note: the document being corrected. */
  reference: {
    invoiceNumber: string;
    ftaIrn: string | null;
    reversalMode: ReversalMode | null;
    reasonCode: RejectionReasonCode | null;
    notes: string | null;
  } | null;
  /** The counterparty's verdict, when there is an unresolved one. */
  dispute: {
    responseCode: ResponseStatusCode | null;
    reasonCode: RejectionReasonCode | null;
    comment: string | null;
    openedAt: string | null;
  } | null;
  lines: PrintableLine[];
  totals: {
    lineExtension: string;
    taxExclusive: string;
    vatTotal: string;
    taxInclusive: string;
    payable: string;
    payableAed: string;
  };
  platformName: string;
}

const TITLES: Record<InvoiceTypeDb, string> = {
  TAX_INVOICE: 'Tax Invoice',
  SIMPLIFIED_TAX_INVOICE: 'Simplified Tax Invoice',
  CREDIT_NOTE: 'Tax Credit Note',
  DEBIT_NOTE: 'Tax Debit Note',
};

/**
 * What to stamp across a document that is not a filed tax invoice.
 *
 * An inbound purchase invoice is never watermarked — it arrived already cleared
 * by the supplier's own filing, and stamping "not filed" on it would be a lie
 * about someone else's compliance.
 */
function watermarkFor(document: PrintableDocument): string | null {
  if (document.direction === 'INBOUND_PURCHASE_AP') return null;
  switch (document.status) {
    case 'DRAFT':
      return 'Draft';
    case 'REJECTED_BY_FTA':
      return 'Rejected by FTA';
    case 'VALIDATION_FAILED':
      return 'Validation failed';
    case 'INGESTED':
    case 'VALIDATED':
    case 'PENDING_CFO_APPROVAL':
    case 'SUBMITTED_TO_ASP':
      return 'Not yet filed';
    default:
      return null;
  }
}

/**
 * `invoice_line_items.vat_category` holds the database spelling — `STANDARD`,
 * `ZERO_RATED` — while a tax invoice carries the UBL category code. Both are
 * printed: the letter is what a UBL-literate reader matches against the XML,
 * and the words are what everybody else reads. Derived from the domain table so
 * that adding a category in one place adds it here too.
 */
const CATEGORY_BY_DB_VALUE = new Map(
  VAT_CATEGORY_CODES.map((code) => [
    VAT_CATEGORIES[code].dbValue as string,
    // The domain label carries the rate in parentheses ("Standard Rate (5%)");
    // it is stripped here because the rate is the very next column.
    `${code} — ${VAT_CATEGORIES[code].label.replace(/\s*\(\d+%\)$/, '')}`,
  ]),
);

function categoryLabel(dbValue: string): string {
  return CATEGORY_BY_DB_VALUE.get(dbValue) ?? dbValue;
}

const STATUS_TONES: Partial<Record<InvoiceStatus, { fill: string; text: string }>> = {
  ACCEPTED_BY_FTA: { fill: '#d1fae5', text: INK.ok },
  ACCEPTED_BY_BUYER: { fill: '#d1fae5', text: INK.ok },
  DELIVERED_TO_BUYER: { fill: '#dbeafe', text: INK.accent },
  ACKNOWLEDGED: { fill: '#dbeafe', text: INK.accent },
  UNDER_QUERY: { fill: '#fef3c7', text: INK.warn },
  REJECTED_BY_FTA: { fill: '#fee2e2', text: INK.danger },
  REJECTED_COMMERCIAL: { fill: '#fee2e2', text: INK.danger },
  REJECTED_TECHNICAL: { fill: '#fee2e2', text: INK.danger },
};

export async function renderInvoicePdf(document: PrintableDocument): Promise<Buffer> {
  const title = TITLES[document.invoiceType];
  const money = (value: string) => formatAmount(value);

  const pdf = startPdf({
    watermark: watermarkFor(document) ?? undefined,
    title: `${title} ${document.invoiceNumber}`,
    subject: `${title} issued by ${document.seller.name}`,
    footerNote: `${title} ${document.invoiceNumber} · ${document.seller.name}`,
    footerLegal:
      document.direction === 'INBOUND_PURCHASE_AP'
        ? 'Rendered from the electronic invoice received from the supplier. The transmitted UBL XML is the authoritative record.'
        : 'Electronically generated and archived under the UAE Tax Procedures Law. The transmitted UBL XML is the authoritative record.',
  });

  const { doc } = pdf;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  // --- Masthead ------------------------------------------------------------
  const bandHeight = 62;
  doc.rect(left, doc.y, width, bandHeight).fill(INK.band);

  const bandTop = doc.y;
  doc.font(FONT.bold).fontSize(13).fillColor(INK.paper);
  // Height-capped with an ellipsis: a legal name long enough to wrap to three
  // lines would otherwise run out of the band and onto the parties below it.
  doc.text(document.seller.name, left + 14, bandTop + 12, {
    width: width * 0.5,
    height: 17,
    ellipsis: true,
  });
  doc.font(FONT.regular).fontSize(8).fillColor('#c7d7ea');
  doc.text(`TRN ${document.seller.trn ?? '—'}`, left + 14, bandTop + 32, {
    width: width * 0.5,
    lineBreak: false,
  });

  doc.font(FONT.bold).fontSize(17).fillColor(INK.paper);
  doc.text(title.toUpperCase(), left, bandTop + 13, {
    width: width - 14,
    align: 'right',
    characterSpacing: 1,
    lineBreak: false,
  });
  doc.font(FONT.regular).fontSize(9.5).fillColor('#c7d7ea');
  doc.text(document.invoiceNumber, left, bandTop + 36, {
    width: width - 14,
    align: 'right',
    lineBreak: false,
  });

  doc.y = bandTop + bandHeight + 14;
  doc.fillColor(INK.body);

  // --- Parties and QR ------------------------------------------------------
  const qrImage = await renderQr(document.qrCodeData);
  const qrWidth = qrImage ? 92 : 0;
  const gutter = 14;
  const partyWidth = (width - qrWidth - gutter * (qrImage ? 2 : 1)) / 2;
  const partiesTop = doc.y;

  const sellerHeight = drawParty(doc, 'Supplier', document.seller, left, partiesTop, partyWidth);
  const buyerHeight = drawParty(
    doc,
    document.invoiceType === 'SIMPLIFIED_TAX_INVOICE' ? 'Customer' : 'Customer (bill to)',
    document.buyer,
    left + partyWidth + gutter,
    partiesTop,
    partyWidth,
  );

  if (qrImage) {
    const x = right - qrWidth;
    doc.image(qrImage, x, partiesTop, { width: qrWidth, height: qrWidth });
    doc.font(FONT.regular).fontSize(6).fillColor(INK.faint);
    doc.text('FTA verification code', x, partiesTop + qrWidth + 3, {
      width: qrWidth,
      align: 'center',
      lineBreak: false,
    });
  }

  doc.y = partiesTop + Math.max(sellerHeight, buyerHeight, qrImage ? qrWidth + 12 : 0);
  doc.fillColor(INK.body);

  // --- Document facts ------------------------------------------------------
  sectionHeading(doc, 'Document details', 12);

  const facts: { label: string; value: string; mono?: boolean }[] = [
    { label: 'Issue date', value: formatDay(document.issueDate) },
    { label: 'Issue time', value: `${document.issueTime.slice(0, 5)} GST` },
    { label: 'Currency', value: document.currencyCode },
  ];
  if (document.currencyCode !== 'AED') {
    facts.push({ label: 'Rate to AED', value: document.exchangeRate });
  }
  if (document.poReference) facts.push({ label: 'PO reference', value: document.poReference });
  if (document.grnReference) facts.push({ label: 'GRN reference', value: document.grnReference });
  if (document.ftaIrn) facts.push({ label: 'FTA IRN', value: document.ftaIrn, mono: true });
  facts.push({ label: 'Peppol UUID', value: document.peppolUuid, mono: true });
  if (document.clearedAt) {
    facts.push({ label: 'Cleared', value: formatDay(document.clearedAt) });
  }

  drawFactGrid(doc, facts, left, width);

  // The status is a fact about the filing, not about the supply, so it sits
  // apart from the grid rather than pretending to be another field of it.
  const tone = STATUS_TONES[document.status] ?? { fill: INK.panel, text: INK.muted };
  doc.y += 4;
  chip(doc, document.status.replace(/_/g, ' '), left, doc.y, tone);
  doc.y += 18;

  // --- What this document corrects ----------------------------------------
  if (document.reference) {
    const reference = document.reference;
    const bits: string[] = [];
    if (reference.ftaIrn) bits.push(`Original IRN ${reference.ftaIrn}`);
    if (reference.reversalMode) bits.push(REVERSAL_MODE_LABELS[reference.reversalMode]);
    if (reference.reasonCode) {
      bits.push(`${reference.reasonCode} — ${REASON_CODE_LABELS[reference.reasonCode]}`);
    }

    drawPanel(doc, left, width, INK.accentSoft, INK.accent, [
      {
        text: `This ${title.toLowerCase()} adjusts invoice ${reference.invoiceNumber}`,
        font: FONT.bold,
        size: 8.5,
        color: INK.accent,
      },
      ...(bits.length
        ? [{ text: bits.join('  ·  '), font: FONT.regular, size: 8, color: INK.body }]
        : []),
      ...(reference.notes
        ? [{ text: reference.notes, font: FONT.italic, size: 8, color: INK.muted }]
        : []),
    ]);
  }

  // --- Line items ----------------------------------------------------------
  sectionHeading(doc, `Line items (${document.lines.length})`, 12);

  // Money columns are sized to hold a grouped seven-figure amount on one line —
  // a line item over a million dirhams is ordinary on a construction invoice,
  // and a total that wraps mid-number is unreadable. The description takes
  // whatever is left and wraps, which is the one column that reads fine wrapped.
  const lineColumns = [
    { header: '#', width: 22 },
    { header: 'Description', width: 0 },
    { header: 'Qty', width: 44, align: 'right' as const },
    { header: 'UOM', width: 32 },
    { header: 'Unit price', width: 52, align: 'right' as const },
    { header: 'Discount', width: 52, align: 'right' as const },
    { header: 'VAT', width: 36, align: 'right' as const },
    { header: 'Net', width: 54, align: 'right' as const },
    { header: 'VAT amt', width: 52, align: 'right' as const },
    { header: 'Total', width: 56, align: 'right' as const },
  ];
  lineColumns[1]!.width =
    width - lineColumns.reduce((sum, column) => sum + column.width, 0);

  drawTable(doc, {
    columns: lineColumns,
    fontSize: 7.5,
    rows: document.lines.map((line) => [
      String(line.lineNumber),
      // The HS code belongs with the description rather than in a column of its
      // own: most lines do not carry one, and an empty column costs width that
      // the description is short of on every line that does.
      line.hsCode ? `${line.description}\nHS ${line.hsCode}` : line.description,
      line.quantity,
      line.uom,
      money(line.unitPrice),
      money(line.discount),
      // The rate alone on the line; the category it comes from is spelled out
      // once in the VAT summary. `STANDARD` and `OUT_OF_SCOPE` are database
      // spellings, and repeating one of them beside every rate would cost the
      // description a third of its width to say nothing new.
      `${line.vatRate}%`,
      money(line.net),
      money(line.vat),
      money(line.total),
    ]),
    onPageBreak: () => {
      doc.font(FONT.regular).fontSize(7.5).fillColor(INK.faint);
      doc.text(`${title} ${document.invoiceNumber} — line items continued`, left, doc.y, {
        width,
      });
      doc.y += 6;
    },
  });

  // --- VAT summary and totals ---------------------------------------------
  const summaryTop = doc.y + 16;
  const totalsWidth = 216;
  const summaryWidth = width - totalsWidth - 20;

  doc.y = summaryTop;
  const summaryHeight = drawVatSummary(doc, document, left, summaryWidth, money);
  const totalsHeight = drawTotals(doc, document, right - totalsWidth, summaryTop, totalsWidth, money);

  doc.y = summaryTop + Math.max(summaryHeight, totalsHeight) + 10;

  // --- The counterparty's verdict -----------------------------------------
  if (document.dispute) {
    const dispute = document.dispute;
    const bits: string[] = [];
    if (dispute.openedAt) bits.push(`Raised ${formatDay(dispute.openedAt)}`);
    if (dispute.reasonCode) {
      bits.push(`${dispute.reasonCode} — ${REASON_CODE_LABELS[dispute.reasonCode]}`);
    }

    drawPanel(doc, left, width, '#fef2f2', INK.danger, [
      {
        text: dispute.responseCode
          ? `${RESPONSE_CODE_LABELS[dispute.responseCode]} by the counterparty`
          : 'Disputed by the counterparty',
        font: FONT.bold,
        size: 8.5,
        color: INK.danger,
      },
      ...(bits.length
        ? [{ text: bits.join('  ·  '), font: FONT.regular, size: 8, color: INK.body }]
        : []),
      ...(dispute.comment
        ? [{ text: `“${dispute.comment}”`, font: FONT.italic, size: 8, color: INK.muted }]
        : []),
    ]);
  }

  // --- Provenance ----------------------------------------------------------
  doc.y += 8;
  doc.font(FONT.regular).fontSize(6.5).fillColor(INK.faint);
  if (document.ublXmlSha256) {
    doc.text(`Archived UBL XML digest (SHA-256): ${document.ublXmlSha256}`, left, doc.y, { width });
  }
  doc.text(
    document.direction === 'INBOUND_PURCHASE_AP'
      ? `Received and archived by ${document.platformName}.`
      : `Filed and archived by ${document.platformName}.`,
    left,
    doc.y,
    { width },
  );

  return pdf.done();
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function drawParty(
  doc: PDFKit.PDFDocument,
  caption: string,
  party: PrintableParty,
  x: number,
  y: number,
  width: number,
): number {
  doc.font(FONT.regular).fontSize(6.5).fillColor(INK.faint);
  doc.text(caption.toUpperCase(), x, y, { width, characterSpacing: 0.4 });

  doc.font(FONT.bold).fontSize(10).fillColor(INK.heading);
  doc.text(party.name, x, doc.y + 1, { width });

  doc.font(FONT.regular).fontSize(8).fillColor(INK.body);
  for (const line of party.addressLines) {
    if (line) doc.text(line, x, doc.y, { width });
  }

  doc.font(FONT.bold).fontSize(8).fillColor(INK.heading);
  // A missing buyer TRN is not an omission on a simplified invoice — it is the
  // fact that makes it one — so it is stated rather than left blank.
  doc.text(party.trn ? `TRN ${party.trn}` : 'Not registered for VAT', x, doc.y + 2, { width });

  doc.font(FONT.regular).fontSize(7.5).fillColor(INK.muted);
  const contact = [party.contactEmail, party.contactPhone].filter(Boolean).join(' · ');
  if (contact) doc.text(contact, x, doc.y, { width });

  return doc.y - y;
}

/** Facts flow into as many rows of four as they need. */
function drawFactGrid(
  doc: PDFKit.PDFDocument,
  facts: { label: string; value: string; mono?: boolean }[],
  left: number,
  width: number,
): void {
  const perRow = 4;
  const cell = width / perRow;
  let y = doc.y;

  for (let index = 0; index < facts.length; index += perRow) {
    const row = facts.slice(index, index + perRow);
    let height = 0;
    row.forEach((fact, column) => {
      const consumed = labelledValue(
        doc,
        fact.label,
        fact.value,
        left + column * cell,
        y,
        cell - 10,
        { mono: fact.mono },
      );
      height = Math.max(height, consumed);
    });
    y += height + 8;
  }

  doc.y = y;
}

/**
 * VAT broken out by category and rate.
 *
 * Article 59 wants the tax rate and tax amount per supply, which the line table
 * already gives. This block is what a VAT return is actually filled in from: one
 * taxable figure and one tax figure per rate, so that a document mixing 5% and
 * zero-rated lines can be transcribed without adding the lines up by hand.
 */
function drawVatSummary(
  doc: PDFKit.PDFDocument,
  document: PrintableDocument,
  x: number,
  width: number,
  money: (value: string) => string,
): number {
  const top = doc.y;

  doc.font(FONT.bold).fontSize(8).fillColor(INK.muted);
  doc.text('VAT SUMMARY', x, top, { width, characterSpacing: 0.6 });
  doc.y += 3;

  const groups = new Map<string, { category: string; rate: string; taxable: number; vat: number }>();
  for (const line of document.lines) {
    const key = `${line.vatCategory}|${line.vatRate}`;
    const group =
      groups.get(key) ??
      { category: categoryLabel(line.vatCategory), rate: line.vatRate, taxable: 0, vat: 0 };
    group.taxable += Number(line.net) || 0;
    group.vat += Number(line.vat) || 0;
    groups.set(key, group);
  }

  const columns = [
    { header: 'Category', width: width * 0.42 },
    { header: 'Rate', width: width * 0.14, align: 'right' as const },
    { header: `Taxable (${document.currencyCode})`, width: width * 0.22, align: 'right' as const },
    { header: `VAT (${document.currencyCode})`, width: width * 0.22, align: 'right' as const },
  ];

  // Positioned tables are not something drawTable does — it always starts at the
  // left margin — and a VAT summary in the left column is exactly what we want,
  // so it is drawn here directly rather than bent into the general engine.
  let y = doc.y;
  doc.font(FONT.bold).fontSize(6.5);
  const headerHeight = 13;
  doc.rect(x, y, width, headerHeight).fill(INK.band);
  let cursor = x;
  for (const column of columns) {
    doc.fillColor(INK.paper).text(column.header.toUpperCase(), cursor + 5, y + 3.5, {
      width: column.width - 10,
      align: column.align ?? 'left',
      lineBreak: false,
    });
    cursor += column.width;
  }
  y += headerHeight;

  for (const group of groups.values()) {
    const rowHeight = 14;
    doc.font(FONT.regular).fontSize(8).fillColor(INK.body);
    const cells = [
      group.category,
      `${group.rate}%`,
      money(group.taxable.toFixed(2)),
      money(group.vat.toFixed(2)),
    ];
    cursor = x;
    for (const [index, column] of columns.entries()) {
      doc.text(cells[index]!, cursor + 5, y + 3.5, {
        width: column.width - 10,
        align: column.align ?? 'left',
        lineBreak: false,
      });
      cursor += column.width;
    }
    doc
      .moveTo(x, y + rowHeight)
      .lineTo(x + width, y + rowHeight)
      .lineWidth(0.4)
      .strokeColor(INK.rule)
      .stroke();
    y += rowHeight;
  }

  doc.fillColor(INK.body);
  return y - top;
}

function drawTotals(
  doc: PDFKit.PDFDocument,
  document: PrintableDocument,
  x: number,
  y: number,
  width: number,
  money: (value: string) => string,
): number {
  const rows: { label: string; value: string; strong?: boolean }[] = [
    { label: 'Net of lines', value: money(document.totals.lineExtension) },
    { label: 'Tax exclusive amount', value: money(document.totals.taxExclusive) },
    { label: 'VAT total', value: money(document.totals.vatTotal) },
  ];

  const top = y;
  doc.font(FONT.bold).fontSize(8).fillColor(INK.muted);
  doc.text('TOTALS', x, top, { width, characterSpacing: 0.6 });

  let cursor = doc.y + 4;
  doc.rect(x, cursor, width, rows.length * 15 + 30).fill(INK.panel);

  cursor += 6;
  for (const row of rows) {
    doc.font(FONT.regular).fontSize(8.5).fillColor(INK.body);
    doc.text(row.label, x + 10, cursor, { width: width * 0.55, lineBreak: false });
    doc.text(row.value, x + 10, cursor, {
      width: width - 20,
      align: 'right',
      lineBreak: false,
    });
    cursor += 15;
  }

  doc
    .moveTo(x + 10, cursor + 1)
    .lineTo(x + width - 10, cursor + 1)
    .lineWidth(0.7)
    .strokeColor('#cbd5e1')
    .stroke();
  cursor += 7;

  doc.font(FONT.bold).fontSize(10).fillColor(INK.heading);
  doc.text(`Total payable (${document.currencyCode})`, x + 10, cursor, {
    width: width * 0.55,
    lineBreak: false,
  });
  doc.text(money(document.totals.payable), x + 10, cursor, {
    width: width - 20,
    align: 'right',
    lineBreak: false,
  });
  cursor += 16;

  // Article 59 requires the tax payable expressed in AED whatever the invoice is
  // denominated in, so a foreign-currency document always shows the converted
  // figure and the rate it was converted at.
  if (document.currencyCode !== 'AED') {
    doc.font(FONT.regular).fontSize(8).fillColor(INK.muted);
    doc.text(
      `AED ${money(document.totals.payableAed)} at ${document.exchangeRate} ${document.currencyCode}/AED`,
      x + 10,
      cursor,
      { width: width - 20, align: 'right', lineBreak: false },
    );
    cursor += 12;
  }

  doc.fillColor(INK.body);
  return cursor - top;
}

interface PanelLine {
  text: string;
  font: string;
  size: number;
  color: string;
}

/**
 * A tinted panel with a coloured left edge.
 *
 * The fill has to be painted before the text but sized from it, so the panel
 * takes its content as data and measures it rather than taking a draw callback:
 * measuring by drawing invisibly and rewinding leaves an invisible copy of every
 * string in the content stream and can trip a page break halfway through.
 */
function drawPanel(
  doc: PDFKit.PDFDocument,
  x: number,
  width: number,
  fill: string,
  edge: string,
  lines: PanelLine[],
): void {
  const inner = width - 24;
  const height =
    16 +
    lines.reduce((sum, line) => {
      doc.font(line.font).fontSize(line.size);
      return sum + doc.heightOfString(line.text, { width: inner });
    }, 0);

  const top = doc.y;
  doc.rect(x, top, width, height).fill(fill);
  doc.rect(x, top, 2.5, height).fill(edge);

  let y = top + 8;
  for (const line of lines) {
    doc.font(line.font).fontSize(line.size).fillColor(line.color);
    doc.text(line.text, x + 12, y, { width: inner });
    y = doc.y;
  }

  doc.x = x;
  doc.y = top + height + 10;
  doc.fillColor(INK.body);
}

async function renderQr(payload: string | null): Promise<Buffer | null> {
  if (!payload) return null;
  try {
    return await QRCode.toBuffer(payload, {
      type: 'png',
      margin: 0,
      width: 240,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f172aff', light: '#ffffffff' },
    });
  } catch {
    // A QR code that will not encode must not cost the merchant their invoice.
    // The TLV payload is on the archived XML either way.
    return null;
  }
}
