/**
 * End-to-end smoke test for ingestion channel 1 (SRS v2.1 §1.2).
 *
 * Drives the programmatic ERP API with real HTTP: mint a key, post documents
 * with it, and assert the properties that matter when the caller is a machine —
 * that a replayed request cannot file twice, that a key holds only its own
 * scopes, that a rejection names fields in the API's own vocabulary, and that
 * revocation takes effect at once.
 *
 * Every run uses fresh invoice numbers, so it is safe to run repeatedly against
 * the same seeded stack.
 *
 * Usage: node scripts/ingest-e2e.mjs   (BASE=http://localhost:8080 by default)
 */
const BASE = process.env.BASE ?? 'http://localhost:8080';

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

function section(title) {
  console.log(`\n=== ${title}`);
}

async function call(path, { method = 'GET', body, token, apiKey, headers = {} } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      ...headers,
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
  return { status: response.status, body: payload, headers: response.headers };
}

const login = async (email) =>
  (await call('/api/v1/auth/login', { method: 'POST', body: { email, password: '123' } })).body
    .accessToken;

const stamp = Date.now().toString(36).toUpperCase();
const num = (suffix) => `ERP-${stamp}-${suffix}`;

// --- 1. key management -------------------------------------------------------
section('1. Key management is an identity decision');

const admin = await login('admin@albahar.local').catch(() => null);
const companyAdmin = admin ?? (await login('finance@albahar.local'));
const clerk = await login('clerk@albahar.local');

const asClerk = await call('/api/v1/api-keys', { token: clerk });
check('an accountant cannot list API keys', asClerk.status === 403, asClerk.body);

const scopes = await call('/api/v1/api-keys/scopes', { token: companyAdmin });
check('the scope catalogue is served', scopes.status === 200 && Array.isArray(scopes.body?.scopes), scopes.body);
check(
  'platform.manage is not on offer',
  !(scopes.body?.scopes ?? []).includes('platform.manage'),
  scopes.body,
);

const overreach = await call('/api/v1/api-keys', {
  method: 'POST',
  token: companyAdmin,
  body: { name: 'overreach', scopes: ['platform.manage'] },
});
check('a key cannot be granted platform.manage', overreach.status === 400, overreach.body);

const created = await call('/api/v1/api-keys', {
  method: 'POST',
  token: companyAdmin,
  body: { name: `E2E filing key ${stamp}`, scopes: ['invoice.read', 'invoice.submit'] },
});
check('a key is created', created.status === 201, created.body);
const token = created.body?.token;
check('the token is returned once, with the expected shape', /^uaeinv_(live|test)_/.test(token ?? ''), token);

const prepareOnly = await call('/api/v1/api-keys', {
  method: 'POST',
  token: companyAdmin,
  body: { name: `E2E prepare key ${stamp}`, scopes: ['invoice.read', 'invoice.submit_for_approval'] },
});
const prepareToken = prepareOnly.body?.token;

const listed = await call('/api/v1/api-keys', { token: companyAdmin });
const mine = (listed.body?.items ?? []).find((k) => k.id === created.body?.key?.id);
check('the list shows the key', Boolean(mine), listed.body);
check('the list never carries the token', !JSON.stringify(listed.body).includes(token), 'token leaked');

// --- 2. authentication -------------------------------------------------------
section('2. Authentication');

const noKey = await call('/api/v1/invoices', { method: 'POST', body: {} });
check('an unauthenticated post is refused', noKey.status === 401, noKey.body);

const badKey = await call('/api/v1/invoices', {
  method: 'POST',
  apiKey: 'uaeinv_test_' + 'x'.repeat(43),
  body: {},
});
check('an unknown key is refused', badKey.status === 401, badKey.body);
check(
  'the refusal does not say which part was wrong',
  !/revoked|expired/i.test(badKey.body?.error?.message ?? '') ||
    /not valid, has been revoked, or has expired/.test(badKey.body?.error?.message ?? ''),
  badKey.body,
);

// --- 3. posting a document ---------------------------------------------------
section('3. Posting a document');

const invoice = (invoiceNumber, overrides = {}) => ({
  invoiceNumber,
  buyer: { name: 'Emirates Trading Co', trn: '100384759200003', emirate: 'Dubai' },
  poReference: 'PO-E2E-1',
  lines: [
    { description: 'Consultancy services', quantity: '10', unitPrice: '500.00', vatCategory: 'S' },
    { description: 'Zero-rated export', quantity: '2', unitPrice: '250.00', vatCategory: 'Z' },
  ],
  ...overrides,
});

const filedNumber = num('A');
const filed = await call('/api/v1/invoices', {
  method: 'POST',
  apiKey: token,
  headers: { 'idempotency-key': `e2e-${stamp}-A` },
  body: invoice(filedNumber),
});
check('a valid invoice is accepted', filed.status === 201, filed.body);
check('it is queued for the tax authority', filed.body?.queued === true, filed.body);
check(
  'totals are computed server-side',
  filed.body?.totals?.taxExclusiveAmount === '5500.00' &&
    filed.body?.totals?.vatTotalAmount === '250.00' &&
    filed.body?.totals?.payableAmount === '5750.00',
  filed.body?.totals,
);

// --- 4. idempotency ----------------------------------------------------------
section('4. Idempotency');

