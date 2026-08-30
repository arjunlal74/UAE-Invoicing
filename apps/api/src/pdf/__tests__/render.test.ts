import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { autoColumnWidths, numericColumns, startPdf } from '../document.js';
import { renderInvoicePdf, type PrintableDocument } from '../invoice.js';
import { renderReportPdf } from '../report.js';

/**
 * These assert what is actually on the paper, not that the renderer returned
 * without throwing. A PDF that comes back 8kB and blank is the failure mode
 * worth guarding against: it looks like success from every angle except the one
 * that matters, and nobody notices until a customer opens the invoice.
 */

/** Every visible text run, per page, in drawing order. */
function textByPage(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  const pages: string[] = [];

  let cursor = 0;
  for (;;) {
    const open = raw.indexOf('stream', cursor);
    if (open < 0) break;
    let start = open + 6;
    if (raw[start] === '\r') start += 1;
    if (raw[start] === '\n') start += 1;
    const close = raw.indexOf('endstream', start);
    if (close < 0) break;

    try {
      const content = inflateSync(Buffer.from(raw.slice(start, close), 'latin1')).toString('latin1');
      if (content.includes('BT')) {
        const runs = (content.match(/\[([\s\S]*?)\] TJ/g) ?? []).map((run) =>
          (run.match(/<([0-9a-fA-F]*)>/g) ?? [])
            .map((hex) => Buffer.from(hex.slice(1, -1), 'hex').toString('latin1'))
            .join(''),
        );
        // Non-ASCII lands here as WinAnsi bytes; assertions are on ASCII, so
        // collapse the rest to spaces rather than asserting on mojibake.
        pages.push(runs.join('\n').replace(/[^\x20-\x7e\n]/g, ' '));
      }
    } catch {
      // Not a Flate-compressed content stream (an embedded PNG, say).
    }
    cursor = close + 9;
  }

  return pages;
}

function line(n: number) {
  return {
    lineNumber: n,
    description: `Consultancy services phase ${n}`,
    hsCode: null,
    quantity: '2',
    uom: 'EA',
    unitPrice: '1000.00',
    discount: '0.00',
    vatCategory: 'STANDARD',
    vatRate: '5.00',
    net: '2000.00',
    vat: '100.00',
    total: '2100.00',
  };
}

const INVOICE: PrintableDocument = {
  invoiceNumber: 'INV-2026-004821',
  invoiceType: 'TAX_INVOICE',
  direction: 'OUTBOUND_SALES_AR',
  status: 'ACCEPTED_BY_FTA',
  issueDate: '2026-08-14',
  issueTime: '11:42:07',
  currencyCode: 'AED',
  exchangeRate: '1.000000',
  seller: {
    name: 'Al-Bahar Enterprises LLC',
    trn: '100293847500003',
    addressLines: ['Sheikh Zayed Road', 'Dubai 00000'],
  },
  buyer: {
    name: 'Gulf Tech Solutions FZE',
    trn: '100492817400003',
    addressLines: ['Corniche Road', 'Abu Dhabi'],
  },
  ftaIrn: 'AE-IRN-2026-000048219X',
  peppolUuid: '6f9619ff-8b86-d011-b42d-00c04fc964ff',
  poReference: 'PO-77120',
  grnReference: null,
  qrCodeData: null,
  ublXmlSha256: null,
  clearedAt: '2026-08-14T08:12:00.000Z',
  reference: null,
  dispute: null,
  lines: [line(1)],
  totals: {
    lineExtension: '2000.00',
    taxExclusive: '2000.00',
    vatTotal: '100.00',
    taxInclusive: '2100.00',
    payable: '2100.00',
    payableAed: '2100.00',
  },
  platformName: 'UAE E-Invoicing Portal',
};

describe('invoice pdf', () => {
  it('carries the statutory face of a tax invoice', async () => {
    const pages = textByPage(await renderInvoicePdf(INVOICE));
    expect(pages).toHaveLength(1);
    const page = pages[0]!;

    expect(page).toContain('TAX INVOICE');
    expect(page).toContain('INV-2026-004821');
    // Both parties, both TRNs — Article 59 wants all four.
    expect(page).toContain('Al-Bahar Enterprises LLC');
    expect(page).toContain('TRN 100293847500003');
    expect(page).toContain('Gulf Tech Solutions FZE');
    expect(page).toContain('TRN 100492817400003');
    expect(page).toContain('AE-IRN-2026-000048219X');
    expect(page).toContain('Total payable (AED)');
    expect(page).toContain('2,100.00');
  });

  it('titles a credit note as a credit note and names what it corrects', async () => {
    const pages = textByPage(
      await renderInvoicePdf({
        ...INVOICE,
        invoiceNumber: 'CRN-2026-000117',
        invoiceType: 'CREDIT_NOTE',
        reference: {
          invoiceNumber: 'INV-2026-004821',
          ftaIrn: 'AE-IRN-2026-000048219X',
          reversalMode: 'PARTIAL_ADJUSTMENT',
          reasonCode: 'QTY',
          notes: 'Two pallets returned.',
        },
      }),
    );

    expect(pages[0]).toContain('TAX CREDIT NOTE');
    expect(pages[0]).toContain('adjusts invoice INV-2026-004821');
    expect(pages[0]).toContain('Two pallets returned.');
  });

  it('states the AED equivalent and the rate on a foreign-currency invoice', async () => {
    const pages = textByPage(
      await renderInvoicePdf({
        ...INVOICE,
        currencyCode: 'USD',
        exchangeRate: '3.672500',
        totals: { ...INVOICE.totals, payable: '2100.00', payableAed: '7712.25' },
      }),
    );

    expect(pages[0]).toContain('Total payable (USD)');
    expect(pages[0]).toContain('AED 7,712.25 at 3.672500 USD/AED');
  });

  it('watermarks an unfiled document on every page', async () => {
    const pages = textByPage(
      await renderInvoicePdf({
        ...INVOICE,
        status: 'DRAFT',
        lines: Array.from({ length: 60 }, (_unused, index) => line(index + 1)),
      }),
    );

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page).toContain('DRAFT');
  });

  it('does not brand an inbound purchase invoice as unfiled', async () => {
    // It arrived cleared by the supplier's own filing. Stamping "not yet filed"
    // on it would be a false statement about someone else's compliance.
    const pages = textByPage(
      await renderInvoicePdf({ ...INVOICE, direction: 'INBOUND_PURCHASE_AP', status: 'INGESTED' }),
    );

    expect(pages[0]).not.toContain('NOT YET FILED');
    expect(pages[0]).toContain('Received and archived by');
  });

  it('numbers every page and does not leave a blank one behind', async () => {
    const pages = textByPage(
      await renderInvoicePdf({
        ...INVOICE,
        lines: Array.from({ length: 60 }, (_unused, index) => line(index + 1)),
      }),
    );

    pages.forEach((page, index) => {
      expect(page).toContain(`Page ${index + 1} of ${pages.length}`);
      // A page carrying nothing but its own two footer lines means a layout
      // helper left the cursor somewhere it should not have — the bug that
      // turned a one-page draft into two.
      expect(page.split('\n').length).toBeGreaterThan(4);
    });
  });
});

