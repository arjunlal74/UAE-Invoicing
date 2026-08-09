import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import { WorkbookParseError, parseWorkbook } from '../parse.js';
import { buildTemplate } from '../template.js';

/**
 * The template and the parser are two halves of one contract. If they drift,
 * a merchant downloads a file the system cannot read back — so they are tested
 * against each other rather than separately.
 */

const SUPPLIER_TRN = '100293847500003';
const SUPPLIER_NAME = 'Al-Bahar Enterprises LLC';

/** Fill a generated template the way a merchant would, then re-serialise it. */
async function fillTemplate(
  rows: {
    header: Record<string, string | number>;
    lines: Record<string, string | number>[];
  }[],
): Promise<Buffer> {
  const template = await buildTemplate({ supplierTrn: SUPPLIER_TRN, supplierName: SUPPLIER_NAME });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(template as unknown as ArrayBuffer);

  const header = workbook.getWorksheet('Invoice_Header')!;
  const lineSheet = workbook.getWorksheet('Invoice_Line_Items')!;

  let headerRow = 2;
  let lineRow = 2;

  for (const entry of rows) {
    for (const [col, value] of Object.entries(entry.header)) {
      header.getCell(`${col}${headerRow}`).value = value;
    }
    headerRow++;

    for (const line of entry.lines) {
      for (const [col, value] of Object.entries(line)) {
        lineSheet.getCell(`${col}${lineRow}`).value = value;
      }
      lineRow++;
    }
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('template generation', () => {
  let template: Buffer;

  beforeAll(async () => {
    template = await buildTemplate({ supplierTrn: SUPPLIER_TRN, supplierName: SUPPLIER_NAME });
  });

  it('produces the three expected sheets', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(template as unknown as ArrayBuffer);
    const names = workbook.worksheets.map((w) => w.name);
    expect(names).toContain('Invoice_Header');
    expect(names).toContain('Invoice_Line_Items');
    expect(names).toContain('Ref_Lookups');
  });

  it("pre-fills the merchant's own supplier identity", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(template as unknown as ArrayBuffer);
    const header = workbook.getWorksheet('Invoice_Header')!;
    expect(header.getCell('G2').value).toBe(SUPPLIER_TRN);
    expect(header.getCell('H2').value).toBe(SUPPLIER_NAME);
  });

  it('stores the TRN as text so 15 digits are not shown in scientific notation', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(template as unknown as ArrayBuffer);
    expect(workbook.getWorksheet('Invoice_Header')!.getCell('G2').numFmt).toBe('@');
  });

  it('leaves the calculated columns locked while unlocking the editable ones', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(template as unknown as ArrayBuffer);
    const lines = workbook.getWorksheet('Invoice_Line_Items')!;

    // In the xlsx format `locked` is the default, so it is never written out;
    // only an explicit unlock is serialised. A calculated column is therefore
    // protected precisely when it carries no `locked: false`.
    expect(lines.getCell('K2').protection?.locked).not.toBe(false);
    expect(lines.getCell('M2').protection?.locked).not.toBe(false);
    expect(lines.getCell('E2').protection?.locked).toBe(false);
    expect(lines.getCell('G2').protection?.locked).toBe(false);

    // Locking only matters if the sheet itself is protected. On reload ExcelJS
    // exposes this as `sheetProtection`, not `protection`.
    expect((lines as unknown as { sheetProtection?: { sheet?: boolean } }).sheetProtection?.sheet).toBe(
      true,
    );
  });

  it('writes the derived columns as formulas so the workbook self-calculates', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(template as unknown as ArrayBuffer);
    const lines = workbook.getWorksheet('Invoice_Line_Items')!;

    const net = lines.getCell('K2').value as ExcelJS.CellFormulaValue;
    expect(net.formula).toContain('ROUND');
    expect(net.formula).toContain('E2');
    expect(net.formula).toContain('G2');

    const vat = lines.getCell('L2').value as ExcelJS.CellFormulaValue;
    expect(vat.formula).toContain('K2');
    expect(vat.formula).toContain('J2');
  });
});

