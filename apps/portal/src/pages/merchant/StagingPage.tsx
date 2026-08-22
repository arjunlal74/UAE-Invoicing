import type { StagedRow, StagingPage as StagingPageDto, ValidationFindingDto } from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatAmount } from '@uae/domain';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ErrorSidebar } from '../../components/staging/ErrorSidebar';
import { StagingGrid } from '../../components/staging/StagingGrid';
import { Alert, Button, Spinner, StatusBadge, cx } from '../../components/ui';
import { ApiError, api, queryString } from '../../lib/api';
import { canEdit, canFile, useAuthStore } from '../../stores/auth';

/**
 * The interactive staging grid — the reason this product exists.
 *
 * A merchant uploads a spreadsheet, sees exactly which cells are wrong and why,
 * fixes them here, and submits only what is clean. Everything else in the
 * portal is in service of this screen.
 */
export function StagingPage() {
  const { batchId = '' } = useParams();
  const user = useAuthStore((s) => s.user);
  const editable = canEdit(user);
  // SRS v2.1 §5: only the tax approver files. Everyone else who may submit is
  // handing the batch to them, so the button says so.
  const filing = canFile(user);
  const queryClient = useQueryClient();

  const [errorsOnly, setErrorsOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [focusedCell, setFocusedCell] = useState<{ rowId: string; field: string } | null>(null);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const pageSize = 200;
  const queryKey = ['staging', batchId, page, errorsOnly];

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () =>
      api<StagingPageDto>(
        `/api/v1/batches/${batchId}/staging${queryString({ page, pageSize, errorsOnly })}`,
      ),
    // While the worker is still reading the file there is nothing to show, so
    // poll until it reaches a settled state rather than making the user reload.
    refetchInterval: (query) => {
      const status = query.state.data?.batch.status;
      return status === 'UPLOADED' || status === 'PARSING' ? 1500 : false;
    },
  });

  const batch = data?.batch;
  const rows = useMemo(() => data?.rows ?? [], [data]);

  const patchRow = useMutation({
    mutationFn: async ({
      rowId,
      invoice,
      lines,
    }: {
      rowId: string;
      invoice?: Record<string, string>;
      lines?: Record<string, Record<string, string> | null>;
    }) =>
      api<StagedRow>(`/api/v1/batches/${batchId}/staging/${rowId}`, {
        method: 'PATCH',
        body: { invoice, lines },
      }),
    onSuccess: (updated) => {
      // Patch the cached page in place rather than refetching. A refetch would
      // reorder or re-page the grid under the user's cursor mid-correction.
      queryClient.setQueryData<StagingPageDto>(queryKey, (current) =>
        current
          ? { ...current, rows: current.rows.map((r) => (r.id === updated.id ? updated : r)) }
          : current,
      );
      queryClient.invalidateQueries({ queryKey: ['batch', batchId] });
    },
    onError: (err) => {
      setBanner({
        kind: 'danger',
        text: err instanceof ApiError ? err.message : 'That change could not be saved.',
      });
    },
  });

  const autofix = useMutation({
    mutationFn: () => api<{ changed: number }>(`/api/v1/batches/${batchId}/autofix`, { method: 'POST' }),
    onSuccess: (result) => {
      setBanner({
        kind: result.changed > 0 ? 'ok' : 'info',
        text:
          result.changed > 0
            ? `Corrected ${result.changed} invoice${result.changed === 1 ? '' : 's'}. Values that needed a decision were left for you.`
            : 'Nothing could be corrected automatically — the remaining errors need your input.',
      });
      queryClient.invalidateQueries({ queryKey: ['staging', batchId] });
    },
  });

  const revalidate = useMutation({
    mutationFn: () =>
      api<{ checked: number; valid: number; invalid: number }>(
        `/api/v1/batches/${batchId}/revalidate`,
        { method: 'POST' },
      ),
    onSuccess: (result) => {
      setBanner({
        kind: result.invalid === 0 ? 'ok' : 'info',
        text:
          result.invalid === 0
            ? `All ${result.checked} invoices pass. You can submit.`
            : `${result.valid} of ${result.checked} pass; ${result.invalid} still need attention.`,
      });
      queryClient.invalidateQueries({ queryKey: ['staging', batchId] });
    },
  });

  const submit = useMutation({
    mutationFn: () =>
      api<{ queued: number; pendingApproval: number; skipped: number }>(
        `/api/v1/batches/${batchId}/submit`,
        { method: 'POST', body: {} },
      ),
    onSuccess: (result) => {
      const count = result.queued + result.pendingApproval;
      setBanner({
        kind: 'ok',
        text:
          result.queued > 0
            ? `${result.queued} invoice${result.queued === 1 ? '' : 's'} submitted. Track progress on the Invoices page — the FTA verdict usually arrives within a few minutes.`
            : `${count} invoice${count === 1 ? '' : 's'} sent for approval. Your tax approver will file them with the FTA.`,
      });
      queryClient.invalidateQueries({ queryKey: ['staging', batchId] });
      queryClient.invalidateQueries({ queryKey: ['approvals'] });
    },
    onError: (err) => {
      setBanner({
        kind: 'danger',
        text: err instanceof ApiError ? err.message : 'Submission failed.',
      });
    },
  });

  /** Clicking a finding in the sidebar scrolls the grid to that cell. */
  const focusFinding = useCallback((rowId: string, field: string) => {
    setFocusedCell({ rowId, field });
    const element = document.querySelector<HTMLElement>(`[data-cell="${rowId}:${field}"]`);
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element?.focus();
  }, []);

  const allFindings = useMemo(() => {
    const out: { row: StagedRow; finding: ValidationFindingDto }[] = [];
    for (const row of rows) {
      for (const finding of row.findings) out.push({ row, finding });
    }
    // Blocking errors first — warnings do not stop a submission and should not
    // compete for attention with the ones that do.
    return out.sort((a, b) => {
      const rank = (s: string) => (s === 'ERROR' || s === 'FATAL' ? 0 : 1);
      return rank(a.finding.severity) - rank(b.finding.severity);
    });
  }, [rows]);

  const blockingCount = allFindings.filter(
    (f) => f.finding.severity === 'ERROR' || f.finding.severity === 'FATAL',
  ).length;

  if (isLoading) {
    return (
      <div className="py-16">
        <Spinner label="Loading batch…" />
      </div>
    );
  }

  if (error || !batch) {
    return <Alert kind="danger">This batch could not be loaded.</Alert>;
  }

  if (batch.status === 'UPLOADED' || batch.status === 'PARSING') {
    return (
      <div className="flex flex-col items-center gap-3 py-20">
        <Spinner />
        <p className="text-sm font-medium text-slate-700">Reading {batch.fileName}…</p>
        <p className="text-sm text-slate-500">
          Large files take a moment. This page will update automatically.
        </p>
      </div>
    );
  }

  if (batch.status === 'FAILED') {
    return (
      <div className="space-y-4">
        <BatchHeader batch={batch} />
        <Alert kind="danger" title="This file could not be read">
          {batch.parseError ?? 'The workbook could not be processed.'}
        </Alert>
      </div>
    );
  }

  const submittable = rows.filter((r) => r.submittable && !r.invoiceId).length;
  const alreadySubmitted = rows.filter((r) => r.invoiceId).length;

  return (
    <div className="space-y-4">
      <BatchHeader batch={batch} />

      {banner && (
        <Alert kind={banner.kind === 'ok' ? 'ok' : banner.kind === 'danger' ? 'danger' : 'info'}>
          <div className="flex items-start justify-between gap-4">
            <span>{banner.text}</span>
            <button
              onClick={() => setBanner(null)}
              className="shrink-0 text-xs underline opacity-70"
            >
              Dismiss
            </button>
          </div>
        </Alert>
      )}

      {/* Batch summary bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <StatusBadge status={batch.status} />
          <Stat label="Total" value={batch.totalRecords} />
          <Stat label="Valid" value={batch.validRecords} tone="ok" />
          <Stat label="Needs attention" value={batch.invalidRecords} tone="danger" />
          {alreadySubmitted > 0 && <Stat label="Submitted" value={alreadySubmitted} tone="brand" />}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              setErrorsOnly((v) => !v);
              setPage(1);
            }}
            className={errorsOnly ? 'border-brand-500 text-brand-700' : undefined}
          >
            {errorsOnly ? 'Showing errors only' : `Filter: errors only (${batch.invalidRecords})`}
          </Button>

          {editable && (
            <>
              <Button
                size="sm"
                onClick={() => autofix.mutate()}
                disabled={autofix.isPending || batch.invalidRecords === 0}
                title="Corrects only unambiguous problems — casing, blank defaults, VAT rates. It will never guess a TRN or an amount."
              >
                {autofix.isPending ? 'Fixing…' : 'Auto-fix common defaults'}
              </Button>

              <Button
                size="sm"
                onClick={() => revalidate.mutate()}
                disabled={revalidate.isPending}
              >
                {revalidate.isPending ? 'Checking…' : 'Re-validate batch'}
              </Button>

            </>
          )}

          {(editable || filing) && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => submit.mutate()}
              disabled={submit.isPending || submittable === 0}
              title={
                submittable === 0
                  ? 'Every invoice either still has errors or has already been submitted.'
                  : undefined
              }
            >
              {submit.isPending
                ? 'Working…'
                : filing
                  ? `Submit to the FTA (${submittable})`
                  : `Send for approval (${submittable})`}
            </Button>
          )}
        </div>
      </div>

      {blockingCount > 0 && (
        <Alert kind="warn">
          {blockingCount} error{blockingCount === 1 ? '' : 's'} must be fixed before those invoices
          can be submitted. Click any error on the right to jump to it.
        </Alert>
      )}

      <div className="flex gap-4">
        <div ref={gridRef} className="min-w-0 flex-1">
          <StagingGrid
            rows={rows}
            editable={editable}
            focusedCell={focusedCell}
            onEditInvoice={(rowId, field, value) =>
              patchRow.mutate({ rowId, invoice: { [field]: value } })
            }
            onEditLine={(rowId, lineId, field, value) =>
              patchRow.mutate({ rowId, lines: { [lineId]: { [field]: value } } })
            }
            saving={patchRow.isPending}
          />
        </div>

        <ErrorSidebar
          findings={allFindings}
          onFocus={focusFinding}
          focusedCell={focusedCell}
        />
      </div>

      {data && data.total > pageSize && (
        <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
          <span className="text-slate-600">
            Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, data.total)} of{' '}
            {data.total.toLocaleString()} invoices
          </span>
          <div className="flex gap-2">
            <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button
              size="sm"
              disabled={page * pageSize >= data.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function BatchHeader({ batch }: { batch: StagingPageDto['batch'] }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">{batch.reference}</h1>
        <p className="text-sm text-slate-500">
          {batch.fileName}
          {batch.uploadedByName ? ` · uploaded by ${batch.uploadedByName}` : ''}
        </p>
      </div>
      <a
        href={`/api/v1/batches/${batch.id}/source`}
        className="text-sm text-brand-600 underline"
        title="The file exactly as you uploaded it, kept unchanged in the archive"
      >
        Download original file
      </a>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'ok' | 'danger' | 'brand';
}) {
  const tones = {
    ok: 'text-ok-700',
    danger: value > 0 ? 'text-danger-700' : 'text-slate-400',
    brand: 'text-brand-700',
  };
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={cx('text-lg font-semibold tabular-nums', tone ? tones[tone] : 'text-slate-900')}>
        {formatAmount(value, 0)}
      </span>
      <span className="text-xs text-slate-500">{label}</span>
    </span>
  );
}
