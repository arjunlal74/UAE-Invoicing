import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  REASON_CODE_LABELS,
  RESPONSE_CODE_LABELS,
  RejectionReasonCode,
  type ApDecisionResponse,
  type DocumentListItem,
  type InvoiceDetail,
  type ResponseStatusCode,
} from '@uae/contracts';
import { formatAmount } from '@uae/domain';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  PageHeader,
  Pagination,
  Spinner,
  StatTile,
  StatusBadge,
  cx,
  formatDate,
  formatDateTime,
  inputClass,
} from '../../components/ui';
import { ApiError, api, apiBlob, downloadBlob, queryString } from '../../lib/api';
import { can, useAuthStore } from '../../stores/auth';

/**
 * The Inbound Purchase Verification Desk (SRS v2.7 §12.2).
 *
 * A master/detail queue: the inbox on the left, the selected supplier bill on
 * the right, and the three verdicts of §12.3 at the bottom of the pane. The
 * layout follows the wireframe, and so does the ordering of the actions —
 * accept, query, reject — because accept is the hundred-times-a-day path and
 * reject is the rare one.
 */

interface InboxResponse {
  items: DocumentListItem[];
  summary: {
    total: number;
    needsReview: number;
    accepted: number;
    disputed: number;
    unmatched: number;
  };
  total: number;
  page: number;
  pageSize: number;
}

