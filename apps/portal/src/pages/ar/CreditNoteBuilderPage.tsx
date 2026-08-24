import { useMutation, useQuery } from '@tanstack/react-query';
import {
  REASON_CODE_LABELS,
  REVERSAL_MODE_LABELS,
  RejectionReasonCode,
  ReversalMode,
  type CreditNotePreparation,
  type DraftResponse,
  type InvoiceListItem,
  type PaginatedResult,
} from '@uae/contracts';
import {
  buildCreditNote,
  formatAmount,
  previewReversal,
  recalcInvoice,
  type CreditLineAdjustment,
  type StagedInvoice,
  type StagedLine,
} from '@uae/domain';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { LineItemsGrid, TotalsStrip } from '../../components/builder/LineItemsGrid';
import {
  Alert,
  Button,
  Card,
  Field,
  PageHeader,
  Spinner,
  StatusBadge,
  cx,
  formatDate,
  inputClass,
} from '../../components/ui';
import { ApiError, api, queryString } from '../../lib/api';
import { canFile, useAuthStore } from '../../stores/auth';
import { FindingsPanel } from './InvoiceBuilderPage';

/**
 * The In-App Web Credit Note Builder (SRS v2.7 §8).
 *
 * Once an invoice is cleared it cannot be edited or withdrawn — UAE VAT law and
 * PINT both say so — and a Type 381 that references it is the only lawful
 * correction. This screen is that correction, and its shape follows the §8.1
 * wireframe: the disputed invoice at the top (so the accountant is looking at
 * what the buyer complained about), the reversal configuration in the middle,
 * and the adjustment grid beneath.
 *
 * Arriving with `?invoiceId=` is §8.2's "1-Click Launch from Dispute Alerts":
 * the link in the Template E email lands here with everything already loaded.
 */

const REASON_CODES = RejectionReasonCode.options;

