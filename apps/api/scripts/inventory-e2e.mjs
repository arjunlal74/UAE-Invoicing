/**
 * End-to-end smoke test for the multi-tier data bundle inventory lifecycle
 * (SRS v2.8 §15).
 *
 * Drives the whole supply chain over real HTTP: register a wholesale purchase,
 * sell downstream to a direct tenant and a channel partner, watch the host's
 * stock and net balance move differently, prove the platform refuses to sell
 * what it never bought, and set the §15.5 floors.
 *
 * Every run uses a fresh contract reference, so it is safe against the same
 * seeded stack repeatedly.
 *
 * Usage: node scripts/inventory-e2e.mjs   (BASE=http://localhost:8080)
 */
const BASE = process.env.BASE ?? 'http://localhost:8080';

let pass = 0;
let fail = 0;

const check = (label, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
};

const section = (title) => console.log(`\n=== ${title}`);

async function call(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { status: response.status, body: payload };
}

const login = async (email) =>
  (await call('/api/v1/auth/login', { method: 'POST', body: { email, password: '123' } })).body
    ?.accessToken;

const stamp = Date.now().toString(36).toUpperCase();

const admin = await login('admin@platform.local');
if (!admin) {
  console.error('could not sign in as admin@platform.local');
  process.exit(1);
}

const tenants = await call('/api/v1/admin/tenants?pageSize=50', { token: admin });
const items = tenants.body?.items ?? [];
const partner = items.find((t) => t.tenantType === 'CHANNEL_PARTNER');

// Sell to the tenant whose administrator we can actually sign in as, rather
// than to whichever active tenant happens to sort first — earlier e2e runs
// onboard tenants of their own, so "the first one" drifts between runs and the
// §15.3 assertions below would then be checking somebody else's bundle.
const tenantAdmin = await login('admin@albahar.local');
const profile = await call('/api/v1/auth/me', { token: tenantAdmin });
const directId = profile.body?.tenantId ?? profile.body?.user?.tenantId;
const direct = items.find((t) => t.id === directId);

if (!direct) {
  console.error('could not resolve the tenant behind admin@albahar.local');
  process.exit(1);
}

// --- 1. the shelf starts where procurement leaves it -------------------------
section('1. Nothing can be sold that was never bought');

const before = await call('/api/v1/admin/inventory', { token: admin });
check('the console is readable', before.status === 200, before.body);

const host0 = before.body?.host;
check('it reports a stock figure', typeof host0?.currentStockUnits === 'number', host0);
check('and a net available figure', typeof host0?.netAvailableUnits === 'number', host0);

const overreach = await call('/api/v1/billing/bundles', {
  method: 'POST',
  token: admin,
  body: {
    tenantId: direct.id,
    reference: `OVERREACH-${stamp}`,
    purchasedUnits: (host0?.currentStockUnits ?? 0) + 1_000_000,
    allowOverage: false,
  },
});
check('selling more than the shelf holds is refused', overreach.status === 400, overreach.body);
check(
  'and the refusal names both figures',
  /unsold units/.test(overreach.body?.error?.message ?? ''),
  overreach.body?.error?.message,
);

// --- 1b. the provider master --------------------------------------------------
section('1b. Purchases are registered against a provider, not a typed name');

const created = await call('/api/v1/admin/providers', {
  method: 'POST',
  token: admin,
  body: {
    name: `E2E Provider ${stamp}`,
    accreditationReference: `MOF-${stamp}`,
    contactEmail: 'wholesale@example.ae',
    defaultCostPerUnitAed: 0.085,
  },
});
check('a provider is added', created.status === 201, created.body);
const providerId = created.body?.id;
check('with nothing bought from it yet', created.body?.contractCount === 0, created.body);

const clash = await call('/api/v1/admin/providers', {
  method: 'POST',
  token: admin,
  body: { name: `e2e provider ${stamp}`.toUpperCase() },
});
check('the same name in another case is refused', clash.status === 400, clash.body);

const unknownProvider = await call('/api/v1/admin/procurements', {
  method: 'POST',
  token: admin,
  body: {
    aspProviderId: '00000000-0000-0000-0000-000000000000',
    contractReference: `GHOST-${stamp}`,
    totalUnits: 1000,
    totalCostAed: 85,
  },
});
check('a contract cannot name a provider that does not exist', unknownProvider.status === 404, unknownProvider.status);