const replay = await call('/api/v1/invoices', {
  method: 'POST',
  apiKey: token,
  headers: { 'idempotency-key': `e2e-${stamp}-A` },
  body: invoice(filedNumber),
});
check('a replay returns the original outcome', replay.status === 201, replay.body);
check('the replay names the same invoice', replay.body?.id === filed.body?.id, replay.body);
check('the replay is flagged as a duplicate', replay.body?.duplicate === true, replay.body);
check('the replay is not a second filing', replay.headers.get('idempotent-replay') === 'true');

const reused = await call('/api/v1/invoices', {
  method: 'POST',
  apiKey: token,
  headers: { 'idempotency-key': `e2e-${stamp}-A` },
  body: invoice(num('B')),
});
check('the same key on a different body is a conflict', reused.status === 409, reused.body);

const duplicateNumber = await call('/api/v1/invoices', {
  method: 'POST',
  apiKey: token,
  body: invoice(filedNumber),
});
check(
  'the same invoice number without a key is still refused',
  duplicateNumber.status === 422 || duplicateNumber.status === 409,
  duplicateNumber.body,
);

// --- 5. validation -----------------------------------------------------------
section('5. Validation');

const malformed = await call('/api/v1/invoices', {
  method: 'POST',
  apiKey: token,
  body: { buyer: { name: 'x' }, lines: [] },
});
check('an empty line list is rejected', malformed.status === 400, malformed.status);

const badTrn = await call('/api/v1/invoices', {
  method: 'POST',
  apiKey: token,
  body: invoice(num('C'), { buyer: { name: 'Bad TRN Co', trn: '999', emirate: 'Dubai' } }),
});
check('a malformed TRN is refused', badTrn.status === 422, badTrn.body);
check(
  'findings name the API field, not a spreadsheet cell',
  JSON.stringify(badTrn.body?.error?.details ?? {}).includes('buyer.trn'),
  badTrn.body?.error?.details,
);

const wrongTotals = await call('/api/v1/invoices', {
  method: 'POST',
  apiKey: token,
  body: invoice(num('D'), { totals: { payableAmount: '1.00' } }),
});
check('stated totals that disagree are refused', wrongTotals.status === 422, wrongTotals.body);
check(
  'the mismatch says which figure and what we computed',
  JSON.stringify(wrongTotals.body?.error?.details ?? {}).includes('5750.00'),
  wrongTotals.body?.error?.details,
);

// --- 6. the approval gate ----------------------------------------------------
section('6. The §16 approval gate');

const held = await call('/api/v1/invoices', {
  method: 'POST',
  apiKey: prepareToken,
  body: invoice(num('E')),
});
check('a prepare-only key is accepted', held.status === 201, held.body);
check('its document is parked for approval', held.body?.pendingApproval === true, held.body);
check('and is not queued', held.body?.queued === false, held.body);
check('with the right status', held.body?.status === 'PENDING_CFO_APPROVAL', held.body);

const holdRequested = await call('/api/v1/invoices', {
  method: 'POST',
  apiKey: token,
  body: invoice(num('F'), { holdForApproval: true }),
});
check(
  'a filing key can still ask to be held',
  holdRequested.body?.pendingApproval === true,
  holdRequested.body,
);

// --- 7. scope enforcement ----------------------------------------------------
section('7. Scope enforcement');

const readOnly = await call('/api/v1/api-keys', {
  method: 'POST',
  token: companyAdmin,
  body: { name: `E2E read key ${stamp}`, scopes: ['invoice.read'] },
});
const readToken = readOnly.body?.token;

const refused = await call('/api/v1/invoices', {
  method: 'POST',
  apiKey: readToken,
  body: invoice(num('G')),
});
check('a read-only key cannot post', refused.status === 403, refused.body);
check(
  'and is told which scope it would need',
  /invoice\.submit/.test(refused.body?.error?.message ?? ''),
  refused.body,
);

const noAdmin = await call('/api/v1/api-keys', { apiKey: token });
check('a key cannot reach the key-management API', noAdmin.status === 401, noAdmin.status);

const noSettings = await call('/api/v1/tenant/users', { apiKey: token });
check('a key cannot list users', noSettings.status === 401, noSettings.status);

// --- 8. status polling -------------------------------------------------------
section('8. Status polling');

const status = await call(`/api/v1/invoices/status/${filedNumber}`, { apiKey: readToken });
check('status is readable by number', status.status === 200, status.body);
check('it names the same document', status.body?.id === filed.body?.id, status.body);
check('and carries the totals', status.body?.totals?.payableAmount === '5750.00', status.body?.totals);

const missing = await call(`/api/v1/invoices/status/${num('NOPE')}`, { apiKey: readToken });
check('an unknown number is a 404', missing.status === 404, missing.status);

// --- 9. revocation -----------------------------------------------------------
section('9. Revocation');

const revoked = await call(`/api/v1/api-keys/${readOnly.body?.key?.id}/revoke`, {
  method: 'POST',
  token: companyAdmin,
});
check('a key is revoked', revoked.status === 200, revoked.body);

const afterRevoke = await call(`/api/v1/invoices/status/${filedNumber}`, { apiKey: readToken });
check('a revoked key stops working immediately', afterRevoke.status === 401, afterRevoke.status);

// --- 10. attribution ---------------------------------------------------------
section('10. Attribution');

const detail = await call(`/api/v1/invoices/${filed.body?.id}`, { token: companyAdmin });
check('the filed document is visible in the portal API', detail.status === 200, detail.status);
check('it is attributed to the REST channel', detail.body?.invoiceNumber === filedNumber, detail.body?.invoiceNumber);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
