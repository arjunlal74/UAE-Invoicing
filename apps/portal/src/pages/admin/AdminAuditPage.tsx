import type { AuditLogItem, PaginatedResult, TenantSummary } from '@uae/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Card,
  EmptyState,
  Pagination,
  Spinner,
  formatDateTime,
  inputClass,
} from '../../components/ui';
import { api, queryString } from '../../lib/api';

const ACTIONS = [
  'TENANT_CREATED',
  'TENANT_UPDATED',
  'TENANT_STATUS_CHANGED',
  'USER_INVITED',
  'USER_LOGIN',
  'ASP_CONFIG_UPDATED',
  'BATCH_UPLOADED',
  'BATCH_SUBMITTED',
  'STAGING_ROW_EDITED',
  'INVOICE_SUBMITTED',
  'INVOICE_STATUS_CHANGED',
];

export function AdminAuditPage() {
  const [filters, setFilters] = useState({ tenantId: '', action: '', dateFrom: '', dateTo: '' });
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const pageSize = 50;

  const { data: tenants } = useQuery({
    queryKey: ['admin-tenants-lookup'],
    queryFn: () => api<PaginatedResult<TenantSummary>>('/api/v1/admin/tenants'),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['admin-audit', filters, page],
    queryFn: () =>
      api<PaginatedResult<AuditLogItem>>(
        `/api/v1/admin/audit${queryString({ ...filters, page, pageSize })}`,
      ),
  });

  const update = (key: string, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  };

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">Audit log</h1>

      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <select
            className={inputClass}
            value={filters.tenantId}
            onChange={(e) => update('tenantId', e.target.value)}
          >
            <option value="">All tenants</option>
            {tenants?.items.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.legalNameEn}
              </option>
            ))}
          </select>

          <select
            className={inputClass}
            value={filters.action}
            onChange={(e) => update('action', e.target.value)}
          >
            <option value="">All actions</option>
            {ACTIONS.map((action) => (
              <option key={action} value={action}>
                {action.replace(/_/g, ' ').toLowerCase()}
              </option>
            ))}
          </select>

          <input
            className={inputClass}
            type="date"
            value={filters.dateFrom}
            onChange={(e) => update('dateFrom', e.target.value)}
          />
          <input
            className={inputClass}
            type="date"
            value={filters.dateTo}
            onChange={(e) => update('dateTo', e.target.value)}
          />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          The audit trail is append-only — the application has no privilege to update or delete
          these rows.
        </p>
      </Card>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-8">
            <Spinner label="Loading…" />
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState title="No audit entries match these filters" />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Actor</th>
                  <th className="px-4 py-2 font-medium">Action</th>
                  <th className="px-4 py-2 font-medium">Resource</th>
                  <th className="px-4 py-2 font-medium">Tenant</th>
                  <th className="px-4 py-2 font-medium">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((entry) => (
                  <>
                    <tr
                      key={entry.id}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                    >
                      <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                        {formatDateTime(entry.createdAt)}
                      </td>
                      <td className="px-4 py-2">
                        {entry.actorName ?? '—'}
                        <span className="block text-xs text-slate-400">{entry.actorType}</span>
                      </td>
                      <td className="px-4 py-2 font-medium">
                        {entry.action.replace(/_/g, ' ').toLowerCase()}
                      </td>
                      <td className="px-4 py-2 text-slate-600">
                        {entry.resourceType}
                        {entry.resourceId && (
                          <span className="block font-mono text-[11px] text-slate-400">
                            {entry.resourceId.slice(0, 8)}…
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-slate-600">{entry.tenantName ?? '—'}</td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-500">
                        {entry.ipAddress ?? '—'}
                      </td>
                    </tr>
                    {expanded === entry.id && entry.changes != null && (
                      <tr key={`${entry.id}-detail`} className="bg-slate-50">
                        <td colSpan={6} className="px-4 py-3">
                          <pre className="max-h-64 overflow-auto rounded border border-slate-200 bg-white p-3 text-xs">
                            {JSON.stringify(entry.changes, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>

            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPage={setPage}
            />
          </>
        )}
      </div>
    </div>
  );
}
