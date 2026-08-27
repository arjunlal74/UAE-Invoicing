import {
  REASON_CODE_LABELS,
  RESPONSE_CODE_LABELS,
  REVERSAL_MODE_LABELS,
  type InvoiceDetail,
} from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatAmount } from '@uae/domain';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
} from '../../components/ui';
import { ApiError, api, apiBlob, downloadBlob } from '../../lib/api';
import { canEdit, canFile, useAuthStore } from '../../stores/auth';

export function InvoiceDetailPage() {
  const { invoiceId = '' } = useParams();
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: () => api<InvoiceDetail>(`/api/v1/invoices/${invoiceId}`),
    refetchInterval: (query) =>
      query.state.data?.status === 'SUBMITTED_TO_ASP' ? 5_000 : false,
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

  const canRetry =
    canFile(user) && (data.status === 'REJECTED_BY_FTA' || data.status === 'VALIDATION_FAILED');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/invoices" className="text-sm text-brand-600 underline">
            ← All invoices
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
            to={`/invoices/${data.correctiveCreditNoteId}`}
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
              <Link to={`/invoices/${data.referencedInvoiceId}`} className="font-medium underline">
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
            <Detail label="Type" value={data.invoiceType.replace(/_/g, ' ').toLowerCase()} />
            <Detail label="Issue date" value={formatDate(data.issueDate)} />
            <Detail label="Issue time" value={data.issueTime} />
            <Detail label="Currency" value={data.currencyCode} />
            {data.currencyCode !== 'AED' && (
              <Detail label="Rate to AED" value={data.exchangeRate} />
            )}
            <Detail label="Peppol UUID" value={data.peppolUuid} mono />
            {/* SRS v2.7 §10.6 — the identifier the FTA issued, and the one an
                auditor or a buyer's AP desk will search on. */}
            {data.ftaIrn && <Detail label="FTA IRN" value={data.ftaIrn} mono />}
            {data.mlsStatus && <Detail label="Message status" value={data.mlsStatus} />}
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

      <Card title={`Line items (${data.lines.length})`}>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="pb-2 font-medium">#</th>
              <th className="pb-2 font-medium">Description</th>
              <th className="pb-2 text-right font-medium">Qty</th>
              <th className="pb-2 font-medium">UOM</th>
              <th className="pb-2 text-right font-medium">Unit price</th>
              <th className="pb-2 text-right font-medium">Discount</th>
              <th className="pb-2 font-medium">VAT</th>
              <th className="pb-2 text-right font-medium">Net</th>
              <th className="pb-2 text-right font-medium">VAT amt</th>
              <th className="pb-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.lines.map((line) => (
              <tr key={line.id}>
                <td className="py-2 text-slate-400">{line.lineNumber}</td>
                <td className="py-2">{line.description}</td>
                <td className="py-2 text-right tabular-nums">{line.quantity}</td>
                <td className="py-2 text-slate-500">{line.uom}</td>
                <td className="py-2 text-right tabular-nums">{formatAmount(line.unitPrice)}</td>
                <td className="py-2 text-right tabular-nums text-slate-500">
                  {formatAmount(line.lineDiscount)}
                </td>
                <td className="py-2 text-xs text-slate-500">
                  {line.vatCategory} · {line.vatRate}%
                </td>
                <td className="py-2 text-right tabular-nums">{formatAmount(line.netAmount)}</td>
                <td className="py-2 text-right tabular-nums">{formatAmount(line.vatAmount)}</td>
                <td className="py-2 text-right font-medium tabular-nums">
                  {formatAmount(line.lineTotal)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

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

      {/* SRS v2.7 §11 — every Peppol response about this document, in either
          direction. The transmission log below records what our provider did
          with the invoice; this records what the trading partner said about it,
          and the two answer different questions. */}
      {data.responses.length > 0 && (
        <Card title="Peppol response log">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="pb-2 font-medium">Received</th>
                <th className="pb-2 font-medium">Direction</th>
                <th className="pb-2 font-medium">Code</th>
                <th className="pb-2 font-medium">Reason</th>
                <th className="pb-2 font-medium">Comment</th>
                <th className="pb-2 font-medium">Delivery</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.responses.map((response) => (
                <tr key={response.id}>
                  <td className="py-2 text-slate-500">{formatDateTime(response.receivedAt)}</td>
                  <td className="py-2 text-slate-600">
                    {response.responseDirection === 'INBOUND_FROM_BUYER'
                      ? 'From buyer'
                      : `To supplier${response.createdByName ? ` · ${response.createdByName}` : ''}`}
                  </td>
                  <td className="py-2">
                    <span className="font-medium text-slate-800">{response.responseCode}</span>{' '}
                    <span className="text-slate-500">
                      {RESPONSE_CODE_LABELS[response.responseCode]}
                    </span>
                  </td>
                  <td className="py-2 text-slate-600">
                    {response.statusReasonCode
                      ? `${response.statusReasonCode}${response.isTechnical ? ' (technical)' : ''}`
                      : '—'}
                  </td>
                  <td className="max-w-xs truncate py-2 text-slate-600">
                    {response.comments ?? '—'}
                  </td>
                  <td className="py-2 text-xs">
                    {response.responseDirection === 'INBOUND_FROM_BUYER' ? (
                      <span className="text-slate-400">received</span>
                    ) : response.transmittedAt ? (
                      <span className="text-ok-700">
                        delivered {formatDateTime(response.transmittedAt)}
                      </span>
                    ) : (
                      <span className="text-warn-700">
                        {response.transmissionError ?? 'awaiting delivery'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

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
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className={cx('mt-0.5', mono && 'break-all font-mono text-xs')}>{value}</dd>
    </div>
  );
}

function Amount({
  label,
  value,
  currency,
  strong,
}: {
  label: string;
  value: string;
  currency: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={cx('text-slate-600', strong && 'font-medium text-slate-900')}>{label}</dt>
      <dd className={cx('tabular-nums', strong ? 'text-base font-semibold' : 'text-slate-700')}>
        {formatAmount(value)} <span className="text-xs text-slate-400">{currency}</span>
      </dd>
    </div>
  );
}
