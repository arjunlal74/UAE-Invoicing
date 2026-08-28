import {
  AP_POSTING_LABELS,
  REASON_CODE_LABELS,
  RESPONSE_CODE_LABELS,
  type InvoiceDetail,
} from '@uae/contracts';
import { formatAmount } from '@uae/domain';
import { Alert, Card, StatusBadge, cx, formatDate, formatDateTime, invoiceTypeLabel } from './ui';

/**
 * The parts of a document view that do not care which way it was travelling.
 *
 * A sales invoice we filed and a supplier's bill we received are the same
 * artefact seen from opposite ends: the same UBL, the same line items, the same
 * Peppol response log. What differs is the framing around them — who the
 * counterparty is, whose verdict matters, which actions are on offer — and that
 * stays on the two detail pages. Everything below is shared so a change to how
 * a line or a response reads happens once.
 */

export function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  /**
   * Null renders as a dash rather than the caller omitting the field. On a
   * filed document an empty identifier is itself the finding — an invoice the
   * FTA rejected has no IRN, and a row that simply is not there reads as though
   * nobody looked.
   */
  value: string | null | undefined;
  mono?: boolean;
}) {
  const empty = value === null || value === undefined || value === '';
  return (
    <div>
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd
        className={cx(
          'mt-0.5',
          mono && !empty && 'break-all font-mono text-xs',
          empty && 'text-slate-400',
        )}
      >
        {empty ? '—' : value}
      </dd>
    </div>
  );
}

