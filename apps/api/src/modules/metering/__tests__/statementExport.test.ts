import type { InventoryStatement } from '@uae/contracts';
import { describe, expect, it } from 'vitest';
import { parseMovementWindow } from '../period.js';
import { flattenStatement, statementPeriodLabel } from '../statementExport.js';

/**
 * The exported statement has to say the same thing the screen does.
 *
 * Two columns change name with the holder — the platform sells what a partner
 * allocates and a tenant consumes — and a printout whose headings disagreed
 * with the page it was printed from would be worse than no printout, because
 * the reader has no way to tell which one is lying.
 */

function statement(over: Partial<InventoryStatement> = {}): InventoryStatement {
  return {
    holderKind: 'PLATFORM',
    holderName: 'UAE E-Invoicing Portal',
    period: { from: '2026-01-01', to: '2026-03-31', label: 'Q1' },
    openingUnits: 0,
    totalInUnits: 100_000,
    totalOutUnits: 55_000,
    closingUnits: 45_000,
    omittedRows: 0,
    rows: [
      {
        date: '2026-08-30',
        reference: 'MARMIN-2026-001',
        description: 'Marmin AI Software Design LLC',
        openingUnits: 0,
        inUnits: 100_000,
        outUnits: 0,
        balanceUnits: 100_000,
      },
    ],
    ...over,
  };
}

describe('statement flattening', () => {
  it('names the movement columns for the holder', () => {
    expect(flattenStatement(statement({ holderKind: 'PLATFORM' })).columns).toEqual([
      'Date', 'Reference', 'Description', 'Opening', 'Buy', 'Sell', 'Balance',
    ]);

    // A partner allocates rather than sells, and a tenant consumes rather than
    // allocating. Same statement, different verbs.
    expect(flattenStatement(statement({ holderKind: 'CHANNEL_PARTNER' })).columns[5]).toBe(
      'Allocated',
    );
    expect(flattenStatement(statement({ holderKind: 'ENTERPRISE_TENANT' })).columns[5]).toBe(
      'Consumed',
    );
    expect(flattenStatement(statement({ holderKind: 'MANAGED_SUB_TENANT' })).columns[4]).toBe(
      'Allocated',
    );
  });

  it('keeps the figures as numbers, so the workbook can sum them', () => {
    const { rows } = flattenStatement(statement());
    const first = rows[0]!;

    expect(typeof first[3]).toBe('number');
    expect(typeof first[6]).toBe('number');
    // The reference must not be coerced: it is an identifier, not a quantity.
    expect(typeof first[1]).toBe('string');
  });

  it('foots the table with the period total', () => {
    const { rows } = flattenStatement(statement());
    const total = rows.at(-1)!;

    expect(total[0]).toBe('Period total');
    expect(total[3]).toBe(0);
    expect(total[4]).toBe(100_000);
    expect(total[5]).toBe(55_000);
    expect(total[6]).toBe(45_000);
  });

  it('admits when earlier movements were folded into the opening', () => {
    // The balances stay true, but the reader has to know the lines are not all
    // there — otherwise the opening looks like it came from nowhere.
    expect(flattenStatement(statement({ omittedRows: 12 })).notes[0]).toMatch(/12/);
    expect(flattenStatement(statement({ omittedRows: 0 })).notes).toEqual([]);
  });

  it('states an open-ended period honestly rather than inventing an end', () => {
    expect(statementPeriodLabel(statement())).toBe('From 2026-01-01 to 2026-03-31');

    const openEnded = statement({ period: { from: '2026-01-01', to: null, label: 'x' } });
    expect(statementPeriodLabel(openEnded)).toBe('From 2026-01-01');

    const allTime = statement({ period: { from: null, to: null, label: 'All time' } });
    expect(statementPeriodLabel(allTime)).toBe('All time');
  });
});

describe('movement window', () => {
  it('defaults to the last thirty days with both ends filled in', () => {
    const { from, to } = parseMovementWindow({});

    // A balance statement with an open end has no closing figure, so both ends
    // are resolved here rather than left for the query to interpret.
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    expect(days).toBe(30);
  });

  it('takes an explicit range', () => {
    expect(parseMovementWindow({ from: '2026-02-01', to: '2026-02-28' })).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  it('refuses a range that ends before it starts', () => {
    // Silently widening a mistyped range gives a report that reads as one
    // period and is another.
    expect(() => parseMovementWindow({ from: '2026-03-01', to: '2026-01-01' })).toThrow();
  });

  it('refuses a date that is not one', () => {
    expect(() => parseMovementWindow({ from: 'last tuesday' })).toThrow();
    expect(() => parseMovementWindow({ to: '31-03-2026' })).toThrow();
  });
});