export function ApInboxPage() {
  const { invoiceId } = useParams<{ invoiceId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [decision, setDecision] = useState<ResponseStatusCode | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'danger'; text: string } | null>(null);

  const filters = {
    q: searchParams.get('q') ?? '',
    status: searchParams.get('status') ?? '',
    match: searchParams.get('match') ?? '',
    supplierId: searchParams.get('supplierId') ?? '',
  };

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
    setPage(1);
  };

  const pageSize = 25;
  const { data, isLoading } = useQuery({
    queryKey: ['ap-inbox', filters, page],
    queryFn: () =>
      api<InboxResponse>(`/api/v1/ap/invoices${queryString({ ...filters, page, pageSize })}`),
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['ap-invoice', invoiceId],
    queryFn: () => api<InvoiceDetail>(`/api/v1/invoices/${invoiceId}`),
    enabled: Boolean(invoiceId),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['ap-inbox'] });
    void queryClient.invalidateQueries({ queryKey: ['ap-invoice'] });
    setSelected([]);
  };

  const autoMatch = useMutation({
    mutationFn: () => api<{ flagged: number; message: string }>('/api/v1/ap/auto-match', { method: 'POST' }),
    onSuccess: (result) => {
      setBanner({ kind: 'ok', text: result.message });
      refresh();
    },
  });

  const target = invoiceId ? [invoiceId] : selected;
  const canDecide = can(user, 'ap.verify');

  const bannerAlert = banner && (
    <Alert kind={banner.kind === 'ok' ? 'ok' : 'danger'}>{banner.text}</Alert>
  );

  const decisionDialog = decision && (
    <DecisionDialog
      code={decision}
      invoiceIds={target}
      onClose={() => setDecision(null)}
      onDone={(result) => {
        setDecision(null);
        setBanner({
          kind: result.affected > 0 ? 'ok' : 'danger',
          text:
            result.affected > 0
              ? `${result.affected} invoice${result.affected === 1 ? '' : 's'} updated and the supplier notified.`
              : (result.reasons[0]?.reason ?? 'Nothing was changed.'),
        });
        refresh();
      }}
    />
  );

  // A selected invoice takes the whole page rather than half of it. Ruling on a
  // bill means reading its line items against a purchase order, and a column
  // beside the queue was never wide enough for that; the queue is one click
  // away and nothing is gained by keeping it in view while you read.
  if (invoiceId) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link to="/ap/inbox" className="text-sm text-brand-600 underline">
            ← Back to the queue
          </Link>
          <Link to={`/ap/documents/${invoiceId}`} className="text-sm text-brand-600 underline">
            Open as a document
          </Link>
        </div>

        {bannerAlert}

        {detailLoading || !detail ? (
          <Card>
            <Spinner label="Loading invoice…" />
          </Card>
        ) : (
          <VerificationPane
            invoice={detail}
            canDecide={canDecide}
            canAccept={can(user, 'ap.post')}
            onDecision={setDecision}
            onChanged={refresh}
          />
        )}

        {decisionDialog}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Purchase verification desk"
        description="Cleared supplier invoices received over the FTA Peppol network."
        actions={
          <>
            {canDecide && (
              <>
                <Button onClick={() => setReceiving(true)}>Receive XML</Button>
                <Button onClick={() => autoMatch.mutate()} disabled={autoMatch.isPending}>
                  Auto-match POs
                </Button>
              </>
            )}
          </>
        }
      />

      {bannerAlert}

      {data && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatTile label="Total inbound" value={data.summary.total} />
          <StatTile
            label="Needs review"
            value={data.summary.needsReview}
            tone={data.summary.needsReview > 0 ? 'warn' : 'neutral'}
            onClick={() => setFilter('status', '')}
          />
          <StatTile label="Accepted" value={data.summary.accepted} tone="ok" />
          <StatTile
            label="Queried or rejected"
            value={data.summary.disputed}
            tone={data.summary.disputed > 0 ? 'danger' : 'neutral'}
          />
          <StatTile
            label="No PO reference"
            value={data.summary.unmatched}
            tone={data.summary.unmatched > 0 ? 'warn' : 'neutral'}
            onClick={() => setFilter('match', 'unmatched')}
          />
        </div>
      )}

      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input
            className={inputClass}
            placeholder="Invoice number, supplier, TRN or PO…"
            defaultValue={filters.q}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setFilter('q', (e.target as HTMLInputElement).value);
            }}
            onBlur={(e) => setFilter('q', e.target.value)}
          />
          <select
            className={inputClass}
            value={filters.match}
            onChange={(e) => setFilter('match', e.target.value)}
          >
            <option value="">Any PO state</option>
            <option value="matched">Has a PO reference</option>
            <option value="unmatched">No PO reference</option>
          </select>
          <select
            className={inputClass}
            value={filters.status}
            onChange={(e) => setFilter('status', e.target.value)}
          >
            <option value="">Any status</option>
            <option value="ACCEPTED_BY_FTA">Awaiting review</option>
            <option value="ACCEPTED_BY_BUYER">Accepted</option>
            <option value="UNDER_QUERY">Under query</option>
            <option value="REJECTED_COMMERCIAL">Rejected</option>
          </select>
          {(filters.q || filters.match || filters.status || filters.supplierId) && (
            <Button onClick={() => setSearchParams({}, { replace: true })}>Clear filters</Button>
          )}
        </div>
      </Card>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-6">
            <Spinner label="Loading inbox…" />
          </div>
        ) : !data?.items.length ? (
          <EmptyState
            title="Nothing in the inbox"
            description="Supplier invoices appear here as soon as they are delivered through your provider."
          />
        ) : (
          <>
            {selected.length > 0 && canDecide && (
              <div className="flex items-center justify-between border-b border-slate-200 bg-brand-50 px-4 py-2 text-sm">
                <span className="text-brand-800">
                  {selected.length} selected
                </span>
                <div className="flex gap-2">
                  {can(user, 'ap.post') && (
                    <Button size="sm" variant="primary" onClick={() => setDecision('AP')}>
                      Accept
                    </Button>
                  )}
                  <Button size="sm" onClick={() => setDecision('UQ')}>
                    Query
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setDecision('RE')}>
                    Reject
                  </Button>
                </div>
              </div>
            )}

            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  {canDecide && <th className="w-8 px-3 py-2" />}
                  <th className="px-3 py-2 font-medium">Invoice</th>
                  <th className="px-3 py-2 font-medium">Supplier</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2 font-medium">PO</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((item) => (
                  <tr
                    key={item.id}
                    onClick={() => navigate(`/ap/inbox/${item.id}`)}
                    className={cx(
                      'cursor-pointer hover:bg-slate-50',
                      item.id === invoiceId && 'bg-brand-50/60',
                    )}
                  >
                    {canDecide && (
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.includes(item.id)}
                          disabled={item.latestResponseCode !== null}
                          onChange={(e) =>
                            setSelected((current) =>
                              e.target.checked
                                ? [...current, item.id]
                                : current.filter((id) => id !== item.id),
                            )
                          }
                        />
                      </td>
                    )}
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800">{item.invoiceNumber}</div>
                      <div className="text-xs text-slate-500">{formatDate(item.issueDate)}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5 text-slate-700">
                        {item.counterpartyName}
                        {item.supplierIsProvisional && (
                          <span
                            title="Supplier created automatically and not yet vetted"
                            className="rounded-full bg-warn-100 px-1.5 text-xs text-warn-700"
                          >
                            new
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-xs text-slate-400">
                        {item.counterpartyTrn ?? '—'}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-800">
                      {item.currencyCode} {formatAmount(item.payableAmount)}
                    </td>
                    <td className="px-3 py-2">
                      {item.poReference ? (
                        <span className="font-mono text-xs text-slate-600">
                          {item.poReference}
                        </span>
                      ) : (
                        <span className="text-xs text-warn-700">⚠ none</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {item.latestResponseCode ? (
                        <StatusBadge status={item.status} />
                      ) : (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                          Unreviewed
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <Pagination page={page} pageSize={pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </div>

      {decisionDialog}

      {receiving && (
        <ReceiveDialog
          onClose={() => setReceiving(false)}
          onDone={(id) => {
            setReceiving(false);
            refresh();
            navigate(`/ap/inbox/${id}`);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function VerificationPane({
  invoice,
  canDecide,
  canAccept,
  onDecision,
  onChanged,
}: {
  invoice: InvoiceDetail;
  canDecide: boolean;
  canAccept: boolean;
  onDecision: (code: ResponseStatusCode) => void;
  onChanged: () => void;
}) {
  const [po, setPo] = useState(invoice.poReference ?? '');
  const [grn, setGrn] = useState(invoice.grnReference ?? '');

  const ruled = invoice.latestResponseCode !== null;

  const match = useMutation({
    mutationFn: () =>
      api(`/api/v1/ap/invoices/${invoice.id}/match`, {
        method: 'PATCH',
        body: { poReference: po || null, grnReference: grn || null },
      }),
    onSuccess: onChanged,
  });

  const downloadXml = async () => {
    const { blob, filename } = await apiBlob(`/api/v1/invoices/${invoice.id}/xml`);
    downloadBlob(blob, filename);
  };

  const warnings = invoice.findings.filter((f) => f.ruleCode === 'AP-RECEPTION');

  return (
    <div className="space-y-4">
      <Card
        title={invoice.invoiceNumber}
        actions={
          invoice.ublXmlUri && (
            <Button size="sm" onClick={downloadXml}>
              View UBL XML
            </Button>
          )
        }
      >
        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">Supplier</dt>
          <dd className="text-slate-800">
            {invoice.supplierName ?? invoice.sellerName}
            {invoice.supplierIsProvisional && (
              <span className="ml-2 rounded-full bg-warn-50 px-2 py-0.5 text-xs text-warn-700">
                unvetted
              </span>
            )}
          </dd>
          <dt className="text-slate-500">Supplier TRN</dt>
          <dd className="font-mono text-xs text-slate-800">{invoice.sellerTrn || '—'}</dd>
          <dt className="text-slate-500">FTA IRN</dt>
          <dd className="font-mono text-xs text-slate-800">{invoice.ftaIrn ?? 'Not supplied'}</dd>
          <dt className="text-slate-500">Issued</dt>
          <dd className="text-slate-800">{formatDate(invoice.issueDate)}</dd>
          <dt className="text-slate-500">Tax exclusive</dt>
          <dd className="tabular-nums text-slate-800">
            {invoice.currencyCode} {formatAmount(invoice.taxExclusiveAmount)}
          </dd>
          <dt className="text-slate-500">VAT</dt>
          <dd className="tabular-nums text-slate-800">
            {invoice.currencyCode} {formatAmount(invoice.vatTotalAmount)}
          </dd>
          <dt className="text-slate-500">Total payable</dt>
          <dd className="font-semibold tabular-nums text-slate-900">
            {invoice.currencyCode} {formatAmount(invoice.payableAmount)}
          </dd>
          <dt className="text-slate-500">AP posting</dt>
          <dd>
            <StatusBadge status={invoice.apPostingStatus} />
          </dd>
        </dl>
      </Card>

      {warnings.length > 0 && (
        <Alert kind="warn" title="Reception checks">
          <ul className="list-disc space-y-1 pl-4">
            {warnings.map((warning, index) => (
              <li key={index}>{warning.message}</li>
            ))}
          </ul>
        </Alert>
      )}

      <Card title="Line items">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-1.5 font-medium">Description</th>
                <th className="px-2 py-1.5 text-right font-medium">Qty</th>
                <th className="px-2 py-1.5 text-right font-medium">Unit</th>
                <th className="px-2 py-1.5 text-right font-medium">VAT</th>
                <th className="px-2 py-1.5 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invoice.lines.map((line) => (
                <tr key={line.id}>
                  <td className="px-2 py-1.5 text-slate-800">{line.description}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                    {line.quantity} {line.uom}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                    {formatAmount(line.unitPrice)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                    {line.vatRate}%
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-800">
                    {formatAmount(line.lineTotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Purchase order verification">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="PO reference">
            <input
              className={inputClass}
              value={po}
              disabled={ruled}
              onChange={(e) => setPo(e.target.value)}
            />
          </Field>
          <Field label="Goods receipt note">
            <input
              className={inputClass}
              value={grn}
              disabled={ruled}
              onChange={(e) => setGrn(e.target.value)}
            />
          </Field>
        </div>
        {!ruled && (
          <div className="mt-3">
            <Button size="sm" onClick={() => match.mutate()} disabled={match.isPending}>
              Save references
            </Button>
          </div>
        )}
      </Card>

      {/* --- §12.3 the verdict ------------------------------------------- */}
      {ruled ? (
        <Card title="Verdict">
          <div className="space-y-2 text-sm">
            <p>
              <StatusBadge status={invoice.status} />{' '}
              <span className="ml-2 text-slate-600">
                {invoice.latestResponseCode &&
                  RESPONSE_CODE_LABELS[invoice.latestResponseCode]}
                {invoice.latestResponseReasonCode &&
                  ` · ${invoice.latestResponseReasonCode} — ${REASON_CODE_LABELS[invoice.latestResponseReasonCode]}`}
              </span>
            </p>
            {invoice.latestResponseComment && (
              <p className="italic text-slate-600">“{invoice.latestResponseComment}”</p>
            )}
            <p className="text-xs text-slate-500">
              Ruled by {invoice.apReviewedByName ?? 'a colleague'} on{' '}
              {formatDateTime(invoice.apReviewedAt)}.
            </p>

            {invoice.responses.length > 0 && (
              <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500">
                {invoice.responses.map((response) => (
                  <li key={response.id}>
                    {formatDateTime(response.receivedAt)} · {response.responseCode}
                    {response.statusReasonCode ? ` (${response.statusReasonCode})` : ''} ·{' '}
                    {response.transmittedAt
                      ? 'delivered to supplier'
                      : (response.transmissionError ?? 'awaiting delivery')}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      ) : (
        canDecide && (
          <Card title="Action">
            <p className="mb-3 text-sm text-slate-600">
              Your verdict is sent to the supplier as a Peppol invoice response. Input tax cannot be
              claimed until the invoice is accepted.
            </p>
            <div className="flex flex-wrap gap-2">
              {canAccept ? (
                <Button variant="primary" onClick={() => onDecision('AP')}>
                  Accept &amp; post to ERP
                </Button>
              ) : (
                <Button variant="primary" disabled title="Reserved to your tax approver">
                  Accept &amp; post to ERP
                </Button>
              )}
              <Button onClick={() => onDecision('UQ')}>Put under query</Button>
              <Button variant="danger" onClick={() => onDecision('RE')}>
                Reject invoice
              </Button>
            </div>
            {!canAccept && (
              <p className="mt-2 text-xs text-slate-500">
                Accepting releases the invoice for payment, which is reserved to your tax approver.
              </p>
            )}
          </Card>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function DecisionDialog({
  code,
  invoiceIds,
  onClose,
  onDone,
}: {
  code: ResponseStatusCode;
  invoiceIds: string[];
  onClose: () => void;
  onDone: (result: ApDecisionResponse) => void;
}) {
  const [reasonCode, setReasonCode] = useState<RejectionReasonCode>('PRI');
  const [isTechnical, setIsTechnical] = useState(false);
  const [comments, setComments] = useState('');
  const [error, setError] = useState<string | null>(null);

  const decide = useMutation({
    mutationFn: () =>
      api<ApDecisionResponse>('/api/v1/ap/decision', {
        method: 'POST',
        body: {
          invoiceIds,
          responseCode: code,
          reasonCode: code === 'RE' ? reasonCode : undefined,
          isTechnical: code === 'RE' ? isTechnical : false,
          comments: comments || undefined,
        },
      }),
    onSuccess: onDone,
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'The verdict could not be recorded.'),
  });

  const titles: Record<string, string> = {
    AP: 'Accept and post to ERP',
    UQ: 'Put under query',
    RE: 'Reject invoice',
  };

  const needsComment = code !== 'AP';

  return (
    <Modal
      title={`${titles[code]} · ${invoiceIds.length} invoice${invoiceIds.length === 1 ? '' : 's'}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={code === 'RE' ? 'danger' : 'primary'}
            disabled={decide.isPending || (needsComment && !comments.trim())}
            onClick={() => decide.mutate()}
          >
            {decide.isPending ? 'Sending…' : `Send ${code} to supplier`}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Alert kind="danger">{error}</Alert>}

        {code === 'AP' && (
          <Alert kind="info">
            This releases the invoice for payment and makes its input VAT claimable on your next
            return.
          </Alert>
        )}

        {code === 'RE' && (
          <>
            <Field label="Rejection type" required>
              <div className="space-y-1 pt-1">
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    checked={!isTechnical}
                    onChange={() => setIsTechnical(false)}
                    className="mt-1"
                  />
                  <span>
                    <strong>Commercial</strong> — a disagreement about the trade: price, quantity,
                    the wrong item, a delivery that did not happen.
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    checked={isTechnical}
                    onChange={() => {
                      setIsTechnical(true);
                      setReasonCode('NON');
                    }}
                    className="mt-1"
                  />
                  <span>
                    <strong>Technical</strong> — the document itself is wrong: malformed XML, an
                    incorrect TRN, missing mandatory data.
                  </span>
                </label>
              </div>
            </Field>

            <Field label="Reason code" required>
              <select
                className={inputClass}
                value={reasonCode}
                onChange={(e) => setReasonCode(e.target.value as RejectionReasonCode)}
              >
                {RejectionReasonCode.options.map((option) => (
                  <option key={option} value={option}>
                    {option} — {REASON_CODE_LABELS[option]}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}

        {code === 'UQ' && (
          <Field label="Reason code">
            <select
              className={inputClass}
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value as RejectionReasonCode)}
            >
              {RejectionReasonCode.options.map((option) => (
                <option key={option} value={option}>
                  {option} — {REASON_CODE_LABELS[option]}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field
          label="Message to the supplier"
          required={needsComment}
          hint="Sent verbatim inside the Peppol response, so write it for them to act on."
        >
          <textarea
            className={inputClass}
            rows={3}
            value={comments}
            onChange={(e) => setComments(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

/**
 * Manual reception.
 *
 * The normal path is the provider webhook; this exists because a document that
 * arrived out of band still has to be receivable, and because it makes the
 * whole module exercisable before an ASP contract is in place.
 */
function ReceiveDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (invoiceId: string) => void;
}) {
  const [xml, setXml] = useState('');
  const [ftaIrn, setFtaIrn] = useState('');
  const [error, setError] = useState<string | null>(null);

  const receive = useMutation({
    mutationFn: () =>
      api<{ id: string; duplicate: boolean; warnings: string[] }>(
        '/api/v1/ap/invoices/receive',
        { method: 'POST', body: { ublXml: xml, ftaIrn: ftaIrn || undefined } },
      ),
    onSuccess: (result) => onDone(result.id),
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That document could not be read.'),
  });

  return (
    <Modal
      title="Receive a purchase invoice"
      onClose={onClose}
      width="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!xml.trim() || receive.isPending}
            onClick={() => receive.mutate()}
          >
            {receive.isPending ? 'Reading…' : 'Receive invoice'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Alert kind="danger">{error}</Alert>}
        <Alert kind="info">
          Paste a cleared UBL 2.1 invoice as delivered by the supplier&apos;s provider. The supplier
          is matched by TRN, and one is created for you if this is their first invoice.
        </Alert>

        <Field label="UBL 2.1 XML" required>
          <textarea
            className={`${inputClass} font-mono text-xs`}
            rows={12}
            value={xml}
            placeholder="<Invoice xmlns=…>"
            onChange={(e) => setXml(e.target.value)}
          />
        </Field>

        <Field label="FTA IRN" hint="Only needed when the document does not carry one itself.">
          <input className={inputClass} value={ftaIrn} onChange={(e) => setFtaIrn(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