describe('report pdf', () => {
  const COLUMNS = ['Invoice number', 'Issue date', 'Supplier', 'Total (AED)'];
  const rows = (count: number) =>
    Array.from({ length: count }, (_unused, index) => [
      `SUP-INV-${index}`,
      '2026-07-14',
      'Nova Supplies FZE',
      '1260.53',
    ]);

  const input = (count: number, truncated = false) => ({
    key: 'ap-inbound-log' as const,
    name: 'Purchase inbound AP log',
    module: 'AP' as const,
    description: 'Every incoming supplier invoice.',
    columns: COLUMNS,
    rows: rows(count),
    dateFrom: '2026-01-01',
    dateTo: '2026-08-27',
    tenantName: 'Al-Bahar Enterprises LLC',
    platformName: 'UAE E-Invoicing Portal',
    truncated,
  });

  it('badges a report that belongs to one module, and not one that spans both', async () => {
    const ap = textByPage(await renderReportPdf(input(2))).join('\n');
    // 'AP' narrows the document: it says which desk this belongs to.
    expect(ap.split('\n')).toContain('AP');

    const both = textByPage(await renderReportPdf({ ...input(2), module: 'BOTH' as const })).join(
      '\n',
    );
    // 'BOTH' does not. A badge that is always true of the document it sits on
    // is furniture, and the reader already knows which report they asked for.
    expect(both.split('\n')).not.toContain('BOTH');
    // The report is still identified — it is the chip that went, not the name.
    expect(both).toContain('Purchase inbound AP log');
  });

  it('repeats the column headers and the report name on every page', async () => {
    const pages = textByPage(await renderReportPdf(input(300)));
    expect(pages.length).toBeGreaterThan(1);

    for (const page of pages) {
      expect(page).toContain('INVOICE NUMBER');
      expect(page).toContain('Purchase inbound AP log');
      // The period has to survive onto the loose page an auditor pulls out.
      expect(page).toContain('2026');
    }
  });

  it('says so when the query was capped rather than implying completeness', async () => {
    expect(textByPage(await renderReportPdf(input(3, true))).join('\n')).toContain(
      'capped at the query limit',
    );
    expect(textByPage(await renderReportPdf(input(3, false))).join('\n')).not.toContain(
      'capped at the query limit',
    );
  });

  it('prints an empty report as an empty report', async () => {
    const pages = textByPage(await renderReportPdf(input(0)));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('No rows matched this report');
  });
});

describe('column fitting', () => {
  it('keeps atomic columns intact and takes the width from the prose column', () => {
    const pdf = startPdf({ title: 't', landscape: true });
    const headers = ['Date', 'TRN', 'Supplier', 'Total'];
    const data = [
      [
        '2026-07-14',
        '100112233400003',
        'Emirates Industrial Fabrication and Coatings Limited Liability Company',
        '1260.53',
      ],
    ];

    const widths = autoColumnWidths(pdf.doc, headers, data, 400, 8, 6.5);

    pdf.doc.font('Helvetica').fontSize(8);
    // The three short columns must still hold their value on one line; only the
    // supplier name — the one that reads fine wrapped — gives up width.
    for (const index of [0, 1, 3]) {
      expect(widths[index]!).toBeGreaterThan(pdf.doc.widthOfString(data[0]![index]!) + 10);
    }
    expect(widths[2]!).toBeLessThan(pdf.doc.widthOfString(data[0]![2]!));
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(400, 0);
  });

  it('treats a column as numeric only when every value in it is', () => {
    expect(numericColumns([['1.00', '1.00'], ['2.00', 'n/a']], 2)).toEqual([true, false]);
    // Blanks do not disqualify a column; a column of only blanks is not numeric.
    expect(numericColumns([['1.00', ''], ['2.00', '']], 2)).toEqual([true, false]);
  });
});
