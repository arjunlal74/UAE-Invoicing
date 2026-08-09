import type { StagedRow } from '@uae/contracts';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ErrorSidebar } from '../components/staging/ErrorSidebar';
import { StagingGrid } from '../components/staging/StagingGrid';

/**
 * The staging grid is where a merchant sees and fixes their mistakes. If it
 * shows a cell as clean when it is not, an invalid invoice gets filed; if it
 * loses an edit, the user's correction silently disappears. Those two failures
 * are what these tests are for.
 */

function row(over: Partial<StagedRow> = {}): StagedRow {
  return {
    id: 'row-1',
    submittable: false,
    status: null,
    invoiceId: null,
    invoice: {
      id: 'inv-1',
      invoiceNumber: 'INV-2026-001',
      invoiceType: '380',
      issueDate: '2026-08-01',
      issueTime: '10:00:00',
      currency: 'AED',
      fxRate: '1.000000',
      supplierTrn: '100293847500003',
      supplierName: 'Al-Bahar Enterprises LLC',
      buyerTrn: '1002938475',
      buyerName: 'Emirates Trading Co',
      buyerEmirate: 'Dubai',
      poReference: '',
      precedingInvoiceId: '',
      paymentMeans: '30',
      lines: [
        {
          id: 'line-1',
          lineNumber: '1',
          description: 'Cloud Hosting',
          hsCode: '',
          quantity: '1',
          uom: 'MON',
          unitPrice: '5000',
          lineDiscount: '0',
          vatCategory: 'S',
          vatRate: '5.00',
          netAmount: '5000.00',
          vatAmount: '250.00',
          lineTotal: '5250.00',
          sourceRow: 2,
        },
      ],
      lineExtensionAmount: '5000.00',
      taxExclusiveAmount: '5000.00',
      vatTotalAmount: '250.00',
      taxInclusiveAmount: '5250.00',
      payableAmount: '5250.00',
      payableAmountAed: '5250.00',
      sourceRow: 4,
    },
    findings: [
      {
        ruleCode: 'BR-UAE-08',
        severity: 'ERROR',
        message: "Buyer TRN '1002938475' must be exactly 15 digits starting with 1.",
        field: 'buyerTrn',
        sheet: 'Invoice_Header',
        cell: 'I4',
      },
    ],
    ...over,
  };
}

const noop = () => {};

