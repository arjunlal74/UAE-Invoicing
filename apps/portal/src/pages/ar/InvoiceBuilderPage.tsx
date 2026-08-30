import { useMutation, useQuery } from '@tanstack/react-query';
import type { CustomerSummary, DraftResponse, PaginatedResult } from '@uae/contracts';
import {
  CURRENCY_CODES,
  PAYMENT_MEANS,
  emptyLine,
  recalcInvoice,
  type StagedInvoice,
  type StagedLine,
} from '@uae/domain';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { LineItemsGrid, TotalsStrip, type LineFindings } from '../../components/builder/LineItemsGrid';
import {
  Alert,
  Button,
  Card,
  Field,
  PageHeader,
  Spinner,
  inputClass,
} from '../../components/ui';
import { ApiError, api, queryString } from '../../lib/api';
import { originFrom } from '../../lib/navigation';
import { canFile, useAuthStore } from '../../stores/auth';

/**
 * The In-App Web Invoice Builder (SRS v2.7 §7).
 *
 * Third ingestion channel: no spreadsheet, no ERP. The screen follows the §7
 * wireframe — header, customer, line items, totals, actions — and every number
 * it shows comes from the shared `recalcInvoice`, so what the accountant reads
 * on screen is arithmetically identical to what goes into the UBL document.
 *
 * The draft lives on the server from the first save. That costs a round trip
 * but buys the invoice number reservation: two accountants composing at once
 * cannot both be handed INV-2026-00950 and discover the collision at filing
 * time.
 */

function blankInvoice(): StagedInvoice {
  const now = new Date();
  return recalcInvoice({
    id: 'draft',
    invoiceNumber: '',
    invoiceType: '380',
    issueDate: now.toISOString().slice(0, 10),
    issueTime: now.toTimeString().slice(0, 8),
    currency: 'AED',
    fxRate: '1.000000',
    supplierTrn: '',
    supplierName: '',
    buyerTrn: '',
    buyerName: '',
    buyerEmirate: 'Dubai',
    poReference: '',
    precedingInvoiceId: '',
    paymentMeans: '30',
    lines: [emptyLine(crypto.randomUUID(), 1)],
    lineExtensionAmount: '',
    taxExclusiveAmount: '',
    vatTotalAmount: '',
    taxInclusiveAmount: '',
    payableAmount: '',
    payableAmountAed: '',
    sourceRow: null,
  });
}

