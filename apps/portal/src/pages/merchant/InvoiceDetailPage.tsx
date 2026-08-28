import {
  REASON_CODE_LABELS,
  RESPONSE_CODE_LABELS,
  REVERSAL_MODE_LABELS,
  type ApprovalDecisionResponse,
  type InvoiceDetail,
} from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatAmount } from '@uae/domain';
import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Amount, Detail, DocumentLines, ResponseLog } from '../../components/DocumentPanels';
import { PdfActions } from '../../components/PdfActions';
import {
  Alert,
  Button,
  Card,
  Spinner,
  StatusBadge,
  cx,
  formatDate,
  formatDateTime,
  inputClass,
  invoiceTypeLabel,
} from '../../components/ui';
import { ApiError, api, apiBlob, downloadBlob } from '../../lib/api';
import { keepOrigin, originFrom } from '../../lib/navigation';
import { canEdit, canFile, useAuthStore } from '../../stores/auth';

export function InvoiceDetailPage() {
  const { invoiceId = '' } = useParams();
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  // Back to the list this was opened from, not to the list it happens to
  // belong to: an approver returned to every invoice ever filed has lost their
  // place in the queue they were working.
  const origin = originFrom(useLocation().search, { to: '/invoices', label: 'All invoices' });
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: () => api<InvoiceDetail>(`/api/v1/invoices/${invoiceId}`),
    refetchInterval: (query) =>
      query.state.data?.status === 'SUBMITTED_TO_ASP' ? 5_000 : false,
  });

  // §6.3 — the approver's two verdicts, on the document itself.
  //
  // The queue can already do this in bulk, which is right for a run of twenty
  // identical invoices and wrong for the one that made somebody open it: an
  // approver who wants to read a document before releasing it had to decide
  // from a list, or read it here and then go back and find the row again.
  //
  // The card sits at the foot of the page deliberately. Releasing an invoice to
  // the tax authority is the approver attesting to what is on it, and buttons
  // above the line items invite a decision made from the header alone. Reaching
  // these means the document has gone past.
  const [approvalNote, setApprovalNote] = useState('');
  const [approvalOutcome, setApprovalOutcome] = useState<{
    kind: 'ok' | 'danger';
    text: string;
  } | null>(null);

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      api<ApprovalDecisionResponse>(`/api/v1/approvals/${decision}`, {
        method: 'POST',
        body: { invoiceIds: [invoiceId], note: approvalNote.trim() || undefined },
      }),
    onSuccess: (result, decision) => {
      setApprovalNote('');
      // A skipped invoice is a 200, not a failure, so the reason the server
      // gave is what the approver needs to see rather than a tick.
      setApprovalOutcome(
        result.affected > 0
          ? {
              kind: 'ok',
              text:
                decision === 'approve'
                  ? 'Approved and queued for filing with the FTA.'
                  : 'Returned to the preparer. Their staged rows are open for correction again.',
            }
          : { kind: 'danger', text: result.reasons[0]?.reason ?? 'Nothing was changed.' },
      );
      void queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
    },
    onError: (err) =>
      setApprovalOutcome({
        kind: 'danger',
        text: err instanceof ApiError ? err.message : 'That decision could not be recorded.',
      }),
  });

  const retry = useMutation({
    mutationFn: () => api(`/api/v1/invoices/${invoiceId}/retry`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] }),
  });

  if (isLoading || !data) {
    return (
      <div className="py-16">
        <Spinner label="Loading invoice…" />
      </div>
    );
  }

  // "Has this been sent?" rather than "did it succeed?" — a rejected invoice
  // was submitted, and its empty identifiers are what the reader came for.
  const submitted = Boolean(data.submittedAt);

  const canRetry =
    canFile(user) && (data.status === 'REJECTED_BY_FTA' || data.status === 'VALIDATION_FAILED');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to={origin.to} className="text-sm text-brand-600 underline">
            ← {origin.label}
          </Link>
          <h1 className="mt-1 flex items-center gap-3 text-lg font-semibold text-slate-900">
            {data.invoiceNumber}
            <StatusBadge status={data.status} />
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <PdfActions path={`/api/v1/invoices/${invoiceId}/pdf`} label="Download PDF" />
          {data.ublXmlUri && (
            <Button
              onClick={async () => {
                const { blob, filename } = await apiBlob(`/api/v1/invoices/${invoiceId}/xml`);
                downloadBlob(blob, filename);
              }}
            >
              Download XML
            </Button>
          )}
          {canRetry && (
            <Button variant="primary" onClick={() => retry.mutate()} disabled={retry.isPending}>
              {retry.isPending ? 'Resubmitting…' : 'Resubmit'}
            </Button>
          )}
        </div>
      </div>

      {retry.error && (
        <Alert kind="danger">
          {retry.error instanceof ApiError ? retry.error.message : 'That retry could not be queued.'}
        </Alert>
      )}

      {data.status === 'REJECTED_BY_FTA' && (
        <Alert kind="danger" title="Rejected by the Federal Tax Authority">
          <p>{data.ftaRejectionReason ?? 'No reason was supplied.'}</p>
          <p className="mt-2 text-xs">
            This invoice has <strong>not</strong> been filed. Correct the underlying data and
            resubmit, or issue a corrected document.
          </p>
        </Alert>
      )}

      {data.status === 'SUBMITTED_TO_ASP' && (
        <Alert kind="warn" title="Awaiting a verdict">
          Sent to your provider {formatDateTime(data.submittedAt)}. This page updates automatically.
        </Alert>
      )}

      {/* --- SRS v2.7 §11: the buyer's verdict ---------------------------- */}
      {data.isCommercialDispute && !data.disputeResolved && (
        <Alert
          kind="danger"
          title={`Disputed by the buyer${data.latestResponseReasonCode ? ` · ${data.latestResponseReasonCode} — ${REASON_CODE_LABELS[data.latestResponseReasonCode]}` : ''}`}
        >
          <p>
            {data.latestResponseCode && RESPONSE_CODE_LABELS[data.latestResponseCode]} on{' '}
            {formatDateTime(data.disputeOpenedAt)}.
          </p>
          {data.latestResponseComment && (
            <p className="mt-1 italic">“{data.latestResponseComment}”</p>
          )}
          <p className="mt-2 text-xs">
            A cleared invoice cannot be amended or withdrawn. Issue a credit note that references
            it.
          </p>
          {canEdit(user) && (
            <div className="mt-3">
              <Button
                variant="primary"
                size="sm"
                onClick={() => navigate(`/ar/credit-notes/new?invoiceId=${invoiceId}`)}
              >
                Generate corrective credit note
              </Button>
            </div>
          )}
        </Alert>
      )}

      {data.disputeResolved && data.correctiveCreditNoteId && (
        <Alert kind="ok" title="Dispute resolved">
          Credit note{' '}
          <Link
            to={keepOrigin(`/invoices/${data.correctiveCreditNoteId}`, origin)}
            className="font-medium underline"
          >
            {data.correctiveCreditNoteNumber ?? 'view'}
          </Link>{' '}
          cleared on {formatDateTime(data.disputeResolvedAt)} and reversed this invoice.
        </Alert>
      )}

      {/* --- §8.2: what this credit note corrects -------------------------- */}
      {data.referencedInvoiceNumber && (
        <Alert kind="info" title="Corrective document">
          <p>
            This {data.invoiceType === 'CREDIT_NOTE' ? 'credit note' : 'debit note'} adjusts invoice{' '}
            {data.referencedInvoiceId ? (
              <Link
                to={keepOrigin(`/invoices/${data.referencedInvoiceId}`, origin)}
                className="font-medium underline"
              >
                {data.referencedInvoiceNumber}
              </Link>
            ) : (
              <strong>{data.referencedInvoiceNumber}</strong>
            )}
            {data.referencedFtaIrn && (
              <>
                {' '}
                (IRN <span className="font-mono text-xs">{data.referencedFtaIrn}</span>)
              </>
            )}
            {data.creditNoteReversalMode &&
              ` · ${REVERSAL_MODE_LABELS[data.creditNoteReversalMode]}`}
            {data.creditNoteReasonCode &&
              ` · ${data.creditNoteReasonCode} — ${REASON_CODE_LABELS[data.creditNoteReasonCode]}`}
          </p>
          {data.creditNoteNotes && <p className="mt-1 italic">{data.creditNoteNotes}</p>}
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Invoice" className="lg:col-span-2">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Detail label="Type" value={invoiceTypeLabel(data.invoiceType)} />
            <Detail label="Issue date" value={formatDate(data.issueDate)} />
            <Detail label="Issue time" value={data.issueTime} />
            <Detail label="Currency" value={data.currencyCode} />
            {data.currencyCode !== 'AED' && (
              <Detail label="Rate to AED" value={data.exchangeRate} />
            )}
            <Detail label="Peppol UUID" value={data.peppolUuid} mono />
            {/* SRS v2.7 §10.6 — the three network identifiers, held open on any
                document that has been sent even when they came back empty. An
                invoice the FTA rejected has no IRN, and that absence is the
                point: hiding the field made a rejected filing look like a
                document nobody had tried to file. */}
            {submitted && <Detail label="FTA IRN" value={data.ftaIrn} mono />}
            {submitted && <Detail label="Message status" value={data.mlsStatus} />}
            {data.poReference && <Detail label="PO reference" value={data.poReference} />}
          </dl>

          <div className="mt-5 grid gap-5 border-t border-slate-100 pt-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Supplier
              </h3>
              <p className="text-sm font-medium">{data.sellerName}</p>
              <p className="font-mono text-xs text-slate-500">{data.sellerTrn}</p>
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Buyer
              </h3>
              <p className="text-sm font-medium">{data.buyerName}</p>
              <p className="font-mono text-xs text-slate-500">
                {data.buyerTrn ?? 'No TRN (simplified invoice)'}
              </p>
              {data.buyerEmirate && <p className="text-xs text-slate-500">{data.buyerEmirate}</p>}
            </div>
          </div>
        </Card>

        <Card title="Totals">
          <dl className="space-y-2 text-sm">
            <Amount label="Net" value={data.lineExtensionAmount} currency={data.currencyCode} />
            <Amount
              label="Tax exclusive"
              value={data.taxExclusiveAmount}
              currency={data.currencyCode}
            />
            <Amount label="VAT" value={data.vatTotalAmount} currency={data.currencyCode} />
            <div className="border-t border-slate-200 pt-2">
              <Amount
                label="Payable"
                value={data.payableAmount}
                currency={data.currencyCode}
                strong
              />
            </div>
            {data.currencyCode !== 'AED' && (
              <Amount label="Payable (AED)" value={data.payableAmountAed} currency="AED" />
            )}
          </dl>

          {data.ublXmlSha256 && (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <p className="text-xs font-medium text-slate-500">Archived XML digest</p>
              <p className="break-all font-mono text-[10px] text-slate-400">{data.ublXmlSha256}</p>
            </div>
          )}
        </Card>
      </div>

      <DocumentLines lines={data.lines} />

      {data.findings.length > 0 && (
        <Card title="Validation history">
          <ul className="space-y-2">
            {data.findings.map((finding, index) => (
              <li key={index} className="flex gap-3 text-sm">
                <span
                  className={cx(
                    'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                    finding.severity === 'ERROR' || finding.severity === 'FATAL'
                      ? 'bg-danger-500'
                      : 'bg-warn-500',
                  )}
                />
                <span>
                  <span className="font-mono text-xs text-slate-500">{finding.ruleCode}</span>
                  {finding.cell && (
                    <span className="ml-2 font-mono text-xs text-slate-400">
                      {finding.sheet} · {finding.cell}
                    </span>
                  )}
                  <p className="text-slate-700">{finding.message}</p>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ResponseLog responses={data.responses} />

      <Card title="Transmission history">
        {data.transmissions.length === 0 ? (
          <p className="py-2 text-sm text-slate-500">Not yet transmitted.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="pb-2 font-medium">When</th>
                <th className="pb-2 font-medium">Provider</th>
                <th className="pb-2 font-medium">Attempt</th>
                <th className="pb-2 font-medium">Reference</th>
                <th className="pb-2 font-medium">Result</th>
                <th className="pb-2 text-right font-medium">Latency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.transmissions.map((log) => (
                <tr key={log.id}>
                  <td className="py-2 text-slate-600">{formatDateTime(log.createdAt)}</td>
                  <td className="py-2">{log.aspProvider}</td>
                  <td className="py-2 tabular-nums">{log.attempt}</td>
                  <td className="py-2 font-mono text-xs text-slate-500">
                    {log.transmissionReference ?? '—'}
                  </td>
                  <td className="py-2">
                    <span
                      className={cx(
                        'text-xs font-medium',
                        log.status === 'ACCEPTED'
                          ? 'text-ok-700'
                          : log.status === 'REJECTED' || log.status === 'FAILED'
                            ? 'text-danger-700'
                            : 'text-slate-600',
                      )}
                    >
                      {log.status}
                      {log.httpStatusCode ? ` (${log.httpStatusCode})` : ''}
                    </span>
                    {log.errorMessage && (
                      <p className="text-xs text-slate-500">{log.errorMessage}</p>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums text-slate-500">
                    {log.latencyMs ? `${log.latencyMs}ms` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {approvalOutcome && (
        <Alert kind={approvalOutcome.kind}>
          {approvalOutcome.text}{' '}
          <Link to={origin.to} className="font-medium underline">
            Back to {origin.label.toLowerCase()}
          </Link>
        </Alert>
      )}

      {/* Only the role that can file sees this, and only while the document is
          actually waiting. After a verdict the card goes and the status badge
          above carries the answer. */}
      {data.status === 'PENDING_CFO_APPROVAL' && canFile(user) && (
        <Card title="Waiting for your approval">
          <p className="text-sm text-slate-600">
            You are the only role that can release this invoice to the FTA. Returning it withdraws
            it and reopens the preparer's staged rows for correction.
          </p>

          <textarea
            className={`${inputClass} mt-3 h-20`}
            placeholder="Note (required when returning to the preparer)"
            value={approvalNote}
            onChange={(event) => setApprovalNote(event.target.value)}
          />

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={decide.isPending}
              onClick={() => decide.mutate('approve')}
            >
              {decide.isPending ? 'Working…' : 'Approve and file with the FTA'}
            </Button>
            <Button
              variant="danger"
              disabled={decide.isPending || approvalNote.trim().length === 0}
              onClick={() => decide.mutate('reject')}
              title={
                approvalNote.trim().length === 0
                  ? 'Give a reason so the preparer knows what to correct'
                  : undefined
              }
            >
              Return to preparer
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
