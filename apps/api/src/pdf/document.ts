import PDFDocument from 'pdfkit';

/**
 * The shared PDF chrome.
 *
 * Every printable artefact the platform produces — a tax invoice, a credit
 * note, one of the §13.2 reports, the §13.1 KPI pack — is drawn through this
 * module so that they come off the press looking like documents from the same
 * organisation. The invoice a merchant emails to a customer and the reconciliation
 * report their accountant hands an FTA auditor carry the same footer, the same
 * page numbering and the same generated-at stamp, which is what makes the pair
 * legible as evidence from one system.
 *
 * Only the fourteen standard PDF fonts are used, which means no font files to
 * ship and no licence to track — at the cost of Latin script only. Every party
 * name that reaches a document here is the `_en` column for exactly that reason
 * (see `printable.ts`); the Arabic legal name lives in the UBL XML, which is the
 * artefact the tax authority actually reads.
 */

type Doc = PDFKit.PDFDocument;

/** Mirrors the portal's Tailwind palette so print and screen agree. */
export const INK = {
  heading: '#0f172a',
  body: '#334155',
  muted: '#64748b',
  faint: '#94a3b8',
  rule: '#e2e8f0',
  zebra: '#f8fafc',
  panel: '#f1f5f9',
  band: '#1e3a5f',
  accent: '#1e5aa8',
  accentSoft: '#eff6ff',
  ok: '#047857',
  warn: '#b45309',
  danger: '#b91c1c',
  paper: '#ffffff',
} as const;

export const FONT = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique',
} as const;

const MARGINS = { top: 44, bottom: 56, left: 40, right: 40 };

export interface PdfOptions {
  /** PDF metadata title, and the left-hand caption in the footer band. */
  title: string;
  subject?: string;
  landscape?: boolean;
  /** Right-hand caption in the footer band — normally the tenant's legal name. */
  footerNote?: string;
  /** Free text under the footer rule, e.g. the statutory retention notice. */
  footerLegal?: string;
  /**
   * Diagonal stamp for a document that is not what it looks like — a draft, an
   * unfiled invoice. Applied to every page in the closing pass rather than at
   * the point of writing, because a three-page draft with the word DRAFT on the
   * first page only is worse than no watermark at all.
   */
  watermark?: string;
}

export interface PdfHandle {
  doc: Doc;
  /** Usable width between the margins on the current page. */
  readonly width: number;
  /** The y beyond which content must not be drawn. */
  bottomLimit(): number;
  /** Stamp footers on every page and resolve the finished bytes. */
  done(): Promise<Buffer>;
}

/**
 * Open a document with the collector already attached.
 *
 * The `data` listener has to exist before anything is written: a PDFDocument is
 * a readable stream, and without a consumer the first pages sit in the internal
 * buffer until something switches it to flowing mode. Attaching at the end has
 * worked by accident often enough to be a trap worth closing here.
 */
export function startPdf(options: PdfOptions): PdfHandle {
  const chunks: Buffer[] = [];

  const doc = new PDFDocument({
    size: 'A4',
    layout: options.landscape ? 'landscape' : 'portrait',
    margins: { ...MARGINS },
    // We add the first page ourselves so that page one goes through exactly the
    // same path as every continuation page.
    autoFirstPage: false,
    bufferPages: true,
    info: {
      Title: options.title,
      Subject: options.subject ?? options.title,
      Producer: 'UAE E-Invoicing Portal',
      Creator: 'UAE E-Invoicing Portal',
    },
  });

  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.addPage();

  return {
    doc,
    get width() {
      return doc.page.width - doc.page.margins.left - doc.page.margins.right;
    },
    bottomLimit: () => doc.page.height - doc.page.margins.bottom,
    async done() {
      drawFooters(doc, options);
      doc.end();
      return finished;
    },
  };
}

/**
 * "Page 3 of 7" can only be written once the total is known, so footers are
 * stamped in a second pass over the buffered pages. The bottom margin is
 * dropped first: writing into the footer band with it in place would trip
 * pdfkit's automatic page break and append a blank page per page.
 */
function drawFooters(doc: Doc, options: PdfOptions): void {
  const range = doc.bufferedPageRange();
  const stamp = formatStamp(new Date());

  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    doc.page.margins.bottom = 0;

    if (options.watermark) drawWatermark(doc, options.watermark);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const y = doc.page.height - 42;

    doc.save();
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(INK.rule).stroke();

    doc.font(FONT.regular).fontSize(7).fillColor(INK.faint);
    doc.text(options.footerNote ?? options.title, left, y + 6, {
      width: (right - left) * 0.55,
      lineBreak: false,
    });
    doc.text(`Generated ${stamp} · Page ${index + 1} of ${range.count}`, left, y + 6, {
      width: right - left,
      align: 'right',
      lineBreak: false,
    });

    if (options.footerLegal) {
      doc.fontSize(6.5).fillColor(INK.faint);
      doc.text(options.footerLegal, left, y + 17, { width: right - left, lineBreak: false });
    }
    doc.restore();
  }
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface TableColumn {
  header: string;
  width: number;
  align?: 'left' | 'right';
}