export function InvoiceBuilderPage() {
  const { draftId } = useParams<{ draftId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  // Where Cancel returns to: the customer directory, the drafts list, or
  // wherever else the builder was opened from.
  const origin = originFrom(useLocation().search, { to: '/ar/drafts', label: 'Drafts' });
  const user = useAuthStore((s) => s.user);
  const files = canFile(user);

  const [invoice, setInvoice] = useState<StagedInvoice>(blankInvoice);
  const [customerId, setCustomerId] = useState<string | null>(
    searchParams.get('customerId'),
  );
  const [savedId, setSavedId] = useState<string | null>(draftId ?? null);
  const [findings, setFindings] = useState<DraftResponse['findings']>([]);
  const [message, setMessage] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | null>(
    null,
  );

  // --- Reference data ------------------------------------------------------
  const { data: customers } = useQuery({
    queryKey: ['customers', 'picker'],
    queryFn: () =>
      api<PaginatedResult<CustomerSummary>>(
        `/api/v1/customers${queryString({ pageSize: 200 })}`,
      ),
  });

  const { data: existing, isLoading } = useQuery({
    queryKey: ['draft', savedId],
    queryFn: () => api<DraftResponse>(`/api/v1/ar/drafts/${savedId}`),
    enabled: Boolean(draftId),
  });

  const { data: suggested } = useQuery({
    queryKey: ['next-number', invoice.invoiceType],
    queryFn: () =>
      api<{ invoiceNumber: string }>(
        `/api/v1/ar/next-number${queryString({ type: invoice.invoiceType })}`,
      ),
    enabled: !draftId,
  });

  useEffect(() => {
    if (!existing) return;
    setInvoice(recalcInvoice(existing.invoice as unknown as StagedInvoice));
    setCustomerId(existing.customerId);
    setFindings(existing.findings);
  }, [existing]);

  // Only fills an empty field: an accountant who typed their own number must
  // not have it replaced when the suggestion arrives a moment later.
  useEffect(() => {
    if (suggested?.invoiceNumber) {
      setInvoice((current) =>
        current.invoiceNumber ? current : { ...current, invoiceNumber: suggested.invoiceNumber },
      );
    }
  }, [suggested]);

  const customer = useMemo(
    () => customers?.items.find((c) => c.id === customerId) ?? null,
    [customers, customerId],
  );

  // --- Editing -------------------------------------------------------------
  const update = (patch: Partial<StagedInvoice>) =>
    setInvoice((current) => recalcInvoice({ ...current, ...patch }));

  const updateLine = (id: string, patch: Partial<StagedLine>) =>
    setInvoice((current) =>
      recalcInvoice({
        ...current,
        lines: current.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)),
      }),
    );

  const selectCustomer = (id: string) => {
    setCustomerId(id || null);
    const picked = customers?.items.find((c) => c.id === id);
    if (!picked) return;

    update({
      buyerName: picked.customerNameEn,
      buyerTrn: picked.trn ?? '',
      buyerEmirate: picked.emirate,
      paymentMeans: picked.defaultPaymentMeans ?? invoice.paymentMeans,
      // §6: the customer type decides the document type. A B2C buyer has no
      // TRN, so a 380 addressed to them could never clear.
      invoiceType: picked.customerType === 'B2C' ? '388' : '380',
    });
  };

  // --- Server round trips --------------------------------------------------
  const save = useMutation({
    mutationFn: async () => {
      const body = { id: savedId ?? undefined, customerId, invoice };
      return api<DraftResponse>(
        savedId ? `/api/v1/ar/drafts/${savedId}` : '/api/v1/ar/drafts',
        { method: savedId ? 'PUT' : 'POST', body },
      );
    },
    onSuccess: (response) => {
      setSavedId(response.id);
      setInvoice(recalcInvoice(response.invoice as unknown as StagedInvoice));
      setFindings(response.findings);
      setMessage({ kind: 'ok', text: 'Draft saved.' });
      if (!draftId) navigate(`/ar/drafts/${response.id}`, { replace: true });
    },
    onError: (err) =>
      setMessage({
        kind: 'danger',
        text: err instanceof ApiError ? err.message : 'The draft could not be saved.',
      }),
  });

  const validate = useMutation({
    mutationFn: async () => {
      const saved = await save.mutateAsync();
      return api<DraftResponse>(`/api/v1/ar/drafts/${saved.id}/validate`, { method: 'POST' });
    },
    onSuccess: (response) => {
      setFindings(response.findings);
      setMessage(
        response.submittable
          ? { kind: 'ok', text: 'This invoice passes every pre-flight check and is ready to file.' }
          : { kind: 'danger', text: 'This invoice is not yet compliant. See the findings below.' },
      );
    },
  });

  const submit = useMutation({
    mutationFn: async () => {
      const saved = await save.mutateAsync();
      return api<{ id: string; queued: boolean; message: string }>(
        `/api/v1/ar/drafts/${saved.id}/submit`,
        { method: 'POST' },
      );
    },
    onSuccess: (response) => navigate(`/invoices/${response.id}`),
    onError: (err) =>
      setMessage({
        kind: 'danger',
        text: err instanceof ApiError ? err.message : 'The invoice could not be submitted.',
      }),
  });

  const blocking = findings.filter((f) => f.severity === 'ERROR' || f.severity === 'FATAL');
  const warnings = findings.filter((f) => f.severity === 'WARNING');

  const lineFindings: LineFindings = useMemo(() => {
    const byLine = new Map<string, Set<string>>();
    for (const finding of blocking) {
      if (!finding.lineId) continue;
      const set = byLine.get(finding.lineId) ?? new Set<string>();
      set.add(finding.field);
      byLine.set(finding.lineId, set);
    }
    return { byLine };
  }, [blocking]);

  const busy = save.isPending || validate.isPending || submit.isPending;

  if (draftId && isLoading) return <Spinner label="Opening draft…" />;

  return (
    <div className="space-y-4">
      <PageHeader
        title={savedId ? `Edit ${invoice.invoiceNumber || 'draft'}` : 'Create tax invoice'}
        description="Compose a sales invoice directly, without a spreadsheet."
        actions={
          <>
            <Button onClick={() => navigate(origin.to)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} disabled={busy}>
              Save draft
            </Button>
            <Button onClick={() => validate.mutate()} disabled={busy}>
              Validate
            </Button>
            <Button variant="primary" onClick={() => submit.mutate()} disabled={busy}>
              {files ? 'Submit to FTA' : 'Submit for approval'}
            </Button>
          </>
        }
      />

      {message && (
        <Alert kind={message.kind === 'ok' ? 'ok' : message.kind === 'info' ? 'info' : 'danger'}>
          {message.text}
        </Alert>
      )}

      {!files && (
        <Alert kind="info">
          Your role prepares invoices; a tax approver releases them. Submitting sends this document
          to their queue rather than to the FTA.
        </Alert>
      )}

      {/* --- Header --------------------------------------------------------- */}
      <Card title="Invoice header">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Invoice type" required>
            <select
              className={inputClass}
              value={invoice.invoiceType}
              onChange={(e) => update({ invoiceType: e.target.value })}
            >
              <option value="380">380 — Commercial tax invoice (B2B)</option>
              <option value="388">388 — Simplified tax invoice (B2C)</option>
            </select>
          </Field>

          <Field label="Invoice number" required hint="Suggested from your own series.">
            <input
              className={inputClass}
              value={invoice.invoiceNumber}
              onChange={(e) => update({ invoiceNumber: e.target.value })}
            />
          </Field>

          <Field label="Issue date" required>
            <input
              className={inputClass}
              type="date"
              value={invoice.issueDate}
              onChange={(e) => update({ issueDate: e.target.value })}
            />
          </Field>

          <Field label="Issue time" required>
            <input
              className={inputClass}
              type="time"
              step={1}
              value={invoice.issueTime}
              onChange={(e) => update({ issueTime: e.target.value })}
            />
          </Field>

          <Field label="Currency">
            <select
              className={inputClass}
              value={invoice.currency}
              onChange={(e) =>
                update({
                  currency: e.target.value,
                  // AED is the tax currency, so its rate is definitionally 1.
                  fxRate: e.target.value === 'AED' ? '1.000000' : invoice.fxRate,
                })
              }
            >
              {CURRENCY_CODES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="FX rate to AED"
            hint={invoice.currency === 'AED' ? 'Fixed at 1 for AED invoices.' : undefined}
          >
            <input
              className={inputClass}
              value={invoice.fxRate}
              disabled={invoice.currency === 'AED'}
              inputMode="decimal"
              onChange={(e) => update({ fxRate: e.target.value })}
            />
          </Field>

          <Field label="Payment means">
            <select
              className={inputClass}
              value={invoice.paymentMeans}
              onChange={(e) => update({ paymentMeans: e.target.value })}
            >
              {Object.entries(PAYMENT_MEANS).map(([code, label]) => (
                <option key={code} value={code}>
                  {code} — {label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Purchase order reference">
            <input
              className={inputClass}
              value={invoice.poReference}
              onChange={(e) => update({ poReference: e.target.value })}
            />
          </Field>
        </div>
      </Card>

      {/* --- Buyer ---------------------------------------------------------- */}
      <Card
        title="Customer"
        actions={
          <Button size="sm" onClick={() => navigate('/ar/customers')}>
            Manage directory
          </Button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Select from directory" hint="Fills the whole party block.">
            <select
              className={inputClass}
              value={customerId ?? ''}
              onChange={(e) => selectCustomer(e.target.value)}
            >
              <option value="">— Enter manually —</option>
              {customers?.items.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.customerNameEn}
                  {option.trn ? ` · ${option.trn}` : ''}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Buyer name" required>
            <input
              className={inputClass}
              value={invoice.buyerName}
              onChange={(e) => update({ buyerName: e.target.value })}
            />
          </Field>

          <Field
            label="Buyer TRN"
            required={invoice.invoiceType === '380'}
            hint={invoice.invoiceType === '388' ? 'Not required on a simplified invoice.' : undefined}
          >
            <input
              className={inputClass}
              value={invoice.buyerTrn}
              maxLength={15}
              inputMode="numeric"
              onChange={(e) => update({ buyerTrn: e.target.value.replace(/\D/g, '') })}
            />
          </Field>

          <Field label="Emirate" required>
            <input
              className={inputClass}
              value={invoice.buyerEmirate}
              onChange={(e) => update({ buyerEmirate: e.target.value })}
            />
          </Field>
        </div>

        {customer && (
          <p className="mt-3 text-xs text-slate-500">
            {customer.streetAddress || 'No street on file'}
            {customer.building ? `, ${customer.building}` : ''} · {customer.emirate}
            {customer.contactEmail ? ` · ${customer.contactEmail}` : ''}
          </p>
        )}
      </Card>

      {/* --- Lines ---------------------------------------------------------- */}
      <Card title="Line items">
        <LineItemsGrid
          lines={invoice.lines}
          findings={lineFindings}
          onChange={updateLine}
          onAdd={() =>
            update({
              lines: [...invoice.lines, emptyLine(crypto.randomUUID(), invoice.lines.length + 1)],
            })
          }
          onRemove={(id) => update({ lines: invoice.lines.filter((line) => line.id !== id) })}
        />
      </Card>

      <TotalsStrip
        currency={invoice.currency}
        net={invoice.lineExtensionAmount}
        vat={invoice.vatTotalAmount}
        total={invoice.payableAmount}
      />

      <FindingsPanel blocking={blocking} warnings={warnings} />
    </div>
  );
}

/** Shared by both builders: the pre-flight result, grouped by severity. */
export function FindingsPanel({
  blocking,
  warnings,
}: {
  blocking: DraftResponse['findings'];
  warnings: DraftResponse['findings'];
}) {
  if (blocking.length === 0 && warnings.length === 0) return null;

  return (
    <Card title="Pre-flight validation">
      <div className="space-y-3">
        {blocking.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-danger-700">
              {blocking.length} blocking {blocking.length === 1 ? 'issue' : 'issues'}
            </p>
            <ul className="space-y-1 text-sm text-danger-700">
              {blocking.map((finding, index) => (
                <li key={`${finding.ruleCode}-${index}`} className="flex gap-2">
                  <span className="font-mono text-xs text-danger-500">{finding.ruleCode}</span>
                  <span>{finding.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {warnings.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-warn-700">
              {warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'}
            </p>
            <ul className="space-y-1 text-sm text-warn-700">
              {warnings.map((finding, index) => (
                <li key={`${finding.ruleCode}-${index}`} className="flex gap-2">
                  <span className="font-mono text-xs text-warn-600">{finding.ruleCode}</span>
                  <span>{finding.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
