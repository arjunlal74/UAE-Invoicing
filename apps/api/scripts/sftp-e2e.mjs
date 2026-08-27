/**
 * End-to-end smoke test for the SFTP limb of ingestion channel 1 (SRS v2.1 §1.2).
 *
 * Writes files into a drop directory the way an ERP's scheduled export would,
 * waits for the watcher to pick them up, and reads back the receipts. It
 * asserts the properties that only exist because the transport is a filesystem:
 * a half-written upload is not claimed, a byte-identical re-send is refused, a
 * file of many documents does not lose the good ones to a bad one, and a
 * revoked key closes the directory.
 *
 * The drop is reached through the `sftp` container rather than over SSH, so no
 * SFTP client is needed. What is exercised is the platform's half — which is
 * the half this repository owns.
 *
 * Usage: node scripts/sftp-e2e.mjs
 *   BASE=http://localhost:8080          the API
 *   SFTP_CONTAINER=uae-invoicing-sftp-1 the container holding the share
 */
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE ?? 'http://localhost:8080';
const CONTAINER = process.env.SFTP_CONTAINER ?? 'uae-invoicing-sftp-1';
const ACCOUNT = process.env.SFTP_ACCOUNT ?? 'erp';
const HOME = `/home/${ACCOUNT}`;

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

// --- talking to the share ----------------------------------------------------

const sh = (command) =>
  execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', command], { encoding: 'utf8' });

/**
 * Content goes in on stdin, never as an argument.
 *
 * A workbook is a hundred kilobytes and the command line is not: passing it as
 * an argv entry fails with ENAMETOOLONG, and it would fail at a different size
 * on every platform, which is the worst kind of limit to discover.
 */
const putFile = (name, contents) => {
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
  execFileSync('docker', ['exec', '-i', CONTAINER, 'sh', '-c', `cat > ${HOME}/inbox/${name}`], {
    input: buffer,
  });
};

// `-a`, because one of the things asserted below is that a dotfile was left
// alone — a listing that cannot see dotfiles would report that either way.
const listDir = (dir) =>
  sh(`ls -1a ${HOME}/${dir} 2>/dev/null || true`)
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name && name !== '.' && name !== '..');

const readReceipt = (dir, name) => {
  const raw = sh(`cat ${HOME}/${dir}/${name}.receipt.json 2>/dev/null || echo ''`).trim();
  return raw ? JSON.parse(raw) : null;
};

/** Poll until the watcher has moved the file out of the inbox. */
async function waitForSettlement(name, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listDir('processed').includes(name)) return 'processed';
    if (listDir('failed').includes(name)) return 'failed';
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
}

// --- talking to the API ------------------------------------------------------

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

const stamp = Date.now().toString(36).toUpperCase();
const num = (suffix) => `SFTP-${stamp}-${suffix}`;

const invoice = (invoiceNumber, overrides = {}) => ({
  invoiceNumber,
  buyer: { name: 'Emirates Trading Co', trn: '100384759200003', emirate: 'Dubai' },
  lines: [{ description: 'Consultancy services', quantity: '4', unitPrice: '250.00' }],
  ...overrides,
});

// --- 0. bind a key to the drop ----------------------------------------------
section('0. A drop directory is an API key with a different transport');

const admin = await call('/api/v1/auth/login', {
  method: 'POST',
  body: { email: 'admin@albahar.local', password: '123' },
});
const token = admin.body?.accessToken;
if (!token) {
  console.error('could not sign in as admin@albahar.local');
  process.exit(1);
}

// Reuse the account's existing key if a previous run already bound it; the
// SFTP username is globally unique and cannot be handed to a second key.
const existing = await call('/api/v1/api-keys', { token });
const bound = (existing.body?.items ?? []).find(
  (key) => key.sftpUsername === ACCOUNT && !key.revokedAt,
);

let keyId = bound?.id ?? null;
if (!bound) {
  const created = await call('/api/v1/api-keys', {
    method: 'POST',
    token,
    body: {
      name: `SFTP drop ${stamp}`,
      scopes: ['invoice.read', 'invoice.submit'],
      sftpUsername: ACCOUNT,
    },
  });
  check('a key can be bound to a drop directory', created.status === 201, created.body);
  keyId = created.body?.key?.id ?? null;
  check('the binding comes back on the key', created.body?.key?.sftpUsername === ACCOUNT, created.body?.key);
} else {
  check('an existing drop binding is reused', true);
}