// --- 2. wholesale procurement ------------------------------------------------
section('2. §15.1 wholesale procurement');

const PURCHASE_UNITS = 250_000;
const PURCHASE_TOTAL = 21_250;
const procurement = await call('/api/v1/admin/procurements', {
  method: 'POST',
  token: admin,
  body: {
    aspProviderId: providerId,
    contractReference: `ASP-${stamp}`,
    totalUnits: PURCHASE_UNITS,
    totalCostAed: PURCHASE_TOTAL,
  },
});
check('a purchase is registered', procurement.status === 201, procurement.body);
check('it carries the provider name from the master', procurement.body?.aspProviderName === `E2E Provider ${stamp}`, procurement.body);
check(
  'the total is stored exactly as invoiced',
  procurement.body?.totalCostAed === PURCHASE_TOTAL.toFixed(2),
  procurement.body?.totalCostAed,
);
check(
  'and the per-unit rate is derived from it',
  procurement.body?.costPerUnitAed === (PURCHASE_TOTAL / PURCHASE_UNITS).toFixed(4),
  procurement.body?.costPerUnitAed,
);
check('nothing is allocated from it yet', procurement.body?.allocatedUnits === 0, procurement.body);

// The total is authoritative, so an odd unit count keeps every fils rather than
// losing some to a four-decimal rate multiplied back out.
const odd = await call('/api/v1/admin/procurements', {
  method: 'POST',
  token: admin,
  body: {
    aspProviderId: providerId,
    contractReference: `ODD-${stamp}`,
    totalUnits: 999_999,
    totalCostAed: 85_000,
  },
});
check('an odd unit count keeps the exact total', odd.body?.totalCostAed === '85000.00', odd.body?.totalCostAed);

const disagreeing = await call('/api/v1/admin/procurements', {
  method: 'POST',
  token: admin,
  body: {
    aspProviderId: providerId,
    contractReference: `MISMATCH-${stamp}`,
    totalUnits: 100_000,
    totalCostAed: 8_500,
    costPerUnitAed: 0.5,
  },
});
check('a stated rate that contradicts the total is refused', disagreeing.status === 400, disagreeing.body);

const duplicate = await call('/api/v1/admin/procurements', {
  method: 'POST',
  token: admin,
  body: {
    aspProviderId: providerId,
    contractReference: `ASP-${stamp}`,
    totalUnits: 1000,
    totalCostAed: 100,
  },
});
check('a contract reference cannot be registered twice', duplicate.status === 400, duplicate.status);

const afterBuy = await call('/api/v1/admin/inventory', { token: admin });
const host1 = afterBuy.body?.host;
const BOUGHT = PURCHASE_UNITS + 999_999;
check(
  'the shelf grows by exactly what was bought',
  host1.currentStockUnits === host0.currentStockUnits + BOUGHT,
  { before: host0.currentStockUnits, after: host1.currentStockUnits },
);
check(
  'and so does the net balance',
  host1.netAvailableUnits === host0.netAvailableUnits + BOUGHT,
  { before: host0.netAvailableUnits, after: host1.netAvailableUnits },
);

// --- 3. selling downstream ---------------------------------------------------
section('3. §15.2 a sale moves stock but not the net balance');

const SALE_UNITS = 20_000;
const sale = await call('/api/v1/billing/bundles', {
  method: 'POST',
  token: admin,
  body: {
    tenantId: direct.id,
    reference: `SALE-${stamp}`,
    purchasedUnits: SALE_UNITS,
    allowOverage: false,
    aspProcurementId: procurement.body?.id,
    minimumBufferUnits: 5_000,
  },
});
check('a bundle is sold to a direct tenant', sale.status === 201, sale.body);

const afterSale = await call('/api/v1/admin/inventory', { token: admin });
const host2 = afterSale.body?.host;

check(
  'the shelf falls by the units sold',
  host2.currentStockUnits === host1.currentStockUnits - SALE_UNITS,
  { before: host1.currentStockUnits, after: host2.currentStockUnits },
);
// The distinction §15.1 draws, and the one most likely to be got wrong: a sale
// is not a consumption. The units are still there to be filed against.
check(
  'but the net balance does not move — a sale is not a consumption',
  host2.netAvailableUnits === host1.netAvailableUnits,
  { before: host1.netAvailableUnits, after: host2.netAvailableUnits },
);

