import { RESPONSE_CODE_LABELS, type InvoiceDetail } from '@uae/contracts';
import { formatAmount } from '@uae/domain';
import { Card, cx, formatDateTime } from './ui';

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
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className={cx('mt-0.5', mono && 'break-all font-mono text-xs')}>{value}</dd>
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