const collision = await call('/api/v1/api-keys', {
  method: 'POST',
  token,
  body: { name: `collision ${stamp}`, scopes: ['invoice.read'], sftpUsername: ACCOUNT },
});
check('the account name cannot be claimed twice', collision.status === 400, collision.body);

const badName = await call('/api/v1/api-keys', {
  method: 'POST',
  token,
  body: { name: `traversal ${stamp}`, scopes: ['invoice.read'], sftpUsername: '../etc' },
});
check('a name that is not a safe path segment is refused', badName.status === 400, badName.status);

// --- 1. a JSON drop ----------------------------------------------------------
section('1. A JSON drop is filed');

const singleName = `single-${stamp}.json`;
const singleNumber = num('A');
putFile(singleName, JSON.stringify(invoice(singleNumber), null, 2));

const singleOutcome = await waitForSettlement(singleName);
check('the file is picked up and moved out of the inbox', singleOutcome !== null, singleOutcome);
check('it lands in processed', singleOutcome === 'processed', singleOutcome);

const singleReceipt = readReceipt('processed', singleName);
check('a receipt is written beside it', singleReceipt !== null);
check('the receipt says accepted', singleReceipt?.status === 'ACCEPTED', singleReceipt);
check(
  'and names the document it filed',
  singleReceipt?.documents?.[0]?.invoiceNumber === singleNumber,
  singleReceipt?.documents,
);
check('which is queued for the tax authority', singleReceipt?.documents?.[0]?.queued === true, singleReceipt?.documents);

const status = await call(`/api/v1/invoices/status/${singleNumber}`, { token });
check('the invoice exists in the platform', status.status === 200, status.body);
check('with the totals computed from the lines', status.body?.totals?.payableAmount === '1050.00', status.body?.totals);

// --- 2. partial success ------------------------------------------------------
section('2. One bad document does not cost the good ones');

const mixedName = `mixed-${stamp}.json`;
const goodNumber = num('B');
putFile(
  mixedName,
  JSON.stringify([
    invoice(goodNumber),
    invoice(num('C'), { buyer: { name: 'Bad TRN Co', trn: '999', emirate: 'Dubai' } }),
    { nonsense: true },
  ]),
);

const mixedOutcome = await waitForSettlement(mixedName);
const mixedReceipt = readReceipt(mixedOutcome ?? 'processed', mixedName);

check('a partly-good file is reported as partial', mixedReceipt?.status === 'PARTIAL', mixedReceipt?.status);
check('with one entry per document', mixedReceipt?.documents?.length === 3, mixedReceipt?.documents?.length);
check('the good one was filed', mixedReceipt?.documents?.[0]?.accepted === true, mixedReceipt?.documents?.[0]);
check('the bad TRN was named', mixedReceipt?.documents?.[1]?.accepted === false, mixedReceipt?.documents?.[1]);
check(
  'and the finding points at the API field',
  JSON.stringify(mixedReceipt?.documents?.[1]?.error ?? {}).includes('buyer.trn'),
  mixedReceipt?.documents?.[1]?.error,
);
check(
  'the malformed one is a shape error, not a tax error',
  mixedReceipt?.documents?.[2]?.error?.code === 'INVALID_PAYLOAD',
  mixedReceipt?.documents?.[2]?.error,
);

const goodStatus = await call(`/api/v1/invoices/status/${goodNumber}`, { token });
check('the good document really was filed', goodStatus.status === 200, goodStatus.status);

// --- 3. duplicates -----------------------------------------------------------
section('3. A re-sent file is not filed twice');

const dupeName = `duplicate-${stamp}.json`;
putFile(dupeName, JSON.stringify(invoice(singleNumber), null, 2)); // byte-identical to file 1

const dupeOutcome = await waitForSettlement(dupeName);
check('a duplicate is shelved with the files that were not filed', dupeOutcome === 'failed', dupeOutcome);
const dupeReceipt = readReceipt(dupeOutcome ?? 'failed', dupeName);
check('the duplicate is refused', dupeReceipt?.status === 'DUPLICATE', dupeReceipt);
check(
  'and says which delivery it repeats',
  (dupeReceipt?.error?.message ?? '').includes(singleName),
  dupeReceipt?.error,
);

// --- 4. rejections -----------------------------------------------------------
section('4. Rejections');