const linked = (afterSale.body?.procurements ?? []).find((p) => p.id === procurement.body?.id);
check('the contract shows what has been drawn from it', linked?.allocatedUnits === SALE_UNITS, linked);
check(
  'and what it has left',
  linked?.remainingUnits === PURCHASE_UNITS - SALE_UNITS,
  linked,
);

const tier = (afterSale.body?.tiers ?? []).find((t) => t.bundleId === sale.body?.id);
check('the buyer appears in the tier table', Boolean(tier), tier);
check('with the floor it was sold with', tier?.minimumBufferUnits === 5_000, tier);
check('and is not below it', tier?.belowBuffer === false, tier);

// --- 4. §15.4 partner master pools ------------------------------------------
if (partner) {
  section('4. §15.4 a partner master pool');

  const master = await call('/api/v1/billing/bundles', {
    method: 'POST',
    token: admin,
    body: {
      tenantId: partner.id,
      reference: `MASTER-${stamp}`,
      purchasedUnits: 40_000,
      allowOverage: false,
      aspProcurementId: procurement.body?.id,
    },
  });
  check('a master pool is allocated to the partner', master.status === 201, master.body);

  const afterMaster = await call('/api/v1/admin/inventory', { token: admin });
  check(
    'which also comes off the host shelf',
    afterMaster.body?.host?.currentStockUnits === host2.currentStockUnits - 40_000,
    afterMaster.body?.host,
  );

  const partnerToken = await login('partner@gulfadvisory.local');
  if (partnerToken) {
    const subs = await call('/api/v1/partner/sub-tenants', { token: partnerToken });
    const sub = (subs.body?.items ?? [])[0];

    if (sub) {
      const oversize = await call('/api/v1/billing/bundles', {
        method: 'POST',
        token: partnerToken,
        body: {
          tenantId: sub.id,
          parentBundleId: master.body?.id,
          reference: `SLICE-BIG-${stamp}`,
          purchasedUnits: 999_999,
          allowOverage: false,
        },
      });
      check('a partner cannot slice more than its pool holds', oversize.status === 400, oversize.body);

      const slice = await call('/api/v1/billing/bundles', {
        method: 'POST',
        token: partnerToken,
        body: {
          tenantId: sub.id,
          parentBundleId: master.body?.id,
          reference: `SLICE-${stamp}`,
          purchasedUnits: 5_000,
          allowOverage: false,
          minimumBufferUnits: 500,
        },
      });
      check('but may slice within it', slice.status === 201, slice.body);

      const afterSlice = await call('/api/v1/admin/inventory', { token: admin });
      // The unit left the host when the partner bought the master pool. Taking
      // it off again here would make one sale cost the host twice.
      check(
        'a slice does not come off the host shelf a second time',
        afterSlice.body?.host?.currentStockUnits ===
          afterMaster.body?.host?.currentStockUnits,
        {
          before: afterMaster.body?.host?.currentStockUnits,
          after: afterSlice.body?.host?.currentStockUnits,
        },
      );

      const masterRow = (afterSlice.body?.tiers ?? []).find((t) => t.bundleId === master.body?.id);
      check('the master pool shows what it has carved out', masterRow?.allocatedUnits === 5_000, masterRow);
    }
  }
}

// --- 5. §15.5 the floors -----------------------------------------------------
section('5. §15.5 minimum buffers');

const hostBuffer = await call('/api/v1/admin/inventory/buffer', {
  method: 'PATCH',
  token: admin,
  body: { minimumBufferUnits: 100 },
});
check('the host floor can be set', hostBuffer.status === 200, hostBuffer.body);
check('a comfortable balance is not flagged', hostBuffer.body?.belowBuffer === false, hostBuffer.body);

const impossible = await call('/api/v1/admin/inventory/buffer', {
  method: 'PATCH',
  token: admin,
  body: { minimumBufferUnits: 99_000_000 },
});
check('raising the floor above the balance flags it', impossible.body?.belowBuffer === true, impossible.body);