export interface TableOptions {
  columns: TableColumn[];
  rows: string[][];
  fontSize?: number;
  headerFontSize?: number;
  zebra?: boolean;
  /**
   * Drawn immediately after a page break, before the header row is repeated —
   * a report that runs to ninety pages needs its title on every one of them or
   * a page pulled out of the middle is unattributable.
   */
  onPageBreak?: () => void;
}

const CELL_PAD_X = 5;
const CELL_PAD_Y = 4;

export function drawTable(doc: Doc, options: TableOptions): void {
  const { columns, rows } = options;
  const size = options.fontSize ?? 8.5;
  const headerSize = options.headerFontSize ?? 7;
  const total = columns.reduce((sum, column) => sum + column.width, 0);

  const drawHeaderRow = () => {
    const left = doc.page.margins.left;
    const top = doc.y;
    doc.font(FONT.bold).fontSize(headerSize);

    const height =
      columns.reduce(
        (max, column) =>
          Math.max(max, doc.heightOfString(column.header, { width: column.width - CELL_PAD_X * 2 })),
        0,
      ) +
      CELL_PAD_Y * 2;

    doc.rect(left, top, total, height).fill(INK.band);

    let x = left;
    for (const column of columns) {
      doc.fillColor(INK.paper).text(column.header.toUpperCase(), x + CELL_PAD_X, top + CELL_PAD_Y, {
        width: column.width - CELL_PAD_X * 2,
        align: column.align ?? 'left',
      });
      x += column.width;
    }

    doc.y = top + height;
    doc.fillColor(INK.body);
  };

  drawHeaderRow();

  rows.forEach((row, index) => {
    doc.font(FONT.regular).fontSize(size);

    const height =
      columns.reduce(
        (max, column, columnIndex) =>
          Math.max(
            max,
            doc.heightOfString(row[columnIndex] ?? '', { width: column.width - CELL_PAD_X * 2 }),
          ),
        0,
      ) +
      CELL_PAD_Y * 2;

    if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      options.onPageBreak?.();
      drawHeaderRow();
      doc.font(FONT.regular).fontSize(size);
    }

    const left = doc.page.margins.left;
    const top = doc.y;

    if (options.zebra !== false && index % 2 === 1) {
      doc.rect(left, top, total, height).fill(INK.zebra);
    }

    let x = left;
    for (const [columnIndex, column] of columns.entries()) {
      doc.fillColor(INK.body).text(row[columnIndex] ?? '', x + CELL_PAD_X, top + CELL_PAD_Y, {
        width: column.width - CELL_PAD_X * 2,
        align: column.align ?? 'left',
      });
      x += column.width;
    }

    doc
      .moveTo(left, top + height)
      .lineTo(left + total, top + height)
      .lineWidth(0.4)
      .strokeColor(INK.rule)
      .stroke();

    // Cells are positioned absolutely, so pdfkit's own cursor is wherever the
    // last one left it. Put it back on the row boundary before the next row.
    doc.y = top + height;
  });

  doc.fillColor(INK.body);
}

/** Right-hand columns of digits should be right-aligned; words should not. */
const NUMERIC = /^-?[\d,]+(\.\d+)?%?$/;

/**
 * Decide alignment per column rather than per cell.
 *
 * The portal's CSV/table view tests each cell individually, which is fine when
 * every cell keeps its own box. On a printed page a column where nine values
 * are flush right and the tenth — a dash, an empty string, "n/a" — is flush
 * left reads as a typesetting fault, so a column here is numeric only if all of
 * its non-empty values are.
 */
export function numericColumns(rows: string[][], columnCount: number): boolean[] {
  return Array.from({ length: columnCount }, (_unused, index) => {
    let sawValue = false;
    for (const row of rows) {
      const cell = (row[index] ?? '').trim();
      if (!cell) continue;
      if (!NUMERIC.test(cell)) return false;
      sawValue = true;
    }
    return sawValue;
  });
}

const MIN_COLUMN_WIDTH = 34;

/**
 * Fit arbitrary report columns to the page.
 *
 * Report shapes are not known here — they come from whatever the §13.2 query
 * returned — so widths are measured from the content and then squeezed. Two
 * details matter: a single verbose column (a free-text comment, a long supplier
 * name) is capped so it cannot starve the rest, and the squeeze never takes a
 * column below a floor, because a 12-point column does not wrap, it disappears.
 */