export function Amount({
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

export function DocumentLines({ lines }: { lines: InvoiceDetail['lines'] }) {
  return (
    <Card title={`Line items (${lines.length})`}>
      <div className="overflow-x-auto">
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
            {lines.map((line) => (
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
      </div>
    </Card>
  );
}

/**
 * SRS v2.7 §11 — every Peppol response about this document, in either
 * direction. The transmission log records what our provider did with the
 * document; this records what the trading partner said about it, and the two
 * answer different questions.
 */
export function ResponseLog({ responses }: { responses: InvoiceDetail['responses'] }) {
  if (responses.length === 0) return null;

  return (
    <Card title="Peppol response log">
      <div className="overflow-x-auto">
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
            {responses.map((response) => (
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
      </div>
    </Card>
  );
}

/**
 * A supplier's bill, presented the one way.
 *
 * The verification desk and the purchase document page show the same document
 * for different reasons — one to rule on it, one to read or print it — and
 * before this they showed it differently: a cramped two-column list of eight
 * fields on the desk against a full document view on the page. The clerk who
 * accepted a bill and the auditor who later looked it up were reading what
 * appeared to be two different records.
 *
 * The verdict banner leads, because on an inbound document our own decision is
 * the fact that governs everything else: a bill can be perfectly cleared by the
 * FTA and still be one this desk refuses to pay.
 */
export function PurchaseDocumentBody({ invoice }: { invoice: InvoiceDetail }) {
  const disputed = invoice.isCommercialDispute && !invoice.disputeResolved;
  const ruledBy = invoice.apReviewedByName ? ` by ${invoice.apReviewedByName}` : '';

  return (
    <>
      {disputed && (
        <Alert
          kind={invoice.latestResponseCode === 'RE' ? 'danger' : 'warn'}
          title={`Returned to the supplier${
            invoice.latestResponseReasonCode
              ? ` · ${invoice.latestResponseReasonCode} — ${REASON_CODE_LABELS[invoice.latestResponseReasonCode]}`
              : ''
          }`}
        >
          <p>
            {invoice.latestResponseCode && RESPONSE_CODE_LABELS[invoice.latestResponseCode]}
            {ruledBy} on {formatDateTime(invoice.apReviewedAt ?? invoice.disputeOpenedAt)}.
          </p>
          {invoice.latestResponseComment && (
            <p className="mt-1 italic">“{invoice.latestResponseComment}”</p>
          )}
          <p className="mt-2 text-xs">
            The input tax on this bill is not reclaimable until it is settled. What closes it is a
            corrected invoice or a credit note from the supplier.
          </p>
        </Alert>
      )}

      {invoice.latestResponseCode === 'AP' && (
        <Alert kind="ok" title="Accepted for payment">
          Approved{ruledBy} on {formatDateTime(invoice.apReviewedAt)}.
          {invoice.latestResponseComment && (
            <span className="mt-1 block italic">“{invoice.latestResponseComment}”</span>
          )}
        </Alert>
      )}

      {!invoice.latestResponseCode && (
        <Alert kind="info" title="Not yet reviewed">
          Nobody has ruled on this bill. Input tax on it cannot be claimed until it is accepted.
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Document" className="lg:col-span-2">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Detail label="Type" value={invoiceTypeLabel(invoice.invoiceType)} />
            <Detail label="Issue date" value={formatDate(invoice.issueDate)} />
            <Detail label="Currency" value={invoice.currencyCode} />
            {invoice.currencyCode !== 'AED' && (
              <Detail label="Rate to AED" value={invoice.exchangeRate} />
            )}
            {invoice.peppolUuid && <Detail label="Peppol UUID" value={invoice.peppolUuid} mono />}
            <Detail label="FTA IRN" value={invoice.ftaIrn ?? 'Not supplied'} mono />
            <Detail label="PO reference" value={invoice.poReference || '—'} />
            <Detail label="GRN reference" value={invoice.grnReference || '—'} />
            <Detail label="Posting" value={AP_POSTING_LABELS[invoice.apPostingStatus]} />
          </dl>

          <div className="mt-5 grid gap-5 border-t border-slate-100 pt-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Supplier
              </h3>
              <p className="text-sm font-medium">
                {invoice.supplierName ?? invoice.sellerName}
                {invoice.supplierIsProvisional && (
                  <span className="ml-2 rounded-full bg-warn-50 px-2 py-0.5 text-xs font-normal text-warn-700">
                    unvetted
                  </span>
                )}
              </p>
              <p className="font-mono text-xs text-slate-500">{invoice.sellerTrn || 'No TRN'}</p>
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Billed to
              </h3>
              <p className="text-sm font-medium">{invoice.buyerName}</p>
              <p className="font-mono text-xs text-slate-500">{invoice.buyerTrn ?? '—'}</p>
              {invoice.buyerEmirate && (
                <p className="text-xs text-slate-500">{invoice.buyerEmirate}</p>
              )}
            </div>
          </div>
        </Card>

        <Card title="Totals">
          <dl className="space-y-2 text-sm">
            <Amount label="Net" value={invoice.lineExtensionAmount} currency={invoice.currencyCode} />
            <Amount
              label="Tax exclusive"
              value={invoice.taxExclusiveAmount}
              currency={invoice.currencyCode}
            />
            {/* The figure this desk is really here for: input tax is only
                reclaimable on a bill that has been accepted. */}
            <Amount label="VAT" value={invoice.vatTotalAmount} currency={invoice.currencyCode} />
            <div className="border-t border-slate-200 pt-2">
              <Amount
                label="Payable"
                value={invoice.payableAmount}
                currency={invoice.currencyCode}
                strong
              />
            </div>
            {invoice.currencyCode !== 'AED' && (
              <Amount label="Payable (AED)" value={invoice.payableAmountAed} currency="AED" />
            )}
          </dl>

          <div className="mt-4 border-t border-slate-100 pt-3">
            <p className="text-xs font-medium text-slate-500">Clearance</p>
            <StatusBadge status={invoice.status} className="mt-1" />
          </div>

          {invoice.ublXmlSha256 && (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <p className="text-xs font-medium text-slate-500">Archived XML digest</p>
              <p className="break-all font-mono text-[10px] text-slate-400">
                {invoice.ublXmlSha256}
              </p>
            </div>
          )}
        </Card>
      </div>

      <DocumentLines lines={invoice.lines} />
    </>
  );
}
