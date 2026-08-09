import type { DashboardResponse } from '@uae/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Spinner,
  StatusBadge,
  cx,
  formatDateTime,
} from '../../components/ui';
import { api } from '../../lib/api';

/**
 * The merchant landing page.
 *
 * Ordered by the question a finance user actually arrives with — "is anything
 * wrong?" — so the needs-attention block comes before the totals and the chart.
 */
export function DashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<DashboardResponse>('/api/v1/dashboard'),
    refetchInterval: 30_000,
  });

  if (isLoading || !data) {
    return (
      <div className="py-16">
        <Spinner label="Loading…" />
      </div>
    );
  }

  const attention =
    data.needsAttention.batchesWithErrors +
    data.needsAttention.rejectedInvoices +
    data.needsAttention.stuckTransmissions;

  const counts = data.counts ?? {};
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Dashboard</h1>
        <Link to="/upload">
          <Button variant="primary">Upload invoices</Button>
        </Link>
      </div>

      {!data.canSubmit && (
        <Alert kind="warn" title="Submissions are not yet available">
          Your account status is <StatusBadge status={data.tenantStatus} /> and your provider
          connection is <StatusBadge status={data.aspStatus} />. You can upload files and correct
          errors now; invoices can be submitted once activation completes.
        </Alert>
      )}

      {attention > 0 && (
        <Card title="Needs your attention">
          <div className="grid gap-3 sm:grid-cols-3">
            <AttentionTile
              count={data.needsAttention.batchesWithErrors}
              label="batches with errors"
              detail="Uploaded files containing invoices that failed validation."
              to="/batches"
              tone="danger"
            />
            <AttentionTile
              count={data.needsAttention.rejectedInvoices}
              label="rejected by the FTA"
              detail="These were not filed. Correct and resubmit them."
              to="/invoices?status=REJECTED_BY_FTA"
              tone="danger"
            />
            <AttentionTile
              count={data.needsAttention.stuckTransmissions}
              label="awaiting a verdict"
              detail="Sent over an hour ago with no response yet."
              to="/invoices?status=SUBMITTED_TO_ASP"
              tone="warn"
            />
          </div>
        </Card>
      )}

      <Card title="Invoices by status">
        {total === 0 ? (
          <EmptyState
            title="No invoices yet"
            description="Download the template, fill in your invoices, and upload the file."
            action={
              <Link to="/upload">
                <Button variant="primary">Get started</Button>
              </Link>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {(
              [
                'VALIDATED',
                'SUBMITTED_TO_ASP',
                'ACCEPTED_BY_FTA',
                'REJECTED_BY_FTA',
                'VALIDATION_FAILED',
                'ARCHIVED',
              ] as const
            ).map((status) => (
              <Link
                key={status}
                to={`/invoices?status=${status}`}
                className="rounded-lg border border-slate-200 p-3 transition-colors hover:border-brand-500 hover:bg-brand-50/40"
              >
                <div className="text-2xl font-semibold tabular-nums text-slate-900">
                  {(counts[status] ?? 0).toLocaleString()}
                </div>
                <StatusBadge status={status} className="mt-1" />
              </Link>
            ))}
          </div>
        )}
      </Card>

      {total > 0 && <ActivityChart data={data.last30Days} />}

      <Card
        title="Recent uploads"
        actions={
          <Link to="/batches" className="text-sm text-brand-600 underline">
            View all
          </Link>
        }
      >
        {data.recentBatches.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500">No uploads yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="pb-2 font-medium">Reference</th>
                <th className="pb-2 font-medium">File</th>
                <th className="pb-2 text-right font-medium">Invoices</th>
                <th className="pb-2 text-right font-medium">Errors</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Uploaded</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.recentBatches.map((batch) => (
                <tr key={batch.id} className="hover:bg-slate-50">
                  <td className="py-2">
                    <Link
                      to={`/batches/${batch.id}`}
                      className="font-medium text-brand-600 underline"
                    >
                      {batch.reference}
                    </Link>
                  </td>
                  <td className="py-2 text-slate-600">{batch.fileName}</td>
                  <td className="py-2 text-right tabular-nums">{batch.totalRecords}</td>
                  <td
                    className={cx(
                      'py-2 text-right tabular-nums',
                      batch.invalidRecords > 0 ? 'font-medium text-danger-700' : 'text-slate-400',
                    )}
                  >
                    {batch.invalidRecords}
                  </td>
                  <td className="py-2">
                    <StatusBadge status={batch.status} />
                  </td>
                  <td className="py-2 text-slate-500">{formatDateTime(batch.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function AttentionTile({
  count,
  label,
  detail,
  to,
  tone,
}: {
  count: number;
  label: string;
  detail: string;
  to: string;
  tone: 'danger' | 'warn';
}) {
  if (count === 0) return null;

  return (
    <Link
      to={to}
      className={cx(
        'block rounded-lg border p-3 transition-colors',
        tone === 'danger'
          ? 'border-danger-200 bg-danger-50 hover:bg-danger-50/70'
          : 'border-warn-200 bg-warn-50 hover:bg-warn-50/70',
      )}
    >
      <div
        className={cx(
          'text-2xl font-semibold tabular-nums',
          tone === 'danger' ? 'text-danger-700' : 'text-warn-700',
        )}
      >
        {count}
      </div>
      <div className="text-sm font-medium text-slate-800">{label}</div>
      <p className="mt-0.5 text-xs text-slate-600">{detail}</p>
    </Link>
  );
}

/**
 * A deliberately plain 30-day bar chart. No charting library: three series of
 * thirty values does not justify the dependency, and a hand-rolled version can
 * be made accessible and printable without fighting a framework.
 */
function ActivityChart({ data }: { data: DashboardResponse['last30Days'] }) {
  const max = Math.max(1, ...data.map((d) => d.submitted));

  return (
    <Card title="Last 30 days">
      <div className="flex items-end gap-1" style={{ height: 120 }}>
        {data.map((day) => {
          const height = (day.submitted / max) * 100;
          const acceptedShare = day.submitted > 0 ? (day.accepted / day.submitted) * height : 0;
          const rejectedShare = day.submitted > 0 ? (day.rejected / day.submitted) * height : 0;
          const pending = height - acceptedShare - rejectedShare;

          return (
            <div
              key={day.date}
              className="flex flex-1 flex-col justify-end"
              style={{ height: '100%' }}
              title={`${day.date}: ${day.submitted} submitted, ${day.accepted} accepted, ${day.rejected} rejected`}
            >
              {rejectedShare > 0 && (
                <div className="bg-danger-500" style={{ height: `${rejectedShare}%` }} />
              )}
              {pending > 0.5 && <div className="bg-warn-500" style={{ height: `${pending}%` }} />}
              {acceptedShare > 0 && (
                <div className="bg-ok-500" style={{ height: `${acceptedShare}%` }} />
              )}
              {day.submitted === 0 && <div className="h-px bg-slate-200" />}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex gap-4 text-xs text-slate-600">
        <Legend colour="bg-ok-500" label="Accepted" />
        <Legend colour="bg-warn-500" label="Awaiting verdict" />
        <Legend colour="bg-danger-500" label="Rejected" />
      </div>
    </Card>
  );
}

function Legend({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cx('inline-block h-2.5 w-2.5 rounded-sm', colour)} />
      {label}
    </span>
  );
}