describe('staging grid', () => {
  it('marks a cell with a blocking finding and explains it on hover', () => {
    render(
      <StagingGrid
        rows={[row()]}
        editable
        saving={false}
        focusedCell={null}
        onEditInvoice={noop}
        onEditLine={noop}
      />,
    );

    const cell = document.querySelector('[data-cell="row-1:buyerTrn"]')!;
    expect(cell).toBeInTheDocument();
    expect(cell.className).toContain('cell-error');

    // The tooltip must carry the rule code and the coordinate in the user's own
    // spreadsheet, or they cannot find the same cell in their file.
    const tooltip = cell.getAttribute('title') ?? '';
    expect(tooltip).toContain('BR-UAE-08');
    expect(tooltip).toContain('Invoice_Header');
    expect(tooltip).toContain('I4');
  });

  it('does not mark a cell that has no finding', () => {
    render(
      <StagingGrid
        rows={[row()]}
        editable
        saving={false}
        focusedCell={null}
        onEditInvoice={noop}
        onEditLine={noop}
      />,
    );

    const clean = document.querySelector('[data-cell="row-1:buyerName"]')!;
    expect(clean.className).not.toContain('cell-error');
  });

  it('commits an inline edit on Enter and reports the new value', async () => {
    const onEditInvoice = vi.fn();
    const user = userEvent.setup();

    render(
      <StagingGrid
        rows={[row()]}
        editable
        saving={false}
        focusedCell={null}
        onEditInvoice={onEditInvoice}
        onEditLine={noop}
      />,
    );

    const cell = document.querySelector('[data-cell="row-1:buyerTrn"]') as HTMLElement;
    await user.dblClick(cell);

    const input = screen.getByDisplayValue('1002938475');
    await user.clear(input);
    await user.type(input, '100384759200003');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onEditInvoice).toHaveBeenCalledWith('row-1', 'buyerTrn', '100384759200003');
  });

  it('discards an edit on Escape', async () => {
    const onEditInvoice = vi.fn();
    const user = userEvent.setup();

    render(
      <StagingGrid
        rows={[row()]}
        editable
        saving={false}
        focusedCell={null}
        onEditInvoice={onEditInvoice}
        onEditLine={noop}
      />,
    );

    const cell = document.querySelector('[data-cell="row-1:buyerTrn"]') as HTMLElement;
    await user.dblClick(cell);

    const input = screen.getByDisplayValue('1002938475');
    await user.clear(input);
    await user.type(input, 'nonsense');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onEditInvoice).not.toHaveBeenCalled();
  });

  it('refuses to edit a row that has already been submitted', async () => {
    const onEditInvoice = vi.fn();
    const user = userEvent.setup();

    render(
      <StagingGrid
        rows={[row({ invoiceId: 'already-filed', submittable: true, findings: [] })]}
        editable
        saving={false}
        focusedCell={null}
        onEditInvoice={onEditInvoice}
        onEditLine={noop}
      />,
    );

    const cell = document.querySelector('[data-cell="row-1:buyerTrn"]') as HTMLElement;
    await user.dblClick(cell);

    expect(screen.queryByDisplayValue('1002938475')).not.toBeInTheDocument();
    expect(onEditInvoice).not.toHaveBeenCalled();
  });

  it('refuses to edit for a read-only role', async () => {
    const onEditInvoice = vi.fn();
    const user = userEvent.setup();

    render(
      <StagingGrid
        rows={[row()]}
        editable={false}
        saving={false}
        focusedCell={null}
        onEditInvoice={onEditInvoice}
        onEditLine={noop}
      />,
    );

    await user.dblClick(document.querySelector('[data-cell="row-1:buyerTrn"]') as HTMLElement);
    expect(onEditInvoice).not.toHaveBeenCalled();
  });

  it('reveals line items when a row is expanded', async () => {
    const user = userEvent.setup();

    render(
      <StagingGrid
        rows={[row()]}
        editable
        saving={false}
        focusedCell={null}
        onEditInvoice={noop}
        onEditLine={noop}
      />,
    );

    expect(screen.queryByText('Cloud Hosting')).not.toBeInTheDocument();
    await user.click(screen.getByTitle('Expand line items'));
    expect(screen.getByText('Cloud Hosting')).toBeInTheDocument();
  });
});

describe('error sidebar', () => {
  const findings = [{ row: row(), finding: row().findings[0]! }];

  it('lists each finding with its rule code and spreadsheet coordinate', () => {
    render(<ErrorSidebar findings={findings} onFocus={noop} focusedCell={null} />);

    expect(screen.getByText('1 error to fix')).toBeInTheDocument();
    expect(screen.getByText('BR-UAE-08')).toBeInTheDocument();
    expect(screen.getByText(/Invoice_Header · cell I4/)).toBeInTheDocument();
  });

  it('asks the grid to focus the offending cell when clicked', async () => {
    const onFocus = vi.fn();
    const user = userEvent.setup();

    render(<ErrorSidebar findings={findings} onFocus={onFocus} focusedCell={null} />);
    await user.click(screen.getByText(/must be exactly 15 digits/));

    expect(onFocus).toHaveBeenCalledWith('row-1', 'buyerTrn');
  });

  it('separates warnings from blocking errors', () => {
    const withWarning = [
      ...findings,
      {
        row: row({ id: 'row-2' }),
        finding: {
          ruleCode: 'WRN-UAE-02',
          severity: 'WARNING' as const,
          message: 'No buyer TRN supplied — this will be filed as a simplified B2C invoice.',
          field: 'buyerTrn',
          sheet: 'Invoice_Header',
          cell: 'I5',
        },
      },
    ];

    render(<ErrorSidebar findings={withWarning} onFocus={noop} focusedCell={null} />);

    // One error, one warning — the heading counts only what blocks submission.
    expect(screen.getByText('1 error to fix')).toBeInTheDocument();
    expect(screen.getByText(/Show 1 warning/)).toBeInTheDocument();
  });

  it('says so plainly when there is nothing to fix', () => {
    render(<ErrorSidebar findings={[]} onFocus={noop} focusedCell={null} />);
    expect(screen.getByText('No blocking errors')).toBeInTheDocument();
    expect(
      within(screen.getByRole('complementary')).getByText(/You can submit this batch/),
    ).toBeInTheDocument();
  });
});
