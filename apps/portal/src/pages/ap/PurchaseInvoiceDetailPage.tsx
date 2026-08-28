import { useQuery } from '@tanstack/react-query';
import type { InvoiceDetail } from '@uae/contracts';
import { Link, useParams } from 'react-router-dom';
import { PurchaseDocumentBody, ResponseLog } from '../../components/DocumentPanels';
import { PdfActions } from '../../components/PdfActions';
import { Button, Spinner, StatusBadge, invoiceTypeLabel } from '../../components/ui';
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

      <PurchaseDocumentBody invoice={data} />

      <ResponseLog responses={data.responses} />
    </div>
  );
}
