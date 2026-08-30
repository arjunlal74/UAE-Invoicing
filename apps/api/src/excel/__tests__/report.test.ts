import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { renderReportXlsx, renderWorkbookXlsx } from '../report.js';

/**
 * These assert what is in the cells, not that the renderer returned bytes.
 *
 * The whole reason this exists rather than a CSV built in the browser is that a
 * spreadsheet carries types: a quantity has to arrive as a number the reader
 * can sum, and a contract reference beginning with a zero has to survive as
 * text. A workbook that opens and looks right but stores every figure as a
 * string is the failure worth guarding against, because it looks like success
 * from every angle except the one the file was asked for.
 */

/** Load a rendered workbook back, the way the person who downloads it would. */
async function read(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
}

const BASE = {
  sheetName: 'Data inventory',
  title: 'Data Inventory Report',
  periodLabel: 'From 2026-01-01 to 2026-03-31',
  holderName: 'UAE E-Invoicing Portal',
  columns: ['Date', 'Reference', 'Opening', 'Buy', 'Balance'],
  rows: [
    ['2026-08-30', 'MARMIN-2026-001', 0, 100_000, 100_000],
    ['2026-08-30', '0012-LEADING-ZERO', 100_000, 0, 100_000],
  ] as (string | number)[][],
};

describe('report workbook', () => {
  it('keeps quantities as numbers so the columns can be summed', async () => {
    const sheet = (await read(await renderReportXlsx(BASE))).worksheets[0]!;

    // Find the header row rather than assuming its position: the title block
    // above it changes size with the inputs.
    let headerRow = 0;
    sheet.eachRow((row, n) => {
      if (row.getCell(1).value === 'Date') headerRow = n;
    });
    expect(headerRow).toBeGreaterThan(0);

    const first = sheet.getRow(headerRow + 1);
    expect(typeof first.getCell(3).value).toBe('number');
    expect(typeof first.getCell(4).value).toBe('number');
    expect(first.getCell(4).value).toBe(100_000);
  });

  it('leaves a reference that only looks numeric as text', async () => {
    const sheet = (await read(await renderReportXlsx(BASE))).worksheets[0]!;

    let found: unknown;
    sheet.eachRow((row) => {
      if (String(row.getCell(2).value).startsWith('0012')) found = row.getCell(2).value;
    });

    // Stored as text, so the leading zero is still there when it is opened.
    expect(found).toBe('0012-LEADING-ZERO');
    expect(typeof found).toBe('string');
  });

  it('states the period on the sheet', async () => {
    const sheet = (await read(await renderReportXlsx(BASE))).worksheets[0]!;

    const lines: string[] = [];
    sheet.eachRow((row) => lines.push(String(row.getCell(1).value ?? '')));

    // A report with no dates on it is worthless once it leaves the screen it
    // was run on, and these get handed to auditors.
    expect(lines).toContain('From 2026-01-01 to 2026-03-31');
    expect(lines).toContain('Data Inventory Report');
  });

  it('says so when the query hit its row cap', async () => {
    const sheet = (await read(await renderReportXlsx({ ...BASE, truncated: true }))).worksheets[0]!;

    const text: string[] = [];
    sheet.eachRow((row) => text.push(String(row.getCell(1).value ?? '')));

    expect(text.some((line) => line.includes('row limit'))).toBe(true);
  });

  it('gives each table its own tab rather than stacking them', async () => {
    const workbook = await read(
      await renderWorkbookXlsx([
        { ...BASE, sheetName: 'KPIs' },
        { ...BASE, sheetName: 'Dispute aging' },
        { ...BASE, sheetName: 'Reason Pareto' },
      ]),
    );

    // Stacked on one sheet, sorting the first table destroys the ones below it.
    expect(workbook.worksheets.map((s) => s.name)).toEqual([
      'KPIs',
      'Dispute aging',
      'Reason Pareto',
    ]);
  });

  it('sanitises a sheet name Excel would refuse', async () => {
    const workbook = await read(
      await renderReportXlsx({ ...BASE, sheetName: 'AR/AP: 2026 [draft]?' }),
    );

    const name = workbook.worksheets[0]!.name;
    expect(name).not.toMatch(/[*?:\\/[\]]/);
    expect(name.length).toBeLessThanOrEqual(31);
  });

  it('survives a report with no rows at all', async () => {
    const workbook = await read(await renderReportXlsx({ ...BASE, rows: [] }));
    expect(workbook.worksheets[0]!.name).toBe('Data inventory');
  });
});
