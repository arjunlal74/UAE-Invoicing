import type { BatchStatus, InvoiceStatus, TenantStatus } from '@uae/contracts';
import type { ReactNode } from 'react';

/** Small shared primitives. Kept in one file — none is big enough to earn its own. */

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  size = 'md',
  disabled,
  type = 'button',
  title,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  className?: string;
}) {
  const variants = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-slate-300',
    secondary:
      'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
    danger: 'bg-danger-500 text-white hover:bg-danger-700 disabled:bg-slate-300',
    ghost: 'text-slate-600 hover:bg-slate-100 disabled:text-slate-400',
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-md font-medium transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1',
        'disabled:cursor-not-allowed',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        variants[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('rounded-lg border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          {typeof title === 'string' ? (
            <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          ) : (
            title
          )}
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

const STATUS_STYLES: Record<string, string> = {
  // Invoice
  INGESTED: 'bg-slate-100 text-slate-700',
  VALIDATED: 'bg-brand-50 text-brand-700',
  VALIDATION_FAILED: 'bg-danger-50 text-danger-700',
  PENDING_CFO_APPROVAL: 'bg-warn-50 text-warn-700',
  SUBMITTED_TO_ASP: 'bg-warn-50 text-warn-700',
  ACCEPTED_BY_FTA: 'bg-ok-50 text-ok-700',
  REJECTED_BY_FTA: 'bg-danger-50 text-danger-700',
  ARCHIVED: 'bg-slate-100 text-slate-600',
  // Batch
  UPLOADED: 'bg-slate-100 text-slate-700',
  PARSING: 'bg-brand-50 text-brand-700',
  STAGED_WITH_ERRORS: 'bg-danger-50 text-danger-700',
  PROCESSING: 'bg-warn-50 text-warn-700',
  COMPLETED: 'bg-ok-50 text-ok-700',
  FAILED: 'bg-danger-50 text-danger-700',
  // Tenant / ASP
  PENDING: 'bg-warn-50 text-warn-700',
  ACTIVE: 'bg-ok-50 text-ok-700',
  SUSPENDED: 'bg-danger-50 text-danger-700',
  NOT_CONFIGURED: 'bg-slate-100 text-slate-600',
  PENDING_REGISTRATION: 'bg-warn-50 text-warn-700',
  DISABLED: 'bg-slate-200 text-slate-700',
};

/** Human wording. Users should never be shown SCREAMING_SNAKE_CASE. */
const STATUS_LABELS: Record<string, string> = {
  INGESTED: 'Received',
  VALIDATED: 'Ready to submit',
  VALIDATION_FAILED: 'Failed checks',
  PENDING_CFO_APPROVAL: 'Awaiting approval',
  SUBMITTED_TO_ASP: 'Awaiting FTA',
  ACCEPTED_BY_FTA: 'Accepted',
  REJECTED_BY_FTA: 'Rejected',
  ARCHIVED: 'Archived',
  UPLOADED: 'Uploaded',
  PARSING: 'Reading file',
  STAGED_WITH_ERRORS: 'Needs attention',
  PROCESSING: 'Submitting',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  PENDING: 'Pending',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  NOT_CONFIGURED: 'Not configured',
  PENDING_REGISTRATION: 'Awaiting registration',
  DISABLED: 'Disabled',
};

export function StatusBadge({
  status,
  className,
}: {
  status: InvoiceStatus | BatchStatus | TenantStatus | string;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        STATUS_STYLES[status] ?? 'bg-slate-100 text-slate-700',
        className,
      )}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1 text-xs font-medium text-slate-700">
        {label}
        {required && <span className="text-danger-500">*</span>}
      </span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-danger-700">{error}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm ' +
  'focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 ' +
  'disabled:bg-slate-50 disabled:text-slate-500';

export function Alert({
  kind = 'info',
  title,
  children,
}: {
  kind?: 'info' | 'warn' | 'danger' | 'ok';
  title?: string;
  children: ReactNode;
}) {
  const styles = {
    info: 'border-brand-100 bg-brand-50 text-brand-800',
    warn: 'border-warn-200 bg-warn-50 text-warn-700',
    danger: 'border-danger-200 bg-danger-50 text-danger-700',
    ok: 'border-ok-200 bg-ok-50 text-ok-700',
  };

  return (
    <div className={cx('rounded-md border px-4 py-3 text-sm', styles[kind])}>
      {title && <p className="mb-1 font-semibold">{title}</p>}
      <div>{children}</div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
      {label && <span>{label}</span>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description && <p className="max-w-md text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
      <span>
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <span className="text-xs text-slate-500">
          Page {page} of {pages}
        </span>
        <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