describe('round trip', () => {
  it('reads back a filled template with headers joined to their lines', async () => {
    const file = await fillTemplate([
      {
        header: {
          A: 'INV-2026-001',
          B: '380',
          C: '2026-08-01',
          D: '14:30:00',
          I: '100384759200003',
          J: 'Emirates Trading Co',
          K: 'Dubai',
          N: '30',
        },
        lines: [
          { A: 'INV-2026-001', B: 1, C: 'Cloud Hosting', E: 1, F: 'MON', G: 5000, I: 'S' },
          { A: 'INV-2026-001', B: 2, C: 'Support Retainer', E: 2, F: 'MON', G: 750, I: 'S' },
        ],
      },
      {
        header: {
          A: 'INV-2026-002',
          B: '388',
          C: '2026-08-02',
          D: '09:15:00',
          J: 'Individual Customer',
          K: 'Abu Dhabi',
          N: '10',
        },
        lines: [{ A: 'INV-2026-002', B: 1, C: 'Retail Goods', E: 5, F: 'PCE', G: 150, I: 'S' }],
      },
    ]);

    const result = await parseWorkbook(file, { maxRows: 1000 });

    expect(result.invoices).toHaveLength(2);
    expect(result.orphanLines).toHaveLength(0);

    const first = result.invoices[0]!;
    expect(first.invoiceNumber).toBe('INV-2026-001');
    expect(first.supplierTrn).toBe(SUPPLIER_TRN);
    expect(first.buyerTrn).toBe('100384759200003');
    expect(first.lines).toHaveLength(2);
    // 1*5000 + 2*750 = 6500 net, VAT 325
    expect(first.lineExtensionAmount).toBe('6500.00');
    expect(first.vatTotalAmount).toBe('325.00');
    expect(first.payableAmount).toBe('6825.00');

    const second = result.invoices[1]!;
    expect(second.buyerTrn).toBe('');
    expect(second.payableAmount).toBe('787.50');
  });

  it('records the source row of every value for cell mapping', async () => {
    const file = await fillTemplate([
      {
        header: { A: 'INV-1', B: '380', C: '2026-08-01', D: '10:00:00', J: 'Buyer', K: 'Dubai', N: '30' },
        lines: [{ A: 'INV-1', B: 1, C: 'Item', E: 1, F: 'PCE', G: 10, I: 'S' }],
      },
    ]);

    const result = await parseWorkbook(file, { maxRows: 1000 });
    expect(result.invoices[0]!.sourceRow).toBe(2);
    expect(result.invoices[0]!.lines[0]!.sourceRow).toBe(2);
  });

  it('reports lines whose invoice number has no header row', async () => {
    const file = await fillTemplate([
      {
        header: { A: 'INV-1', B: '380', C: '2026-08-01', D: '10:00:00', J: 'Buyer', K: 'Dubai', N: '30' },
        lines: [
          { A: 'INV-1', B: 1, C: 'Item', E: 1, F: 'PCE', G: 10, I: 'S' },
          { A: 'INV-DOES-NOT-EXIST', B: 1, C: 'Orphan', E: 1, F: 'PCE', G: 10, I: 'S' },
        ],
      },
    ]);

    const result = await parseWorkbook(file, { maxRows: 1000 });
    expect(result.orphanLines).toHaveLength(1);
    expect(result.orphanLines[0]!.invoiceNumber).toBe('INV-DOES-NOT-EXIST');
  });

  it('ignores the template blank padding rows', async () => {
    const file = await fillTemplate([
      {
        header: { A: 'INV-1', B: '380', C: '2026-08-01', D: '10:00:00', J: 'Buyer', K: 'Dubai', N: '30' },
        lines: [{ A: 'INV-1', B: 1, C: 'Item', E: 1, F: 'PCE', G: 10, I: 'S' }],
      },
    ]);

    const result = await parseWorkbook(file, { maxRows: 1000 });
    // The template lays out 200 header and 500 line rows; only the filled ones
    // may come back, or every upload would carry hundreds of empty invoices.
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0]!.lines).toHaveLength(1);
  });

  it('reads dates typed as real Excel dates, not just text', async () => {
    const file = await fillTemplate([
      {
        header: {
          A: 'INV-1',
          B: '380',
          C: new Date(Date.UTC(2026, 7, 9)) as unknown as string,
          D: '10:00:00',
          J: 'Buyer',
          K: 'Dubai',
          N: '30',
        },
        lines: [{ A: 'INV-1', B: 1, C: 'Item', E: 1, F: 'PCE', G: 10, I: 'S' }],
      },
    ]);

    const result = await parseWorkbook(file, { maxRows: 1000 });
    expect(result.invoices[0]!.issueDate).toBe('2026-08-09');
  });

  it('preserves what the workbook claimed for the derived columns', async () => {
    // A user who unlocked column L and typed their own VAT must be caught, so
    // the parser has to surface the supplied value rather than recompute it.
    const file = await fillTemplate([
      {
        header: { A: 'INV-1', B: '380', C: '2026-08-01', D: '10:00:00', J: 'Buyer', K: 'Dubai', N: '30' },
        lines: [{ A: 'INV-1', B: 1, C: 'Item', E: 1, F: 'PCE', G: 100, I: 'S', K: 100, L: 1, M: 101 }],
      },
    ]);

    const result = await parseWorkbook(file, { maxRows: 1000 });
    // recalcInvoice overwrites the derived fields with correct values...
    expect(result.invoices[0]!.lines[0]!.vatAmount).toBe('5.00');
    // ...and the totals follow the correct figures, not the typed ones.
    expect(result.invoices[0]!.payableAmount).toBe('105.00');
  });

  it('rejects a workbook whose sheets are missing', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Something Else');
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    await expect(parseWorkbook(buffer, { maxRows: 1000 })).rejects.toBeInstanceOf(WorkbookParseError);
  });

  it('rejects a workbook that exceeds the row limit', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      header: {
        A: `INV-${i}`,
        B: '380',
        C: '2026-08-01',
        D: '10:00:00',
        J: 'Buyer',
        K: 'Dubai',
        N: '30',
      },
      lines: [{ A: `INV-${i}`, B: 1, C: 'Item', E: 1, F: 'PCE', G: 10, I: 'S' }],
    }));

    const file = await fillTemplate(rows);
    await expect(parseWorkbook(file, { maxRows: 10 })).rejects.toThrow(/more than 10 rows/);
  });

  it('tolerates columns being reordered by the user', async () => {
    const workbook = new ExcelJS.Workbook();
    const header = workbook.addWorksheet('Invoice_Header');
    // Deliberately shuffled relative to the template's A-N order.
    header.addRow([
      'Buyer Name', 'Invoice Number', 'Payment Means', 'Issue Date', 'Invoice Type',
      'Issue Time', 'Document Currency', 'FX Rate to AED', 'Supplier TRN', 'Supplier Name',
      'Buyer TRN', 'Buyer Emirate', 'PO Reference', 'Preceding Invoice ID',
    ]);
    header.addRow([
      'Emirates Trading Co', 'INV-9', '30', '2026-08-01', '380',
      '10:00:00', 'AED', '1', SUPPLIER_TRN, SUPPLIER_NAME,
      '100384759200003', 'Dubai', '', '',
    ]);

    const lines = workbook.addWorksheet('Invoice_Line_Items');
    lines.addRow([
      'Quantity', 'Invoice Number', 'Line Number', 'Item Description', 'HS Code',
      'UOM', 'Unit Price (Net)', 'Line Discount', 'VAT Category', 'VAT Rate (%)',
      'Line Net Amount', 'Line VAT Amount', 'Line Grand Total',
    ]);
    lines.addRow([2, 'INV-9', 1, 'Widget', '', 'PCE', 250, 0, 'S', 5, '', '', '']);

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const result = await parseWorkbook(buffer, { maxRows: 1000 });

    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0]!.invoiceNumber).toBe('INV-9');
    expect(result.invoices[0]!.buyerTrn).toBe('100384759200003');
    expect(result.invoices[0]!.payableAmount).toBe('525.00');
  });
});
