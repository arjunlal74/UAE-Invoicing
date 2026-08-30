import ExcelJS from 'exceljs';

/**
 * A report as a workbook (SRS v2.8 §13.2).
 *
 * The third way out of a report, beside the screen and the PDF. It exists
 * because the other two are read-only: the person who asks for a spend report
 * in Excel is going to pivot it, and handing them a PDF means they retype it.
 *
 * Written server-side rather than as a CSV built in the browser. A CSV is not a
 * spreadsheet — it carries no column types, so a reference like `0012` opens as
 * `12` and a date opens as whatever the reader's locale guesses — and the whole
 * point of the file is that the figures survive the trip.
 *
 * The layout is deliberately plain: a title block, one header row, then data.
 * Anything more decorative gets in the way of the first thing anyone does to
 * these, which is select a column and look at the sum.
 */

export interface ReportXlsxInput {
  /** Tab name. Trimmed and sanitised — Excel refuses several characters. */
  sheetName: string;
  title: string;
  subtitle?: string | null;
  /** Stated on the sheet, because a report with no period on it is worthless. */
  periodLabel: string;
  /** Whose figures these are. */
  holderName?: string | null;
  columns: string[];
  rows: (string | number | null)[][];
  /** Truthful when the underlying query hit its row cap. */
  truncated?: boolean;
  /** Appended under the table — totals, caveats, whatever the report owes. */
  notes?: string[];
}

/** Excel rejects these in a sheet name, and silently truncates past 31 chars. */
function safeSheetName(name: string): string {
  const cleaned = name.replace(/[*?:\\/[\]]/g, ' ').trim();
  return (cleaned || 'Report').slice(0, 31);
}

/**
 * Width from the content, capped.
 *
 * A column of long descriptions would otherwise push the numbers off the first
 * screen, which defeats the point of opening it in a spreadsheet at all.
 */
function columnWidths(columns: string[], rows: (string | number | null)[][]): number[] {
  return columns.map((heading, index) => {
    const longest = rows.reduce((max, row) => {
      const cell = row[index];
      return Math.max(max, cell === null || cell === undefined ? 0 : String(cell).length);
    }, heading.length);
    return Math.min(Math.max(longest + 2, 10), 48);
  });
}

/** One report, one sheet. */
export async function renderReportXlsx(input: ReportXlsxInput): Promise<Buffer> {
  return renderWorkbookXlsx([input]);
}

/**
 * Several tables in one file.
 *
 * The KPI pack is four tables that only mean something together — a dispute
 * rate beside the reasons for it — so they travel as four tabs rather than four
 * downloads the reader has to line up themselves.
 */
export async function renderWorkbookXlsx(sheets: ReportXlsxInput[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = sheets[0]?.holderName ?? 'UAE E-Invoicing';
  workbook.created = new Date();

  for (const input of sheets) addSheet(workbook, input);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function addSheet(workbook: ExcelJS.Workbook, input: ReportXlsxInput): void {
  const sheet = workbook.addWorksheet(safeSheetName(input.sheetName), {
    views: [{ state: 'frozen', ySplit: 0 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const span = Math.max(input.columns.length, 1);

  // --- the title block ----------------------------------------------------
  const heading = [input.title];
  if (input.holderName) heading.push(input.holderName);
  if (input.subtitle) heading.push(input.subtitle);
  heading.push(input.periodLabel);

  for (const [index, line] of heading.entries()) {
    const row = sheet.addRow([line]);
    sheet.mergeCells(row.number, 1, row.number, span);
    row.getCell(1).font = {
      bold: index === 0,
      size: index === 0 ? 14 : 11,
      color: { argb: index === 0 ? 'FF0F1C2B' : 'FF475569' },
    };
  }
  sheet.addRow([]);

  // --- the table ----------------------------------------------------------
  const headerRow = sheet.addRow(input.columns);
  headerRow.font = { bold: true, color: { argb: 'FF1E3A5F' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD6E4F5' } };
  headerRow.border = { bottom: { style: 'thin', color: { argb: 'FF94A3B8' } } };

  for (const row of input.rows) {
    const added = sheet.addRow(row.map((cell) => cell ?? ''));
    // Numbers right-align themselves once they are numbers; strings that only
    // look numeric are left as text on purpose, because a reference beginning
    // with a zero is not a quantity.
    added.eachCell((cell) => {
      if (typeof cell.value === 'number') cell.numFmt = '#,##0';
    });
  }

  // The header row is what a reader scrolls away from first, so it is pinned
  // once its position is known rather than guessed at sheet creation.
  sheet.views = [{ state: 'frozen', ySplit: headerRow.number }];
  sheet.autoFilter = {
    from: { row: headerRow.number, column: 1 },
    to: { row: headerRow.number, column: span },
  };

  const widths = columnWidths(input.columns, input.rows);
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });

  // --- what the table could not say itself --------------------------------
  const notes = [...(input.notes ?? [])];
  if (input.truncated) {
    notes.push('This report hit its row limit. Narrow the period to see every row.');
  }

  if (notes.length > 0) {
    sheet.addRow([]);
    for (const note of notes) {
      const row = sheet.addRow([note]);
      sheet.mergeCells(row.number, 1, row.number, span);
      row.getCell(1).font = { italic: true, size: 10, color: { argb: 'FF475569' } };
    }
  }
}
