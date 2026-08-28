import { useQuery } from '@tanstack/react-query';
import {
  AP_POSTING_LABELS,
  REASON_CODE_LABELS,
  RESPONSE_CODE_LABELS,
  type InvoiceDetail,
} from '@uae/contracts';
import { Link, useParams } from 'react-router-dom';
import { Amount, Detail, DocumentLines, ResponseLog } from '../../components/DocumentPanels';
import { PdfActions } from '../../components/PdfActions';
import {
  Alert,
  Button,
  Card,
  Spinner,
  StatusBadge,
  formatDate,
  formatDateTime,
  invoiceTypeLabel,
} from '../../components/ui';
import { api, apiBlob, downloadBlob } from '../../lib/api';
import { can, useAuthStore } from '../../stores/auth';

/**
 * A supplier's bill, on its own page (SRS v2.7 §12).
 *
 * The same document view as a sales invoice, read from the other end. Two
 * things genuinely differ and the rest is shared: the counterparty is the
 * supplier rather than the buyer, and the verdict on the face of it is *ours*
 * rather than the FTA's — a bill can be perfectly cleared and still be one this
 * desk refuses to pay.
 *
 * Read-only by design. Changing a verdict is the verification desk's job, and
 * duplicating those three buttons here would make it possible to accept a bill
 * from two places with two different sets of guards.
 */
export function PurchaseInvoiceDetailPage() {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const user = useAuthStore((s) => s.user);

  const { data, isLoading } = useQuery({
    queryKey: ['ap-document', invoiceId],
    queryFn: () => api<InvoiceDetail>(`/api/v1/invoices/${invoiceId}`),
  });

  if (isLoading || !data) {
    return (
      <div className="py-16">
        <Spinner label="Loading document…" />
      </div>
    );
  }

  const disputed = data.isCommercialDispute && !data.disputeResolved;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/ap/documents" className="text-sm text-brand-600 underline">
            ← All purchase documents
          </Link>
          <h1 className="mt-1 flex items-center gap-3 text-lg font-semibold text-slate-900">
            {data.invoiceNumber}
            <StatusBadge status={data.status} />
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {invoiceTypeLabel(data.invoiceType)} from {data.sellerName}
          </p>
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
          {can(user, 'ap.verify') && (
            <Link to={`/ap/inbox/${invoiceId}`}>
              <Button variant="primary">Open in verification desk</Button>
            </Link>
          )}
        </div>
      </div>

      {/* §12.3 — what this desk decided, and what it means for payment. */}
      {disputed && (
        <Alert
          kind={data.latestResponseCode === 'RE' ? 'danger' : 'warn'}
          title={`Returned to the supplier${
            data.latestResponseReasonCode
              ? ` · ${data.latestResponseReasonCode} — ${REASON_CODE_LABELS[data.latestResponseReasonCode]}`
              : ''
          }`}
        >
          <p>
            {data.latestResponseCode && RESPONSE_CODE_LABELS[data.latestResponseCode]} on{' '}
            {formatDateTime(data.disputeOpenedAt)}.
          </p>
          {data.latestResponseComment && (
            <p className="mt-1 italic">“{data.latestResponseComment}”</p>
          )}
          <p className="mt-2 text-xs">
            The input tax on this bill is not reclaimable until it is settled. What closes it is a
            corrected invoice or a credit note from the supplier.
          </p>
        </Alert>
      )}

      {data.latestResponseCode === 'AP' && (
        <Alert kind="ok" title="Accepted for payment">
          Approved{data.apReviewedByName ? ` by ${data.apReviewedByName}` : ''} on{' '}
          {formatDateTime(data.apReviewedAt)}.
          {data.latestResponseComment && (
            <span className="mt-1 block italic">“{data.latestResponseComment}”</span>
          )}
        </Alert>
      )}

      {!data.latestResponseCode && (
        <Alert kind="info" title="Not yet reviewed">
          Nobody has ruled on this bill. It is waiting on the verification desk.
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Document" className="lg:col-span-2">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Detail label="Type" value={invoiceTypeLabel(data.invoiceType)} />
            <Detail label="Issue date" value={formatDate(data.issueDate)} />
            <Detail label="Currency" value={data.currencyCode} />
            {data.currencyCode !== 'AED' && (
              <Detail label="Rate to AED" value={data.exchangeRate} />
            )}
            {data.peppolUuid && <Detail label="Peppol UUID" value={data.peppolUuid} mono />}
            {data.ftaIrn && <Detail label="FTA IRN" value={data.ftaIrn} mono />}
            <Detail label="PO reference" value={data.poReference || '—'} />
            <Detail label="GRN reference" value={data.grnReference || '—'} />
            <Detail label="Posting" value={AP_POSTING_LABELS[data.apPostingStatus]} />
          </dl>

          <div className="mt-5 grid gap-5 border-t border-slate-100 pt-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Supplier
              </h3>
              <p className="text-sm font-medium">{data.sellerName}</p>
              <p className="font-mono text-xs text-slate-500">{data.sellerTrn || 'No TRN'}</p>
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Billed to
              </h3>
              <p className="text-sm font-medium">{data.buyerName}</p>
              <p className="font-mono text-xs text-slate-500">{data.buyerTrn ?? '—'}</p>
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
            {/* The figure this desk is really here for: input tax is only
                reclaimable on a bill that has been accepted. */}
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

      <ResponseLog responses={data.responses} />
    </div>
  );
}
