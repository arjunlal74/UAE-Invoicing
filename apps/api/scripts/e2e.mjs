/**
 * End-to-end smoke test against a running API.
 *
 * Drives the whole merchant journey with real HTTP calls: sign in, download the
 * generated template, fill it in the way a merchant would (including deliberate
 * mistakes), upload it, watch the worker parse and validate, fix the errors
 * inline, submit, and confirm the invoices reach a clearance verdict.
 *
 * Usage: npx tsx scripts/e2e.mjs
 */
import ExcelJS from 'exceljs';

const API = process.env.API_URL ?? 'http://localhost:3100';
const PASSWORD = '123';

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function api(path, { method = 'GET', body, token, raw = false, formData } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';

  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: formData ?? (body ? JSON.stringify(body) : undefined),
  });

  if (raw) return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()) };

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, { timeoutMs = 60_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  section('1. Authentication');

  const badLogin = await api('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'finance@albahar.local', password: 'wrong-password' },
  });
  check('rejects a wrong password', badLogin.status === 401, `got ${badLogin.status}`);

  // SRS v2.1 §5 splits preparation from filing, so the run needs both: the
  // accountant does everything up to submission, and only the tax approver can
  // release the batch to the FTA.
  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'clerk@albahar.local', password: PASSWORD },
  });
  check('signs in an accountant', login.status === 200 && !!login.body.accessToken);
  const token = login.body.accessToken;

  const cfoLogin = await api('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'finance@albahar.local', password: PASSWORD },
  });
  check('signs in a tax approver', cfoLogin.status === 200 && !!cfoLogin.body.accessToken);
  const cfoToken = cfoLogin.body.accessToken;

  const auditorLogin = await api('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'auditor@albahar.local', password: PASSWORD },
  });
  const auditorToken = auditorLogin.body.accessToken;

  const me = await api('/api/v1/auth/me', { token });
  check('returns the session user', me.body?.email === 'clerk@albahar.local');
  check('scopes the user to their tenant', me.body?.tenantName === 'Al-Bahar Enterprises LLC');

  const noAuth = await api('/api/v1/invoices');
  check('rejects unauthenticated access', noAuth.status === 401, `got ${noAuth.status}`);

  section('2. Tenant isolation');

  const otherLogin = await api('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'admin@gulftech.local', password: PASSWORD },
  });
  const otherToken = otherLogin.body.accessToken;

  const adminAttempt = await api('/api/v1/admin/tenants', { token });
  check('a merchant cannot reach the admin panel', adminAttempt.status === 403, `got ${adminAttempt.status}`);

  section('2b. Role boundaries (SRS v2.1 §5)');

  const auditorEdit = await api('/api/v1/batches', {
    method: 'POST',
    token: auditorToken,
    formData: (() => { const f = new FormData(); f.append('file', new Blob(['x']), 'a.xlsx'); return f; })(),
  });
  check('an auditor cannot upload', auditorEdit.status === 403, `got ${auditorEdit.status}`);

  const auditorRead = await api('/api/v1/invoices', { token: auditorToken });
  check('but an auditor can read invoices', auditorRead.status === 200, `got ${auditorRead.status}`);

  const accountantApproval = await api('/api/v1/approvals/approve', {
    method: 'POST',
    token,
    body: {},
  });
  check(
    'an accountant cannot approve their own work',
    accountantApproval.status === 403,
    `got ${accountantApproval.status}`,
  );

  const approverEdit = await api('/api/v1/batches', {
    method: 'POST',
    token: cfoToken,
    formData: (() => { const f = new FormData(); f.append('file', new Blob(['x']), 'a.xlsx'); return f; })(),
  });
  check(
    'a tax approver files but does not prepare',
    approverEdit.status === 403,
    `got ${approverEdit.status}`,
  );

  section('3. Template download');

  const template = await api('/api/v1/templates/invoice-template.xlsx', { token, raw: true });
  check('serves a generated template', template.status === 200 && template.buffer.length > 5_000);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(template.buffer);
  const headerSheet = workbook.getWorksheet('Invoice_Header');
  const lineSheet = workbook.getWorksheet('Invoice_Line_Items');
  check('template carries the three sheets', !!headerSheet && !!lineSheet && !!workbook.getWorksheet('Ref_Lookups'));
  check(
    "template pre-fills the merchant's own TRN",
    headerSheet.getCell('G2').value === '100293847500003',
    String(headerSheet.getCell('G2').value),
  );

  section('4. Fill the template — two good invoices, two with mistakes');

  const today = new Date().toISOString().slice(0, 10);
  const invoices = [
    // Clean B2B invoice.
    { num: 'E2E-001', type: '380', buyerTrn: '100384759200003', buyer: 'Emirates Trading Co', emirate: 'Dubai',
      lines: [{ desc: 'Cloud Hosting', qty: 1, price: 5000, cat: 'S' }, { desc: 'Support', qty: 2, price: 750, cat: 'S' }] },
    // Clean B2C simplified invoice, no buyer TRN.
    { num: 'E2E-002', type: '388', buyerTrn: '', buyer: 'Walk-in Customer', emirate: 'Sharjah',
      lines: [{ desc: 'Retail Goods', qty: 3, price: 150, cat: 'S' }] },
    // Buyer TRN too short — must be caught.
    { num: 'E2E-003', type: '380', buyerTrn: '1002938475', buyer: 'Broken TRN Co', emirate: 'Dubai',
      lines: [{ desc: 'Consulting', qty: 4, price: 1000, cat: 'S' }] },
    // VAT category and rate contradict each other, and the emirate is misspelled.
    { num: 'E2E-004', type: '380', buyerTrn: '100492817400003', buyer: 'Zero Rate Co', emirate: 'dxb',
      lines: [{ desc: 'Exported Goods', qty: 1, price: 2000, cat: 'Z', rate: 5 }] },
  ];

  let hRow = 2;
  let lRow = 2;
  for (const invoice of invoices) {
    headerSheet.getCell(`A${hRow}`).value = invoice.num;
    headerSheet.getCell(`B${hRow}`).value = invoice.type;
    headerSheet.getCell(`C${hRow}`).value = today;
    headerSheet.getCell(`D${hRow}`).value = '10:30:00';
    headerSheet.getCell(`I${hRow}`).value = invoice.buyerTrn;
    headerSheet.getCell(`J${hRow}`).value = invoice.buyer;
    headerSheet.getCell(`K${hRow}`).value = invoice.emirate;
    headerSheet.getCell(`N${hRow}`).value = '30';
    hRow++;

    invoice.lines.forEach((line, index) => {
      lineSheet.getCell(`A${lRow}`).value = invoice.num;
      lineSheet.getCell(`B${lRow}`).value = index + 1;
      lineSheet.getCell(`C${lRow}`).value = line.desc;
      lineSheet.getCell(`E${lRow}`).value = line.qty;
      lineSheet.getCell(`F${lRow}`).value = 'PCE';
      lineSheet.getCell(`G${lRow}`).value = line.price;
      lineSheet.getCell(`I${lRow}`).value = line.cat;
      if (line.rate !== undefined) lineSheet.getCell(`J${lRow}`).value = line.rate;
      lRow++;
    });
  }

  const filled = Buffer.from(await workbook.xlsx.writeBuffer());

  section('5. Upload');

  const form = new FormData();
  form.append('file', new Blob([filled]), 'e2e-invoices.xlsx');
  const upload = await api('/api/v1/batches', { method: 'POST', token, formData: form });
  check('accepts the upload', upload.status === 202, `${upload.status} ${JSON.stringify(upload.body)}`);
  const batchId = upload.body?.id;

  const duplicateUpload = await api('/api/v1/batches', {
    method: 'POST',
    token,
    formData: (() => { const f = new FormData(); f.append('file', new Blob([filled]), 'e2e-invoices.xlsx'); return f; })(),
  });
  check('rejects a byte-identical re-upload', duplicateUpload.status === 400, `got ${duplicateUpload.status}`);

  section('6. Worker parses and validates');

  const staged = await waitFor('the batch to finish parsing', async () => {
    const result = await api(`/api/v1/batches/${batchId}/staging?pageSize=50`, { token });
    const status = result.body?.batch?.status;
    return status && status !== 'UPLOADED' && status !== 'PARSING' ? result.body : null;
  });

  check('parsed every invoice', staged.total === 4, `total=${staged.total}`);
  check('batch reports errors present', staged.batch.status === 'STAGED_WITH_ERRORS', staged.batch.status);
  check('counted the valid rows', staged.batch.validRecords === 2, `valid=${staged.batch.validRecords}`);
  check('counted the invalid rows', staged.batch.invalidRecords === 2, `invalid=${staged.batch.invalidRecords}`);

  const rows = Object.fromEntries(staged.rows.map((r) => [r.invoice.invoiceNumber, r]));

  check('accepted the clean B2B invoice', rows['E2E-001']?.submittable === true);
  check('accepted the B2C invoice with no buyer TRN', rows['E2E-002']?.submittable === true);
  check(
    'warned that the B2C invoice will be filed as simplified',
    rows['E2E-002']?.findings.some((f) => f.ruleCode === 'WRN-UAE-02'),
  );

  const shortTrn = rows['E2E-003'];
  check('rejected the short buyer TRN', shortTrn?.submittable === false);
  const trnFinding = shortTrn?.findings.find((f) => f.ruleCode === 'BR-UAE-08');
  check('flagged it with the right rule code', !!trnFinding);
  check('mapped it to the exact spreadsheet cell', trnFinding?.cell === 'I4', `cell=${trnFinding?.cell}`);
  check('named the source sheet', trnFinding?.sheet === 'Invoice_Header');

  const badRate = rows['E2E-004'];
  check('rejected the contradictory VAT rate', badRate?.submittable === false);
  check(
    'flagged the VAT rate mismatch',
    badRate?.findings.some((f) => f.ruleCode === 'BR-UAE-14'),
  );
  check(
    'flagged the misspelled emirate',
    badRate?.findings.some((f) => f.ruleCode === 'BR-UAE-13'),
  );

  check(
    'computed totals correctly (1x5000 + 2x750 + 5% VAT)',
    rows['E2E-001']?.invoice.payableAmount === '6825.00',
    rows['E2E-001']?.invoice.payableAmount,
  );

  section('7. Auto-fix the mechanical mistakes');

  const autofix = await api(`/api/v1/batches/${batchId}/autofix`, { method: 'POST', token });
  check('auto-fix reports what it changed', autofix.status === 200 && autofix.body.changed >= 1, JSON.stringify(autofix.body?.changed));
  check(
    'auto-fix corrected the emirate',
    autofix.body?.changes?.some((c) => c.field === 'buyerEmirate' && c.to === 'Dubai'),
  );
  check(
    'auto-fix did NOT invent a buyer TRN',
    !autofix.body?.changes?.some((c) => c.field === 'buyerTrn' && c.to?.length === 15),
  );

  const afterFix = await api(`/api/v1/batches/${batchId}/staging?pageSize=50`, { token });
  const fixedRows = Object.fromEntries(afterFix.body.rows.map((r) => [r.invoice.invoiceNumber, r]));
  check('the auto-fixed invoice now passes', fixedRows['E2E-004']?.submittable === true);
  check(
    'the VAT rate warning clears once the row is normalised',
    !fixedRows['E2E-004']?.findings.some((f) => f.ruleCode === 'BR-UAE-14'),
  );
  check(
    'and the stored rate now matches the zero-rated category',
    fixedRows['E2E-004']?.invoice.lines[0]?.vatRate === '0.00',
    fixedRows['E2E-004']?.invoice.lines[0]?.vatRate,
  );
  check('the TRN error still stands', fixedRows['E2E-003']?.submittable === false);

  section('8. Fix the remaining error inline, as a user would');

  const patch = await api(`/api/v1/batches/${batchId}/staging/${fixedRows['E2E-003'].id}`, {
    method: 'PATCH',
    token,
    body: { invoice: { buyerTrn: '100384759200003' } },
  });
  check('accepts the inline edit', patch.status === 200);
  check('the row revalidates as clean', patch.body?.submittable === true);
  check('the TRN error is gone', !patch.body?.findings.some((f) => f.ruleCode === 'BR-UAE-08'));

  const readyBatch = await api(`/api/v1/batches/${batchId}`, { token });
  check('all four rows are now valid', readyBatch.body?.validRecords === 4, `valid=${readyBatch.body?.validRecords}`);

  section('9. Submit for approval, then file');

  const submit = await api(`/api/v1/batches/${batchId}/submit`, { method: 'POST', token, body: {} });
  check('the accountant sends every valid invoice for approval', submit.status === 200 && submit.body.pendingApproval === 4, JSON.stringify(submit.body));
  check('and nothing reaches the FTA yet', submit.body?.queued === 0, JSON.stringify(submit.body));

  const resubmit = await api(`/api/v1/batches/${batchId}/submit`, { method: 'POST', token, body: {} });
  check('a second submit sends nothing', resubmit.body?.pendingApproval === 0, JSON.stringify(resubmit.body));

  const queue = await api('/api/v1/invoices?status=PENDING_CFO_APPROVAL&pageSize=50', { token: cfoToken });
  check('the approver sees the queue', queue.body?.total === 4, `total=${queue.body?.total}`);
  check('the queue names who prepared each invoice', queue.body?.items?.every((i) => i.createdByName === 'Priya Nair'));

  const approve = await api('/api/v1/approvals/approve', {
    method: 'POST',
    token: cfoToken,
    body: { note: 'Reviewed against the August ledger.' },
  });
  check('the approver releases all four', approve.status === 200 && approve.body.affected === 4, JSON.stringify(approve.body));

  const emptyQueue = await api('/api/v1/invoices?status=PENDING_CFO_APPROVAL', { token: cfoToken });
  check('the queue empties', emptyQueue.body?.total === 0, `total=${emptyQueue.body?.total}`);

  section('10. Transmission and clearance');

  const cleared = await waitFor(
    'all invoices to reach a verdict',
    async () => {
      const result = await api('/api/v1/invoices?pageSize=50', { token });
      const items = result.body?.items ?? [];
      const settled = items.filter((i) =>
        ['ACCEPTED_BY_FTA', 'REJECTED_BY_FTA'].includes(i.status),
      );
      return items.length === 4 && settled.length === 4 ? items : null;
    },
    { timeoutMs: 180_000, intervalMs: 3_000 },
  );

  check('every invoice reached a verdict', cleared.length === 4);
  const accepted = cleared.filter((i) => i.status === 'ACCEPTED_BY_FTA');
  console.log(
    `        (${accepted.length} accepted, ${cleared.length - accepted.length} rejected by the simulated provider)`,
  );

  const detail = await api(`/api/v1/invoices/${cleared[0].id}`, { token });
  check('the filed invoice records its approver', detail.body?.approvedByName === 'Rashid Khan', detail.body?.approvedByName);
  check('and the approval note', /August ledger/.test(detail.body?.approvalNote ?? ''), detail.body?.approvalNote);
  check('invoice detail loads', detail.status === 200);
  check('XML was generated and archived', !!detail.body?.ublXmlUri);
  check('XML digest was recorded', detail.body?.ublXmlSha256?.length === 64);
  check('QR payload was generated', !!detail.body?.qrCodeData);
  check('line items were persisted', detail.body?.lines?.length >= 1);
  check('transmission was logged', detail.body?.transmissions?.length >= 1);

  const xml = await api(`/api/v1/invoices/${cleared[0].id}/xml`, { token, raw: true });
  const xmlText = xml.buffer.toString('utf8');
  check('archived XML is retrievable', xml.status === 200);
  check('XML is a PINT-AE UBL invoice', xmlText.includes('urn:peppol:pint:billing-1@ae-1'));
  check('XML carries the supplier TRN', xmlText.includes('100293847500003'));

  section('10b. Returning an invoice to its preparer');

  // Rejection withdraws the invoice rather than marking it failed, because it
  // never left the building. That has to free the invoice number too, or the
  // corrected resubmission would collide with the row it replaces.
  const retryBook = new ExcelJS.Workbook();
  await retryBook.xlsx.load(template.buffer);
  const retryHeader = retryBook.getWorksheet('Invoice_Header');
  const retryLines = retryBook.getWorksheet('Invoice_Line_Items');
  retryHeader.getCell('A2').value = 'E2E-RET-001';
  retryHeader.getCell('B2').value = '380';
  retryHeader.getCell('C2').value = today;
  retryHeader.getCell('D2').value = '11:00:00';
  retryHeader.getCell('I2').value = '100384759200003';
  retryHeader.getCell('J2').value = 'Returned Goods Co';
  retryHeader.getCell('K2').value = 'Dubai';
  retryHeader.getCell('N2').value = '30';
  retryLines.getCell('A2').value = 'E2E-RET-001';
  retryLines.getCell('B2').value = 1;
  retryLines.getCell('C2').value = 'Disputed Consulting';
  retryLines.getCell('E2').value = 1;
  retryLines.getCell('F2').value = 'PCE';
  retryLines.getCell('G2').value = 900;
  retryLines.getCell('I2').value = 'S';

  const retryBuffer = Buffer.from(await retryBook.xlsx.writeBuffer());
  const retryForm = new FormData();
  retryForm.append('file', new Blob([retryBuffer]), 'e2e-return.xlsx');
  const returnUpload = await api('/api/v1/batches', { method: 'POST', token, formData: retryForm });
  check('the accountant uploads a second batch', returnUpload.status === 202, `${returnUpload.status} ${JSON.stringify(returnUpload.body)}`);
  const returnBatchId = returnUpload.body?.id;

  await waitFor('the second batch to parse', async () => {
    const r = await api(`/api/v1/batches/${returnBatchId}`, { token });
    return r.body?.status && !['UPLOADED', 'PARSING'].includes(r.body.status) ? r.body : null;
  });

  const sentForApproval = await api(`/api/v1/batches/${returnBatchId}/submit`, { method: 'POST', token, body: {} });
  check('and sends it for approval', sentForApproval.body?.pendingApproval === 1, JSON.stringify(sentForApproval.body));

  const rejectNoNote = await api('/api/v1/approvals/reject', { method: 'POST', token: cfoToken, body: {} });
  check('rejection without a reason is refused', rejectNoNote.status === 400, `got ${rejectNoNote.status}`);

  const rejected = await api('/api/v1/approvals/reject', {
    method: 'POST',
    token: cfoToken,
    body: { note: 'The consulting line is disputed — confirm the rate first.' },
  });
  check('the approver returns it', rejected.status === 200 && rejected.body.affected === 1, JSON.stringify(rejected.body));

  const afterReject = await api(`/api/v1/batches/${returnBatchId}/staging?pageSize=10`, { token });
  const reopened = afterReject.body?.rows?.[0];
  check('the staged row reopens for correction', reopened?.invoiceId === null, JSON.stringify(reopened?.invoiceId));
  check('and is still submittable', reopened?.submittable === true);

  const resent = await api(`/api/v1/batches/${returnBatchId}/submit`, { method: 'POST', token, body: {} });
  check(
    'so the corrected invoice can be sent again under the same number',
    resent.body?.pendingApproval === 1,
    JSON.stringify(resent.body),
  );

  const cleanup = await api('/api/v1/approvals/approve', { method: 'POST', token: cfoToken, body: {} });
  check('and approved on the second pass', cleanup.body?.affected === 1, JSON.stringify(cleanup.body));

  section('11. Isolation of the archived data');

  const crossTenant = await api(`/api/v1/invoices/${cleared[0].id}`, { token: otherToken });
  check(
    "another tenant cannot read this tenant's invoice",
    crossTenant.status === 404,
    `got ${crossTenant.status}`,
  );

  const otherInvoices = await api('/api/v1/invoices', { token: otherToken });
  check('another tenant sees an empty list', otherInvoices.body?.total === 0, `total=${otherInvoices.body?.total}`);

  section('12. The pending tenant cannot submit');

  const pendingUpload = await api('/api/v1/batches', {
    method: 'POST',
    token: otherToken,
    formData: (() => { const f = new FormData(); f.append('file', new Blob([filled]), 'gulftech.xlsx'); return f; })(),
  });
  check('a pending tenant can still upload', pendingUpload.status === 202, `got ${pendingUpload.status}`);

  const pendingBatch = pendingUpload.body?.id;
  await waitFor('the pending tenant batch to parse', async () => {
    const r = await api(`/api/v1/batches/${pendingBatch}`, { token: otherToken });
    return r.body?.status && !['UPLOADED', 'PARSING'].includes(r.body.status) ? r.body : null;
  });

  const blocked = await api(`/api/v1/batches/${pendingBatch}/submit`, {
    method: 'POST',
    token: otherToken,
    body: {},
  });
  check('but cannot submit', blocked.status === 400, `got ${blocked.status}`);
  check(
    'and is told why',
    /not yet active/i.test(blocked.body?.error?.message ?? ''),
    blocked.body?.error?.message,
  );

  section('13. Search and dashboard');

  const search = await api('/api/v1/invoices?q=Emirates', { token });
  check('full-text search finds a buyer', search.body?.total >= 1, `total=${search.body?.total}`);

  const filtered = await api('/api/v1/invoices?status=ACCEPTED_BY_FTA', { token });
  check('status filter works', filtered.body?.items.every((i) => i.status === 'ACCEPTED_BY_FTA'));

  const dashboard = await api('/api/v1/dashboard', { token });
  check('dashboard loads', dashboard.status === 200);
  check('dashboard knows the tenant can submit', dashboard.body?.canSubmit === true);
  check('dashboard counts invoices', Object.values(dashboard.body?.counts ?? {}).some((n) => n > 0));

  section('14. Admin panel');

  const adminLogin = await api('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'admin@platform.local', password: PASSWORD },
  });
  const adminToken = adminLogin.body.accessToken;
  check('platform admin signs in', !!adminToken);

  const tenants = await api('/api/v1/admin/tenants', { token: adminToken });
  check('admin lists every tenant', tenants.body?.items?.length === 4, `count=${tenants.body?.items?.length}`);
  check(
    'admin sees the tenancy tiers',
    new Set(tenants.body?.items?.map((t) => t.tenantType)).size === 3,
    JSON.stringify(tenants.body?.items?.map((t) => t.tenantType)),
  );
  const subTenantRow = tenants.body?.items?.find((t) => t.companyCode === 'DESERTLOG');
  check('and which partner a sub-tenant sits under', subTenantRow?.parentName === 'Gulf Advisory Partners', subTenantRow?.parentName);

  const monitor = await api('/api/v1/admin/transmissions?onlyProblems=true', { token: adminToken });
  check('transmission monitor loads', monitor.status === 200);

  const auditLog = await api('/api/v1/admin/audit?pageSize=100', { token: adminToken });
  check('audit log records activity', auditLog.body?.total > 10, `entries=${auditLog.body?.total}`);
  const actions = new Set(auditLog.body?.items?.map((i) => i.action));
  check('audit recorded the upload', actions.has('BATCH_UPLOADED'));
  check('audit recorded the inline cell edit', actions.has('STAGING_ROW_EDITED'));
  check('audit recorded the hand-off for approval', actions.has('BATCH_SENT_FOR_APPROVAL'));
  check('audit recorded the approval', actions.has('INVOICES_APPROVED'));
  check('audit recorded the clearance verdict', actions.has('INVOICE_STATUS_CHANGED'));

  const aspConfig = await api(`/api/v1/admin/tenants/${tenants.body.items.find((t) => t.companyCode === 'ALBAHAR').id}/asp-config`, { token: adminToken });
  check('admin can read the ASP configuration', aspConfig.status === 200);
  check('credentials are never returned', aspConfig.body?.credentials === undefined);
  check('but their presence is reported', aspConfig.body?.hasCredentials === true);

  section('15. Channel partner portal');

  const partnerLogin = await api('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'partner@gulfadvisory.local', password: PASSWORD },
  });
  const partnerToken = partnerLogin.body.accessToken;
  check('partner admin signs in', !!partnerToken);

  const partnerOverview = await api('/api/v1/partner/overview', { token: partnerToken });
  check('partner sees their roll-up', partnerOverview.status === 200);
  check('counting their sub-tenants', partnerOverview.body?.subTenantCount === 1, JSON.stringify(partnerOverview.body));

  const subTenants = await api('/api/v1/partner/sub-tenants', { token: partnerToken });
  check('partner lists their sub-tenants', subTenants.body?.items?.length === 1, `count=${subTenants.body?.items?.length}`);
  check('and only their own', subTenants.body?.items?.[0]?.companyCode === 'DESERTLOG');

  const partnerAdminPanel = await api('/api/v1/admin/tenants', { token: partnerToken });
  check('a partner cannot reach the admin panel', partnerAdminPanel.status === 403, `got ${partnerAdminPanel.status}`);

  const partnerInvoices = await api('/api/v1/invoices', { token: partnerToken });
  check("a partner cannot read a sub-tenant's invoices", partnerInvoices.status === 403, `got ${partnerInvoices.status}`);

  const merchantPartnerPortal = await api('/api/v1/partner/sub-tenants', { token });
  check('a merchant cannot reach the partner portal', merchantPartnerPortal.status === 403, `got ${merchantPartnerPortal.status}`);

  const newSubTenant = await api('/api/v1/partner/sub-tenants', {
    method: 'POST',
    token: partnerToken,
    body: {
      companyCode: `E2ESUB${Date.now().toString().slice(-6)}`,
      legalNameEn: 'E2E Onboarded Client LLC',
      legalNameAr: 'عميل تجريبي ذ.م.م',
      trn: '100777888900003',
      registeredAddress: { street: 'Test Road', city: 'Dubai', emirate: 'Dubai', postalCode: '', countryCode: 'AE' },
      adminEmail: `e2e-sub-${Date.now()}@example.local`,
      adminFullName: 'E2E Sub Admin',
    },
  });
  check('partner onboards a sub-tenant', newSubTenant.status === 201, `${newSubTenant.status} ${JSON.stringify(newSubTenant.body)}`);
  check('and gets an invitation link for its administrator', /accept-invite\?token=/.test(newSubTenant.body?.inviteUrl ?? ''));

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nE2E run aborted:', err.message);
  console.log(`\n  ${passed} passed, ${failed} failed before abort`);
  process.exit(1);
});
