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

// --- 2. wholesale procurement ------------------------------------------------
section('2. §15.1 wholesale procurement');

const PURCHASE_UNITS = 250_000;
const procurement = await call('/api/v1/admin/procurements', {
  method: 'POST',
  token: admin,
  body: {
    aspProviderName: 'Accredited ASP UAE',
    contractReference: `ASP-${stamp}`,
    totalUnits: PURCHASE_UNITS,
    costPerUnitAed: 0.085,
  },
});
check('a purchase is registered', procurement.status === 201, procurement.body);
check(
  'the total cost is computed, not accepted',
  procurement.body?.totalCostAed === (PURCHASE_UNITS * 0.085).toFixed(2),
  procurement.body?.totalCostAed,
);
check('nothing is allocated from it yet', procurement.body?.allocatedUnits === 0, procurement.body);

const duplicate = await call('/api/v1/admin/procurements', {
  method: 'POST',
  token: admin,
  body: {
    aspProviderName: 'Accredited ASP UAE',
    contractReference: `ASP-${stamp}`,
    totalUnits: 1000,
    costPerUnitAed: 0.1,
  },
});
check('a contract reference cannot be registered twice', duplicate.status === 400, duplicate.status);

const afterBuy = await call('/api/v1/admin/inventory', { token: admin });
const host1 = afterBuy.body?.host;
check(
  'the shelf grows by exactly what was bought',
  host1.currentStockUnits === host0.currentStockUnits + PURCHASE_UNITS,
  { before: host0.currentStockUnits, after: host1.currentStockUnits },
);
check(
  'and so does the net balance',
  host1.netAvailableUnits === host0.netAvailableUnits + PURCHASE_UNITS,
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
      aspProviderName: 'x',
      contractReference: `SNEAK-${stamp}`,
      totalUnits: 1,
      costPerUnitAed: 0,
    },
  });
  check('nor register a purchase', peekBuy.status === 403, peekBuy.status);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