// Put it back so the sweep does not spam the seeded admin on every run.
await call('/api/v1/admin/inventory/buffer', {
  method: 'PATCH',
  token: admin,
  body: { minimumBufferUnits: 0 },
});

if (tenantAdmin) {
  const own = await call(`/api/v1/billing/bundles/${sale.body?.id}/buffer`, {
    method: 'PATCH',
    token: tenantAdmin,
    body: { minimumBufferUnits: 2_500 },
  });
  check('a tenant sets the floor on its own bundle', own.status === 200, own.body);

  const balance = await call('/api/v1/billing/balance', { token: tenantAdmin });
  const mine = (balance.body?.bundles ?? []).find((b) => b.id === sale.body?.id);
  check('and sees it on the balance screen', mine?.minimumBufferUnits === 2_500, mine);
}

const clerk = await login('clerk@albahar.local');
if (clerk) {
  const refused = await call(`/api/v1/billing/bundles/${sale.body?.id}/buffer`, {
    method: 'PATCH',
    token: clerk,
    body: { minimumBufferUnits: 1 },
  });
  check('an accountant cannot change it', refused.status === 403, refused.status);
}

// --- 6. isolation ------------------------------------------------------------
section('6. Procurement is the host\'s own commercial position');

if (tenantAdmin) {
  const peek = await call('/api/v1/admin/inventory', { token: tenantAdmin });
  check('a tenant cannot read the inventory console', peek.status === 403, peek.status);

  const peekBuy = await call('/api/v1/admin/procurements', {
    method: 'POST',
    token: tenantAdmin,
    body: {
      aspProviderId: providerId,
      contractReference: `SNEAK-${stamp}`,
      totalUnits: 1,
      totalCostAed: 1,
    },
  });
  check('nor register a purchase', peekBuy.status === 403, peekBuy.status);

  const peekProviders = await call('/api/v1/admin/providers', { token: tenantAdmin });
  check('nor read the provider list', peekProviders.status === 403, peekProviders.status);
}

// --- 7. retirement -----------------------------------------------------------
section('6b. §15.4 the unallocated pool a partner allocates from');

if (partner) {
  const partnerToken2 = await login('partner@gulfadvisory.local');
  if (partnerToken2) {
    const bal = await call('/api/v1/billing/balance', { token: partnerToken2 });
    const masterPools = (bal.body?.bundles ?? []).filter((b) => !b.parentBundleId);
    check('a partner sees its master pools', masterPools.length > 0, masterPools.length);

    const pool = masterPools[0];
    check(
      'each reports what it has carved out',
      typeof pool?.allocatedUnits === 'number',
      pool,
    );
    // The two figures §15.4 keeps apart: room to onboard another client, versus
    // capacity left to file. A pool can be fully allocated and barely used.
    check(
      'and what is left to allocate, distinct from what is left to file',
      pool.unallocatedUnits === pool.purchasedUnits - pool.allocatedUnits &&
        pool.remainingUnits === pool.purchasedUnits - pool.consumedUnits,
      {
        purchased: pool.purchasedUnits,
        allocated: pool.allocatedUnits,
        unallocated: pool.unallocatedUnits,
        remaining: pool.remainingUnits,
      },
    );
  }
}

// --- 6c. period-scoped reporting ---------------------------------------------
section('6c. The provider roll-up is scoped to a period');

const beforeOld = await call('/api/v1/admin/inventory', { token: admin });

// Dated years back, so it is unambiguously outside any recent window while
// remaining part of the provider's history.
const OLD_UNITS = 40_000;
const OLD_SPEND = 3_400;
const oldBuy = await call('/api/v1/admin/procurements', {
  method: 'POST',
  token: admin,
  body: {
    aspProviderId: providerId,
    contractReference: `OLD-${stamp}`,
    totalUnits: OLD_UNITS,
    totalCostAed: OLD_SPEND,
    purchaseDate: '2021-03-01',
  },
});
check('a historical contract is registered', oldBuy.status === 201, oldBuy.body);