const brokenName = `broken-${stamp}.json`;
putFile(brokenName, `{ this is not json ${stamp}`);
const brokenOutcome = await waitForSettlement(brokenName);
check('malformed JSON lands in failed', brokenOutcome === 'failed', brokenOutcome);
check(
  'with a receipt that says why',
  readReceipt('failed', brokenName)?.error?.code === 'MALFORMED_JSON',
  readReceipt('failed', brokenName)?.error,
);

const wrongTypeName = `notes-${stamp}.txt`;
putFile(wrongTypeName, `just a note ${stamp}`);
const wrongTypeOutcome = await waitForSettlement(wrongTypeName);
check('an unsupported format lands in failed', wrongTypeOutcome === 'failed', wrongTypeOutcome);
check(
  'and names the formats that are accepted',
  (readReceipt('failed', wrongTypeName)?.error?.message ?? '').includes('.xlsx'),
  readReceipt('failed', wrongTypeName)?.error,
);

// --- 4b. a workbook drop -----------------------------------------------------
section('4b. A workbook becomes a batch for a person to finish');

const template = await fetch(`${BASE}/api/v1/templates/invoice-template.xlsx`, {
  headers: { authorization: `Bearer ${token}` },
});
const workbook = Buffer.from(await template.arrayBuffer());
const workbookName = `export-${stamp}.xlsx`;
putFile(workbookName, workbook);

const workbookOutcome = await waitForSettlement(workbookName);
const workbookReceipt = readReceipt(workbookOutcome ?? 'processed', workbookName);
check('the workbook is accepted', workbookReceipt?.status === 'ACCEPTED', workbookReceipt);
check('and becomes a batch', Boolean(workbookReceipt?.batch?.reference), workbookReceipt?.batch);
check(
  'whose receipt says it is not filed yet',
  (workbookReceipt?.batch?.message ?? '').includes('not filed yet'),
  workbookReceipt?.batch,
);

const batches = await call('/api/v1/batches', { token });
check(
  'the batch is visible in the portal API',
  (batches.body?.items ?? []).some((b) => b.reference === workbookReceipt?.batch?.reference),
  workbookReceipt?.batch?.reference,
);

// --- 5. what the watcher will not touch --------------------------------------
section('5. What the watcher leaves alone');

sh(`printf '' > ${HOME}/inbox/empty-${stamp}.json`);
sh(`echo '{}' > ${HOME}/inbox/upload-${stamp}.json.filepart`);
sh(`echo '{}' > ${HOME}/inbox/.hidden-${stamp}.json`);

await new Promise((resolve) => setTimeout(resolve, 25_000));
const leftAlone = listDir('inbox');
check('an empty file is left in place', leftAlone.some((n) => n.startsWith('empty-')), leftAlone);
check('a partial upload is left in place', leftAlone.some((n) => n.endsWith('.filepart')), leftAlone);
check('a dotfile is left in place', leftAlone.some((n) => n.startsWith('.hidden-')), leftAlone);

// --- 6. revocation closes the directory --------------------------------------
section('6. Revoking the key closes the drop');

await call(`/api/v1/api-keys/${keyId}/revoke`, { method: 'POST', token });

// The directory belongs to the SFTP account, not the key: revoking must hand
// the name back, or "revoke and re-issue" would permanently burn an account
// name — which is exactly what you do in a hurry when a credential has leaked.
const afterRevoke = await call('/api/v1/api-keys', { token });
const revokedKey = (afterRevoke.body?.items ?? []).find((key) => key.id === keyId);
check('revoking releases the account name', revokedKey?.sftpUsername === null, revokedKey);

const reclaimed = await call('/api/v1/api-keys', {
  method: 'POST',
  token,
  body: { name: `reclaim ${stamp}`, scopes: ['invoice.read'], sftpUsername: ACCOUNT },
});
check('so a replacement key can take it', reclaimed.status === 201, reclaimed.body);
await call(`/api/v1/api-keys/${reclaimed.body?.key?.id}/revoke`, { method: 'POST', token });

const afterName = `after-revoke-${stamp}.json`;
putFile(afterName, JSON.stringify(invoice(num('D'))));

await new Promise((resolve) => setTimeout(resolve, 25_000));
check('a file dropped after revocation is not processed', listDir('inbox').includes(afterName));
check('and is not filed', (await call(`/api/v1/invoices/status/${num('D')}`, { token })).status === 404);

// Leave the share as we found it, so the run is repeatable.
sh(`rm -f ${HOME}/inbox/*${stamp}* ${HOME}/inbox/.*${stamp}* 2>/dev/null || true`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