export function CreditNoteBuilderPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const files = canFile(user);

  const [referencedId, setReferencedId] = useState(searchParams.get('invoiceId') ?? '');
  const [mode, setMode] = useState<ReversalMode>('FULL_CANCELLATION');
  const [reasonCode, setReasonCode] = useState<RejectionReasonCode>('OTH');
  const [notes, setNotes] = useState('');
  const [adjustments, setAdjustments] = useState<Map<string, CreditLineAdjustment>>(new Map());
  const [creditNoteNumber, setCreditNoteNumber] = useState('');
  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [savedId, setSavedId] = useState<string | null>(null);
  const [findings, setFindings] = useState<DraftResponse['findings']>([]);
  const [message, setMessage] = useState<{ kind: 'ok' | 'danger'; text: string } | null>(null);

  // --- Candidate invoices --------------------------------------------------
  // Cleared documents only: anything earlier in the lifecycle can still be
  // withdrawn or corrected in place, and crediting it would leave a
  // BillingReference pointing at a document the FTA never saw.
  const { data: candidates } = useQuery({
    queryKey: ['credit-note-candidates'],
    queryFn: () =>
      api<PaginatedResult<InvoiceListItem>>(
        `/api/v1/invoices${queryString({ direction: 'OUTBOUND_SALES_AR', pageSize: 100 })}`,
      ),
  });

  const creditable = useMemo(
    () =>
      (candidates?.items ?? []).filter(
        (item) =>
          item.invoiceType !== 'CREDIT_NOTE' &&
          item.invoiceType !== 'DEBIT_NOTE' &&
          item.ftaIrn !== null,
      ),
    [candidates],
  );

  // --- Server-side preparation (§8.2 feature 1) ----------------------------
  const prepare = useMutation({
    mutationFn: (payload: { referencedInvoiceId: string; reversalMode: ReversalMode }) =>
      api<CreditNotePreparation>('/api/v1/ar/credit-notes/prepare', {
        method: 'POST',
        body: payload,
      }),
    onSuccess: (result) => {
      setCreditNoteNumber(result.invoice.invoiceNumber);
      setIssueDate(result.invoice.issueDate);
      setReasonCode(result.reasonCode);
      setAdjustments(new Map());
      setMessage(null);
    },
    onError: (err) =>
      setMessage({
        kind: 'danger',
        text: err instanceof ApiError ? err.message : 'That invoice could not be loaded.',
      }),
  });

  useEffect(() => {
    if (referencedId) prepare.mutate({ referencedInvoiceId: referencedId, reversalMode: mode });
    // `mode` deliberately excluded: switching between full and partial must not
    // re-fetch and discard the adjustments the accountant has already entered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referencedId]);

  const preparation = prepare.data ?? null;

  // --- The credit note itself ----------------------------------------------
  // Recomputed from the original on every edit rather than held as mutable
  // state: the reversal is a pure function of (invoice, mode, adjustments), and
  // storing it separately is how the grid and the totals come to disagree.
  const original: StagedInvoice | null = useMemo(
    () =>
      preparation
        ? recalcInvoice({
            ...(preparation.invoice as unknown as StagedInvoice),
            lines: preparation.referenced.lines as unknown as StagedLine[],
            invoiceNumber: preparation.referenced.invoiceNumber,
            invoiceType: '380',
          })
        : null,
    [preparation],
  );

  const creditNote: StagedInvoice | null = useMemo(() => {
    if (!original) return null;
    return buildCreditNote({
      original,
      mode,
      creditNoteNumber: creditNoteNumber || 'CN-DRAFT',
      issueDate,
      issueTime: new Date().toTimeString().slice(0, 8),
      adjustments: [...adjustments.values()],
      id: 'credit-note',
    });
  }, [original, mode, creditNoteNumber, issueDate, adjustments]);

  const preview = useMemo(
    () => (original ? previewReversal(original, mode, [...adjustments.values()]) : []),
    [original, mode, adjustments],
  );

  const setAdjustment = (lineId: string, patch: Partial<CreditLineAdjustment> | null) => {
    setAdjustments((current) => {
      const next = new Map(current);
      if (patch === null) next.delete(lineId);
      else next.set(lineId, { lineId, action: 'ADJUST', ...current.get(lineId), ...patch });
      return next;
    });
  };

  // --- Save / validate / submit --------------------------------------------
  const body = () => ({
    id: savedId ?? undefined,
    invoice: creditNote,
    creditNote: {
      referencedInvoiceId: referencedId,
      reversalMode: mode,
      reasonCode,
      notes: notes || null,
    },
  });

  const save = useMutation({
    mutationFn: () =>
      api<DraftResponse>(savedId ? `/api/v1/ar/drafts/${savedId}` : '/api/v1/ar/drafts', {
        method: savedId ? 'PUT' : 'POST',
        body: body(),
      }),
    onSuccess: (response) => {
      setSavedId(response.id);
      setFindings(response.findings);
      setMessage({ kind: 'ok', text: 'Credit note draft saved.' });
    },
    onError: (err) =>
      setMessage({
        kind: 'danger',
        text: err instanceof ApiError ? err.message : 'The credit note could not be saved.',
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
          ? { kind: 'ok', text: 'This credit note passes every pre-flight check.' }
          : { kind: 'danger', text: 'This credit note is not yet compliant. See the findings below.' },
      );
    },
  });

  const submit = useMutation({
    mutationFn: async () => {
      const saved = await save.mutateAsync();
      return api<{ id: string }>(`/api/v1/ar/drafts/${saved.id}/submit`, { method: 'POST' });
    },
    onSuccess: (response) => navigate(`/invoices/${response.id}`),
    onError: (err) =>
      setMessage({
        kind: 'danger',
        text: err instanceof ApiError ? err.message : 'The credit note could not be submitted.',
      }),
  });

  const blocking = findings.filter((f) => f.severity === 'ERROR' || f.severity === 'FATAL');
  const warnings = findings.filter((f) => f.severity === 'WARNING');
  const busy = save.isPending || validate.isPending || submit.isPending;
  const ready = Boolean(creditNote && creditNote.lines.length > 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Create corrective credit note"
        description="UBL Type 381, referencing the cleared invoice it corrects."
        actions={
          <>
            <Button onClick={() => save.mutate()} disabled={!ready || busy}>
              Save draft
            </Button>
            <Button onClick={() => validate.mutate()} disabled={!ready || busy}>
              Pre-flight validation
            </Button>
            <Button variant="primary" onClick={() => submit.mutate()} disabled={!ready || busy}>
              {files ? 'Submit to FTA' : 'Submit for CFO clearance'}
            </Button>
          </>
        }
      />

      {message && <Alert kind={message.kind === 'ok' ? 'ok' : 'danger'}>{message.text}</Alert>}

      {/* --- §8.1 preceding invoice reference -------------------------------- */}
      <Card title="Preceding invoice reference (mandatory FTA linkage)">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Referenced invoice" required>
            <select
              className={inputClass}
              value={referencedId}
              onChange={(e) => setReferencedId(e.target.value)}
            >
              <option value="">— Select a cleared invoice —</option>
              {creditable.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.invoiceNumber} · {item.buyerName} · {item.currencyCode}{' '}
                  {formatAmount(item.payableAmount)}
                  {item.isCommercialDispute && !item.disputeResolved ? ' · disputed' : ''}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {prepare.isPending && (
          <div className="mt-3">
            <Spinner label="Loading the original invoice…" />
          </div>
        )}

        {preparation && (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-slate-500">Original issue date</dt>
              <dd className="text-slate-800">{formatDate(preparation.referenced.issueDate)}</dd>
              <dt className="text-slate-500">Original FTA IRN</dt>
              <dd className="font-mono text-xs text-slate-800">
                {preparation.referenced.ftaIrn ?? 'Not captured'}
              </dd>
              <dt className="text-slate-500">Original amount</dt>
              <dd className="tabular-nums text-slate-800">
                {preparation.referenced.currencyCode}{' '}
                {formatAmount(preparation.referenced.payableAmount)} (incl. VAT)
              </dd>
              <dt className="text-slate-500">Status</dt>
              <dd>
                <StatusBadge status={preparation.referenced.status} />
              </dd>
            </dl>

            {preparation.referenced.disputeReasonCode && (
              <div className="rounded-md border border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700">
                <p className="font-semibold">
                  Buyer dispute · {preparation.referenced.disputeReasonCode} —{' '}
                  {REASON_CODE_LABELS[preparation.referenced.disputeReasonCode]}
                </p>
                {preparation.referenced.disputeComment && (
                  <p className="mt-1 italic">“{preparation.referenced.disputeComment}”</p>
                )}
              </div>
            )}
          </div>
        )}
      </Card>

      {preparation && original && creditNote && (
        <>
          {/* --- §8.1 header configuration --------------------------------- */}
          <Card title="Credit note configuration">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Credit note number" required>
                <input
                  className={inputClass}
                  value={creditNoteNumber}
                  onChange={(e) => setCreditNoteNumber(e.target.value)}
                />
              </Field>

              <Field label="Credit note date" required>
                <input
                  className={inputClass}
                  type="date"
                  value={issueDate}
                  onChange={(e) => setIssueDate(e.target.value)}
                />
              </Field>

              <Field label="Reason for issuance" required>
                <select
                  className={inputClass}
                  value={reasonCode}
                  onChange={(e) => setReasonCode(e.target.value as RejectionReasonCode)}
                >
                  {REASON_CODES.map((code) => (
                    <option key={code} value={code}>
                      {code} — {REASON_CODE_LABELS[code]}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Reversal mode" required>
                <div className="space-y-1 pt-1">
                  {ReversalMode.options.map((option) => (
                    <label key={option} className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="radio"
                        name="reversal-mode"
                        checked={mode === option}
                        onChange={() => {
                          setMode(option);
                          setAdjustments(new Map());
                        }}
                      />
                      {REVERSAL_MODE_LABELS[option]}
                    </label>
                  ))}
                </div>
              </Field>
            </div>

            <div className="mt-3">
              <Field label="Credit note notes" hint="Appears on the document as cbc:Note.">
                <input
                  className={inputClass}
                  value={notes}
                  placeholder="e.g. Adjusted rate from AED 5,000 to AED 4,500 as per MSA-2026-Rev1"
                  onChange={(e) => setNotes(e.target.value)}
                />
              </Field>
            </div>
          </Card>

          {/* --- §8.1 reversal grid ----------------------------------------- */}
          <Card
            title={
              mode === 'FULL_CANCELLATION'
                ? 'Line items being reversed'
                : 'Line item adjustment grid'
            }
          >
            {mode === 'FULL_CANCELLATION' ? (
              <p className="mb-3 text-sm text-slate-600">
                Every line, quantity and VAT amount on {preparation.referenced.invoiceNumber} is
                reversed in full. Switch to a partial adjustment to credit only part of it.
              </p>
            ) : (
              <p className="mb-3 text-sm text-slate-600">
                Enter the corrected quantity or rate for the lines that change. Only the difference
                is credited; lines you leave alone stay on the original invoice.
              </p>
            )}

            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="w-10 px-2 py-2 font-medium">#</th>
                    <th className="px-2 py-2 font-medium">Original item</th>
                    <th className="w-32 px-2 py-2 font-medium">Action</th>
                    <th className="w-24 px-2 py-2 font-medium">Qty</th>
                    <th className="w-28 px-2 py-2 font-medium">New rate</th>
                    <th className="w-28 px-2 py-2 text-right font-medium">Orig net</th>
                    <th className="w-28 px-2 py-2 text-right font-medium">New net</th>
                    <th className="w-28 px-2 py-2 text-right font-medium">Diff net</th>
                    <th className="w-28 px-2 py-2 text-right font-medium">Reversal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {preview.map((row, index) => {
                    const adjustment = adjustments.get(row.lineId);
                    const credited = mode === 'FULL_CANCELLATION' || adjustment?.action === 'CREDIT';
                    const editable = mode === 'PARTIAL_ADJUSTMENT';

                    return (
                      <tr key={row.lineId} className={credited ? 'bg-danger-50/30' : ''}>
                        <td className="px-2 py-1.5 text-slate-500">{index + 1}</td>
                        <td className="px-2 py-1.5 text-slate-800">{row.description}</td>
                        <td className="px-2 py-1.5">
                          {editable ? (
                            <select
                              className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                              value={adjustment?.action ?? 'KEEP'}
                              onChange={(e) => {
                                const action = e.target.value;
                                if (action === 'KEEP') setAdjustment(row.lineId, null);
                                else
                                  setAdjustment(row.lineId, {
                                    action: action as 'CREDIT' | 'ADJUST',
                                  });
                              }}
                            >
                              <option value="KEEP">Keep</option>
                              <option value="ADJUST">Adjust</option>
                              <option value="CREDIT">Credit in full</option>
                            </select>
                          ) : (
                            <span className="text-slate-600">Reverse</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            className="w-full rounded border border-slate-300 px-2 py-1 text-right text-sm tabular-nums disabled:bg-slate-50 disabled:text-slate-500"
                            value={adjustment?.newQuantity ?? row.quantity}
                            disabled={!editable || adjustment?.action !== 'ADJUST'}
                            inputMode="decimal"
                            onChange={(e) =>
                              setAdjustment(row.lineId, {
                                action: 'ADJUST',
                                newQuantity: e.target.value,
                              })
                            }
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            className="w-full rounded border border-slate-300 px-2 py-1 text-right text-sm tabular-nums disabled:bg-slate-50 disabled:text-slate-500"
                            value={adjustment?.newUnitPrice ?? row.originalUnitPrice}
                            disabled={!editable || adjustment?.action !== 'ADJUST'}
                            inputMode="decimal"
                            onChange={(e) =>
                              setAdjustment(row.lineId, {
                                action: 'ADJUST',
                                newUnitPrice: e.target.value,
                              })
                            }
                          />
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                          {formatAmount(row.originalNet)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                          {formatAmount(row.newNet)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">
                          {formatAmount(row.differenceNet)}
                        </td>
                        <td
                          className={cx(
                            'px-2 py-1.5 text-right font-medium tabular-nums',
                            row.reversalTotal.startsWith('-')
                              ? 'text-danger-700'
                              : 'text-slate-400',
                          )}
                        >
                          {formatAmount(row.reversalTotal)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* --- What will actually be filed -------------------------------- */}
          <Card title="Credit note as it will be filed">
            <LineItemsGrid
              lines={creditNote.lines}
              readOnly
              reversal
              onChange={() => undefined}
              onAdd={() => undefined}
              onRemove={() => undefined}
            />
          </Card>

          <TotalsStrip
            currency={creditNote.currency}
            net={creditNote.lineExtensionAmount}
            vat={creditNote.vatTotalAmount}
            total={creditNote.payableAmount}
            reversal
          />

          {creditNote.lines.length === 0 && (
            <Alert kind="warn">
              Nothing is being credited yet. Choose “Adjust” or “Credit in full” on at least one
              line.
            </Alert>
          )}

          {!files && (
            <Alert kind="info">
              Credit notes require sign-off from a tax approver before they reach the FTA.
              Submitting sends this document to their clearance queue.
            </Alert>
          )}

          <FindingsPanel blocking={blocking} warnings={warnings} />
        </>
      )}
    </div>
  );
}