export function autoColumnWidths(
  doc: Doc,
  headers: string[],
  rows: string[][],
  available: number,
  fontSize: number,
  headerFontSize: number,
): number[] {
  // Measuring every cell of a five-thousand-row audit log to lay out a table
  // costs more than it can possibly teach us; the first few hundred rows
  // establish the shape of the data.
  const sample = rows.slice(0, 250);
  const cap = available * 0.32;

  const widths = headers.map((header, index) => {
    doc.font(FONT.bold).fontSize(headerFontSize);
    let natural = doc.widthOfString(header.toUpperCase());

    doc.font(FONT.regular).fontSize(fontSize);
    for (const row of sample) {
      natural = Math.max(natural, doc.widthOfString(row[index] ?? ''));
    }

    return Math.min(cap, natural + CELL_PAD_X * 2 + 2);
  });

  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const natural = sum(widths);

  if (natural <= available) {
    // Spread the slack proportionally so the table reaches both margins; a
    // table floating in the left two-thirds of a landscape page looks broken.
    const scale = available / natural;
    return widths.map((w) => w * scale);
  }

  // Otherwise: cap every column at a common ceiling and find the ceiling that
  // makes the total fit. Taking the overflow proportionally from all columns
  // instead — the obvious approach — is what breaks these tables: a supplier
  // name wraps to a second line and reads fine, but a date or a 15-digit TRN
  // is an atomic token, and shaving four points off it splits "2026-07-14"
  // across two lines to buy width a prose column did not need.
  let low = MIN_COLUMN_WIDTH;
  let high = Math.max(...widths);
  for (let pass = 0; pass < 30; pass += 1) {
    const mid = (low + high) / 2;
    if (sum(widths.map((w) => Math.min(w, mid))) > available) high = mid;
    else low = mid;
  }

  const ceiling = low;
  const capped = widths.map((w) => Math.max(MIN_COLUMN_WIDTH, Math.min(w, ceiling)));

  // The floor can push the total back over when there are more columns than
  // the page has room for at all; a uniform scale is the honest last resort.
  const total = sum(capped);
  return total > available ? capped.map((w) => (w * available) / total) : capped;
}

/**
 * Break the page if `needed` points are not left on it.
 *
 * Used before a heading so that a heading and the first rows of what it
 * introduces stay together: a title alone at the foot of a page, with its table
 * overleaf, is the one pagination fault every reader notices.
 */
export function ensureSpace(doc: Doc, needed: number): void {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

// ---------------------------------------------------------------------------
// Small drawing helpers
// ---------------------------------------------------------------------------

/** A section rule with a caption, used to separate blocks on a page. */
export function sectionHeading(doc: Doc, text: string, spacingAbove = 14): void {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  doc.y += spacingAbove;

  doc.font(FONT.bold).fontSize(8).fillColor(INK.muted);
  doc.text(text.toUpperCase(), left, doc.y, { width: right - left, characterSpacing: 0.6 });

  const y = doc.y + 3;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.7).strokeColor(INK.rule).stroke();
  doc.y = y + 7;
  doc.fillColor(INK.body);
}

/** A rounded status chip. Returns the width consumed so callers can lay out a row of them. */
export function chip(
  doc: Doc,
  label: string,
  x: number,
  y: number,
  tone: { fill: string; text: string },
): number {
  doc.font(FONT.bold).fontSize(7);
  const width = doc.widthOfString(label.toUpperCase()) + 12;
  doc.roundedRect(x, y, width, 13, 3).fill(tone.fill);
  doc.fillColor(tone.text).text(label.toUpperCase(), x + 6, y + 3.5, { lineBreak: false });
  doc.fillColor(INK.body);
  return width;
}

/** A label-over-value pair, the unit the invoice meta strip is built from. */
export function labelledValue(
  doc: Doc,
  label: string,
  value: string,
  x: number,
  y: number,
  width: number,
  options: { mono?: boolean } = {},
): number {
  doc.font(FONT.regular).fontSize(6.5).fillColor(INK.faint);
  doc.text(label.toUpperCase(), x, y, { width, characterSpacing: 0.4, lineBreak: false });

  doc
    .font(options.mono ? FONT.regular : FONT.bold)
    .fontSize(options.mono ? 7.5 : 8.5)
    .fillColor(INK.heading);
  doc.text(value || '—', x, y + 9, { width });

  return doc.y - y;
}

/**
 * The diagonal stamp across a page.
 *
 * `save`/`restore` return the graphics state but not the text cursor, so the
 * cursor is put back by hand: drawing a 56pt string in the middle of the page
 * leaves `doc.y` halfway down it, and the next thing written would start from
 * there. That is a page-and-a-half of blank paper on every watermarked document.
 */
function drawWatermark(doc: Doc, text: string, color = '#dc2626'): void {
  const { x, y } = doc;

  doc.save();
  doc.rotate(-38, { origin: [doc.page.width / 2, doc.page.height / 2] });
  doc
    .font(FONT.bold)
    .fontSize(56)
    .fillColor(color)
    .fillOpacity(0.1)
    .text(text.toUpperCase(), 0, doc.page.height / 2 - 34, {
      width: doc.page.width,
      align: 'center',
      lineBreak: false,
    });
  doc.restore();

  doc.fillOpacity(1).fillColor(INK.body);
  doc.x = x;
  doc.y = y;
}

export function formatStamp(date: Date): string {
  // Fixed to Gulf Standard Time rather than the server's zone: a document whose
  // timestamp shifts because it was rendered on a machine in another region is
  // no use as evidence of when it was produced.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('day')} ${get('month')} ${get('year')} ${get('hour')}:${get('minute')} GST`;
}

export function formatDay(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  }).format(date);
}

/** Filenames end up in Content-Disposition and on a user's disk. */
export function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'document';
}
