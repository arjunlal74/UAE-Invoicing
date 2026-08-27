import { describe, expect, it } from 'vitest';

/**
 * The §15 inventory arithmetic, isolated from the database.
 *
 * The formulas in SRS v2.8 §15.1–15.4 look interchangeable written out in
 * prose, and they are not. Three of them subtract different things from the
 * same total, and picking the wrong one gives a number that is plausible,
 * stable, and wrong — which is the worst way for an inventory to fail. These
 * pin down which is which.
 */

// The four figures §15 defines, expressed once so a test and the SQL cannot
// drift into different opinions about what "available" means.
const currentStock = (opening: number, purchased: number, soldOrAllocated: number) =>
  opening + purchased - soldOrAllocated;

const netAvailable = (opening: number, purchased: number, consumed: number) =>
  opening + purchased - consumed;

const partnerUnallocated = (opening: number, masterPurchases: number, slicesAllocated: number) =>
  opening + masterPurchases - slicesAllocated;

const partnerNetAvailable = (masterPurchases: number, subTenantConsumption: number) =>
  masterPurchases - subTenantConsumption;

describe('§15.1 host main account', () => {
  it('separates what is left to sell from what is left to file', () => {
    // A host that bought a million units, sold 900,000 of them, and whose
    // customers have filed 100,000 invoices.
    const opening = 0;
    const purchased = 1_000_000;
    const sold = 900_000;
    const consumed = 100_000;

    // Only 100,000 remain unsold...
    expect(currentStock(opening, purchased, sold)).toBe(100_000);
    // ...but 900,000 are still available to be filed against, because a sale is
    // not a consumption. Conflating the two would have the platform believe it
    // was nearly out when 90% of its capacity is unused.
    expect(netAvailable(opening, purchased, consumed)).toBe(900_000);
  });

  it('can be out of stock while still having plenty of capacity', () => {
    // The state a growing platform is in most of the time: everything bought
    // has been sold, and almost none of it has been used yet. Stock zero is a
    // procurement signal; it is not an outage.
    expect(currentStock(0, 500_000, 500_000)).toBe(0);
    expect(netAvailable(0, 500_000, 1_200)).toBe(498_800);
  });

  it('can have capacity left to sell while being nearly exhausted', () => {
    // And the inverse, which is the dangerous one: 50,000 units still on the
    // shelf, but the platform as a whole is 5,000 from a standstill.
    expect(currentStock(0, 1_000_000, 950_000)).toBe(50_000);
    expect(netAvailable(0, 1_000_000, 995_000)).toBe(5_000);
  });

  it('carries an opening balance forward', () => {
    expect(currentStock(25_000, 100_000, 40_000)).toBe(85_000);
    expect(netAvailable(25_000, 100_000, 40_000)).toBe(85_000);
  });
});

describe('§15.4 channel partner two-level custody', () => {
  it('distinguishes unallocated pool from unconsumed capacity', () => {
    // A partner with a 200,000 master pool, all of it sliced out to clients,
    // who have between them filed 30,000 invoices.
    const masterPurchases = 200_000;
    const allocated = 200_000;
    const consumed = 30_000;

    // Nothing left to give a new sub-tenant...
    expect(partnerUnallocated(0, masterPurchases, allocated)).toBe(0);
    // ...but 170,000 units of filing still paid for. These are the two
    // questions a partner asks, and they have different answers.
    expect(partnerNetAvailable(masterPurchases, consumed)).toBe(170_000);
  });

  it('leaves room for another sub-tenant when slices are under-allocated', () => {
    expect(partnerUnallocated(0, 200_000, 140_000)).toBe(60_000);
  });
});

describe('§15.4 atomic dual deduction', () => {
  it('takes one unit from the slice and one from the master pool', () => {
    // The same physical invoice seen from two ledgers. The partner's pool is
    // not charged twice, and the sub-tenant's slice is not charged for its
    // siblings — but both move on every filing.
    let slice = 10_000;
    let master = 200_000;

    for (let filed = 0; filed < 250; filed += 1) {
      slice -= 1;
      master -= 1;
    }

    expect(slice).toBe(9_750);
    expect(master).toBe(199_750);
  });

  it('does not double-count a mirrored row in platform consumption', () => {
    // The usage ledger holds both rows; the platform figure must count the
    // tenant's own and ignore the mirror, or every partner-managed invoice
    // would take two units off the host's net balance.
    const ledger = [
      { units: 1, isParentMirror: false },
      { units: 1, isParentMirror: true },
      { units: 1, isParentMirror: false },
      { units: 1, isParentMirror: true },
    ];

    const platformConsumed = ledger
      .filter((row) => !row.isParentMirror)
      .reduce((sum, row) => sum + row.units, 0);

    expect(platformConsumed).toBe(2);
    expect(ledger.reduce((sum, row) => sum + row.units, 0)).toBe(4);
  });
});

describe('§15.5 buffer breach and severity', () => {
  const severityOf = (remaining: number, threshold: number): 'WARNING' | 'CRITICAL' => {
    if (remaining <= 0) return 'CRITICAL';
    return remaining * 2 <= threshold ? 'CRITICAL' : 'WARNING';
  };

  const breached = (remaining: number, threshold: number) =>
    threshold > 0 && remaining < threshold;

  it('treats a zero threshold as the alert being switched off', () => {
    // Otherwise every account that never configured one would be permanently
    // "below" a floor of zero the moment it went negative on overage.
    expect(breached(0, 0)).toBe(false);
    expect(breached(-5, 0)).toBe(false);
  });

  it('fires below the floor and not at it', () => {
    expect(breached(1_001, 1_000)).toBe(false);
    expect(breached(1_000, 1_000)).toBe(false);
    expect(breached(999, 1_000)).toBe(true);
  });

  it('escalates once past half the floor', () => {
    // An account at 40% of its floor and one at 4% both breach, but only one
    // of them is about to stop filing.
    expect(severityOf(900, 1_000)).toBe('WARNING');
    expect(severityOf(501, 1_000)).toBe('WARNING');
    expect(severityOf(500, 1_000)).toBe('CRITICAL');
    expect(severityOf(40, 1_000)).toBe('CRITICAL');
    expect(severityOf(0, 1_000)).toBe('CRITICAL');
  });

  it('projects days remaining only when there is a rate to project from', () => {
    const daysRemaining = (available: number, runRate: number) =>
      runRate > 0 ? Math.floor(available / runRate) : null;

    expect(daysRemaining(5_000, 250)).toBe(20);
    expect(daysRemaining(5_000, 300)).toBe(16);
    // A dormant account has no run rate. "Unknown" is the honest answer, and a
    // dashboard must not print an infinity.
    expect(daysRemaining(5_000, 0)).toBeNull();
  });
});

describe('§15.1 stock guard', () => {
  const covers = (stock: number, requested: number) => requested <= stock;

  it('refuses to sell units the platform never bought', () => {
    // The bug this whole section exists to prevent: before v2.8 the host could
    // issue a bundle for any number at all, and the shortfall surfaced as a
    // provider refusing to clear somebody's tax document.
    expect(covers(100_000, 100_001)).toBe(false);
    expect(covers(0, 1)).toBe(false);
  });

  it('allows a sale that exactly empties the shelf', () => {
    expect(covers(100_000, 100_000)).toBe(true);
  });
});