const recentProviders = await call('/api/v1/admin/providers?includeInactive=true', {
  token: admin,
});
check(
  'the default window is the last twelve months',
  recentProviders.body?.period?.label === 'Last 12 months',
  recentProviders.body?.period,
);
const recentRow = (recentProviders.body?.items ?? []).find((p) => p.id === providerId);
check('an old contract falls outside it', recentRow?.contractCount === 2, recentRow);
check(
  'so does the money spent on it',
  recentRow?.totalSpendAed === '106250.00',
  recentRow?.totalSpendAed,
);
// The distinction that makes a retirement decision safe: nothing bought this
// year is not the same fact as nothing ever bought.
check(
  'but the lifetime contract count still sees it',
  recentRow?.lifetimeContractCount === 3,
  recentRow,
);

const allProviders = await call('/api/v1/admin/providers?includeInactive=true&period=all', {
  token: admin,
});
check('all time is available', allProviders.body?.period?.label === 'All time', allProviders.body?.period);
const allRow = (allProviders.body?.items ?? []).find((p) => p.id === providerId);
check('and takes in the whole history', allRow?.contractCount === 3, allRow);
check(
  'including its spend',
  allRow?.totalSpendAed === (106_250 + OLD_SPEND).toFixed(2),
  allRow?.totalSpendAed,
);

const explicit = await call('/api/v1/admin/providers?from=2021-01-01&to=2021-12-31', {
  token: admin,
});
const explicitRow = (explicit.body?.items ?? []).find((p) => p.id === providerId);
check('an explicit range is honoured', explicitRow?.contractCount === 1, explicitRow);
check(
  'and reports only what was spent inside it',
  explicitRow?.totalSpendAed === OLD_SPEND.toFixed(2),
  explicitRow?.totalSpendAed,
);

// The console is the other half of the decision: its figures are balances and a
// contract list, so a purchase dated 2021 belongs in both regardless of window.
const afterOld = await call('/api/v1/admin/inventory', { token: admin });
check(
  'the shelf counts the old contract like any other',
  afterOld.body?.host?.currentStockUnits ===
    beforeOld.body?.host?.currentStockUnits + OLD_UNITS,
  {
    before: beforeOld.body?.host?.currentStockUnits,
    after: afterOld.body?.host?.currentStockUnits,
  },
);
check(
  'and the console lists it without asking for a period',
  (afterOld.body?.procurements ?? []).some((c) => c.contractReference === `OLD-${stamp}`),
  afterOld.body?.procurements?.length,
);

// A mistyped bound that quietly widened to all time would be a spend report
// that reads as a quarter and is not one, so each is refused out loud.
const badPeriod = await call('/api/v1/admin/providers?period=forever', { token: admin });
check('a nonsense period is refused', badPeriod.status === 400, badPeriod.body);
const badDate = await call('/api/v1/admin/providers?from=01-03-2021', { token: admin });
check('so is a date in the wrong shape', badDate.status === 400, badDate.body);
const backwards = await call('/api/v1/admin/providers?from=2026-06-01&to=2026-01-01', {
  token: admin,
});
check('so is a range that ends before it starts', backwards.status === 400, backwards.body);

section('7. A provider is retired, never deleted');

const retired = await call(`/api/v1/admin/providers/${providerId}`, {
  method: 'PATCH',
  token: admin,
  body: { isActive: false },
});
check('a provider can be retired', retired.status === 200 && retired.body?.isActive === false, retired.body);
check(
  'and keeps its purchase history',
  retired.body?.lifetimeContractCount === 3,
  retired.body?.lifetimeContractCount,
);
check(
  'including what was spent with it',
  Number(retired.body?.totalSpendAed) > 0,
  retired.body?.totalSpendAed,
);

const afterRetire = await call('/api/v1/admin/procurements', {
  method: 'POST',
  token: admin,
  body: {
    aspProviderId: providerId,
    contractReference: `RETIRED-${stamp}`,
    totalUnits: 100,
    totalCostAed: 10,
  },
});
check('a retired provider cannot take new contracts', afterRetire.status === 400, afterRetire.body);

const activeOnly = await call('/api/v1/admin/providers', { token: admin });
check(
  'and drops out of the picker',
  !(activeOnly.body?.items ?? []).some((p) => p.id === providerId),
  activeOnly.body?.items?.length,
);

const withRetired = await call('/api/v1/admin/providers?includeInactive=true', { token: admin });
check(
  'but is still listed, for reactivation',
  (withRetired.body?.items ?? []).some((p) => p.id === providerId),
  withRetired.body?.items?.length,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
