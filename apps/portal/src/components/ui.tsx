import type { BatchStatus, InvoiceStatus, TenantStatus } from '@uae/contracts';
import { useEffect } from 'react';
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
  DRAFT: 'bg-slate-100 text-slate-600',
  INGESTED: 'bg-slate-100 text-slate-700',
  VALIDATED: 'bg-brand-50 text-brand-700',
  VALIDATION_FAILED: 'bg-danger-50 text-danger-700',
  PENDING_CFO_APPROVAL: 'bg-warn-50 text-warn-700',
  SUBMITTED_TO_ASP: 'bg-warn-50 text-warn-700',
  ACCEPTED_BY_FTA: 'bg-ok-50 text-ok-700',
  REJECTED_BY_FTA: 'bg-danger-50 text-danger-700',
  ARCHIVED: 'bg-slate-100 text-slate-600',
  // The buyer-driven half of the v2.7 lifecycle. Deliberately a different
  // colour family from the clearance statuses: an invoice can be cleared and
  // disputed at once, and the two must not read as the same kind of fact.
  DELIVERED_TO_BUYER: 'bg-brand-50 text-brand-700',
  ACKNOWLEDGED: 'bg-brand-50 text-brand-700',
  UNDER_QUERY: 'bg-warn-50 text-warn-700',
  ACCEPTED_BY_BUYER: 'bg-ok-50 text-ok-700',
  REJECTED_COMMERCIAL: 'bg-danger-50 text-danger-700',
  REJECTED_TECHNICAL: 'bg-danger-50 text-danger-700',
  // AP posting
  NOT_POSTED: 'bg-slate-100 text-slate-600',
  POSTED: 'bg-ok-50 text-ok-700',
  BLOCKED: 'bg-danger-50 text-danger-700',
  ON_HOLD: 'bg-warn-50 text-warn-700',
  // Data bundles
  EXHAUSTED: 'bg-danger-50 text-danger-700',
  EXPIRED: 'bg-slate-200 text-slate-700',
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
  DRAFT: 'Draft',
  INGESTED: 'Received',
  VALIDATED: 'Ready to submit',
  VALIDATION_FAILED: 'Failed checks',
  PENDING_CFO_APPROVAL: 'Awaiting approval',
  SUBMITTED_TO_ASP: 'Awaiting FTA',
  ACCEPTED_BY_FTA: 'Cleared by FTA',
  REJECTED_BY_FTA: 'Rejected by FTA',
  ARCHIVED: 'Archived',
  DELIVERED_TO_BUYER: 'Delivered',
  ACKNOWLEDGED: 'Acknowledged',
  UNDER_QUERY: 'Under query',
  ACCEPTED_BY_BUYER: 'Accepted by buyer',
  REJECTED_COMMERCIAL: 'Disputed',
  REJECTED_TECHNICAL: 'Technically rejected',
  NOT_POSTED: 'Not posted',
  POSTED: 'Posted',
  BLOCKED: 'Blocked',
  ON_HOLD: 'On hold',
  EXHAUSTED: 'Exhausted',
  EXPIRED: 'Expired',
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

/** Left intact when an enum value is made readable — 'Asp' helps nobody. */
const ACRONYMS = new Set(['ASP', 'FTA', 'TRN', 'VAT', 'API', 'PO', 'CFO', 'SFTP', 'UAE']);

/**
 * Turns a SCREAMING_SNAKE enum into a sentence: `ASP_CONFIG_UPDATED` becomes
 * `ASP config updated`. For anything a person picks from a menu or reads in a
 * column — the raw token is an implementation detail.
 */
export function humanise(value: string): string {
  return value
    .split('_')
    .map((word, index) => {
      if (ACRONYMS.has(word)) return word;
      const lower = word.toLowerCase();
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

/**
 * The one name a status goes by. A filter menu offering 'accepted by fta' beside
 * a table of badges reading 'Cleared by FTA' reads as two different things.
 */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? humanise(status);
}

/**
 * Document types as a person names them. The formal UBL labels in
 * `INVOICE_TYPES` — 'Commercial Tax Invoice (B2B)' — are what you pick from
 * when composing one; these are what a column has room for.
 */
const INVOICE_TYPE_LABELS: Record<string, string> = {
  TAX_INVOICE: 'Tax invoice',
  SIMPLIFIED_TAX_INVOICE: 'Simplified tax invoice',
  CREDIT_NOTE: 'Credit note',
  DEBIT_NOTE: 'Debit note',
};

export function invoiceTypeLabel(type: string): string {
  return INVOICE_TYPE_LABELS[type] ?? humanise(type);
}

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
      {statusLabel(status)}
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

/**
 * A modal, used by the directory forms and the AP verdict dialogs.
 *
 * Deliberately not a portal into document.body: nothing in this application
 * renders a modal from inside a stacking context that would clip it, and the
 * simpler tree is easier to test.
 */
/**
 * How many modals are open. A counter rather than a boolean because the
 * inner one unmounting must not hand scrolling back while an outer one is
 * still covering the page.
 */
let openModals = 0;

/**
 * Holds the page still while a modal is over it. Without this the wheel falls
 * through to the list behind the dialog, which scrolls away underneath it.
 */
function useScrollLock() {
  useEffect(() => {
    const root = document.documentElement;
    if (openModals === 0) {
      // Taking the scrollbar away widens the page; pad by exactly what it
      // occupied so the content — and the pinned header — do not jump sideways.
      const gutter = window.innerWidth - root.clientWidth;
      root.dataset.scrollLock = `${root.style.overflow}|${root.style.paddingRight}`;
      root.style.overflow = 'hidden';
      if (gutter > 0) root.style.paddingRight = `${gutter}px`;
    }
    openModals += 1;

    return () => {
      openModals -= 1;
      if (openModals === 0) {
        const [overflow = '', paddingRight = ''] = (root.dataset.scrollLock ?? '').split('|');
        root.style.overflow = overflow;
        root.style.paddingRight = paddingRight;
        delete root.dataset.scrollLock;
      }
    };
  }, []);
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 'md',
  dismissOnBackdrop = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'md' | 'lg' | 'xl';
  /**
   * Off for a dialog showing something that cannot be recovered — an API key is
   * displayed exactly once, and a stray click must not be what loses it.
   */
  dismissOnBackdrop?: boolean;
}) {
  const widths = { md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-5xl' };

  useScrollLock();

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8"
      // Clicking the backdrop closes; clicking the panel must not, so the
      // handler checks the target is the backdrop itself rather than a child.
      onMouseDown={(event) => {
        if (dismissOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={cx(
          'w-full rounded-lg border border-slate-200 bg-white shadow-xl',
          widths[width],
        )}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded px-2 py-0.5 text-lg leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            ×
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

/** Title row with optional description and right-aligned actions. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * A headline number with a label. The dashboards are mostly these, and having
 * them agree on size and colour is what makes a row of them readable at a
 * glance rather than as six separate boxes.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
  onClick,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger';
  onClick?: () => void;
}) {
  const tones = {
    neutral: 'text-slate-900',
    ok: 'text-ok-700',
    warn: 'text-warn-700',
    danger: 'text-danger-700',
  };

  const content = (
    <>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold tabular-nums', tones[tone])}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </>
  );

  if (onClick) {
    return (
      <button
        onClick={onClick}
        className="rounded-lg border border-slate-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-brand-300 hover:bg-brand-50/40"
      >
        {content}
      </button>
    );
  }

  return <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">{content}</div>;
}
