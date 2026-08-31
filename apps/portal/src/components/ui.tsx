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
  label,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  /**
   * The accessible name, for a button whose content is an icon.
   *
   * A tooltip is not a name: it never reaches a screen reader reliably and
   * never reaches a keyboard user at all, so a button showing only a glyph
   * announces as "button" without this.
   */
  label?: string;
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
      title={title ?? label}
      aria-label={label}
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

/**
 * An identity colour for a card, when several sit in a column and the reader
 * needs to know which one they are in without re-reading the heading.
 *
 * The body carries the tint too, at a fraction of the header's strength. The
 * gradient is what keeps the heading the heading; a card washed evenly top to
 * bottom loses the line between its title and its contents.
 *
 * The body stays this pale on purpose rather than for taste: a row marking
 * itself in trouble has to out-shout the card it sits in, and at 40% of a 50
 * tint a danger row still reads as the loudest thing on the card.
 */
const CARD_ACCENTS = {
  slate: {
    rim: 'border-slate-200',
    header: 'border-slate-200 bg-white',
    body: 'bg-white',
    title: 'text-slate-800',
  },
  // Grey rather than a fourth hue. The card wearing it is the host, which is
  // not a tier alongside the others but the shelf they all buy from, and a
  // neutral reads as "not one of these" where a fourth colour would read as
  // "one more of these".
  graphite: {
    rim: 'border-slate-300',
    header: 'border-slate-300 bg-slate-200',
    body: 'bg-slate-50/60',
    title: 'text-slate-800',
  },
  // The three carry different weights on purpose. Blue is the darkest tint
  // the palette holds below its solid steps, and green and amber are thinned
  // well below their own 50: at equal strength the yellow reads loudest of
  // the three and pulls the eye to whichever card happens to wear it. The
  // rims stay at full strength on all three — the tint says which card this
  // is, and the border is what still separates it from the page.
  brand: {
    rim: 'border-brand-200',
    header: 'border-brand-200 bg-brand-100',
    body: 'bg-brand-50/40',
    title: 'text-brand-800',
  },
  ok: {
    rim: 'border-ok-200',
    header: 'border-ok-200 bg-ok-50/40',
    body: 'bg-ok-50/20',
    title: 'text-ok-700',
  },
  warn: {
    rim: 'border-warn-200',
    header: 'border-warn-200 bg-warn-50/40',
    body: 'bg-warn-50/20',
    title: 'text-warn-700',
  },
  danger: {
    rim: 'border-danger-200',
    header: 'border-danger-200 bg-danger-50',
    body: 'bg-danger-50/40',
    title: 'text-danger-700',
  },
};

/**
 * The handful of glyphs the admin tables need, drawn rather than imported.
 *
 * Five icons do not justify a dependency, and an icon font would arrive after
 * the first paint and shift the rows it sits in. These inherit the button's
 * colour through `currentColor`, so a disabled or danger button carries its
 * icon with it.
 *
 * Always paired with a `label` on the button: a glyph is a shorthand for
 * people who already know what it means, never the only way to find out.
 */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx('h-4 w-4', className)}
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

export type IconName = keyof typeof ICON_PATHS;

const ICON_PATHS = {
  view: (
    <>
      <path d="M1.7 10S4.6 4.8 10 4.8 18.3 10 18.3 10 15.4 15.2 10 15.2 1.7 10 1.7 10Z" />
      <circle cx="10" cy="10" r="2.4" />
    </>
  ),
  edit: (
    <>
      <path d="M13.4 3.6a1.7 1.7 0 0 1 2.4 2.4l-8 8-3.2.8.8-3.2Z" />
      <path d="M3 17h14" />
    </>
  ),
  lock: (
    <>
      <rect x="4.2" y="8.8" width="11.6" height="7.4" rx="1.4" />
      <path d="M6.9 8.8V6.6a3.1 3.1 0 0 1 6.2 0v2.2" />
    </>
  ),
  unlock: (
    <>
      <rect x="4.2" y="8.8" width="11.6" height="7.4" rx="1.4" />
      {/* The shackle swung clear of the body — the difference a glance has to catch. */}
      <path d="M6.9 8.8V6.6a3.1 3.1 0 0 1 6.1-.7" />
    </>
  ),
  retire: (
    <>
      <rect x="2.6" y="4.2" width="14.8" height="3.6" rx="1" />
      <path d="M4.2 7.8v7a1.4 1.4 0 0 0 1.4 1.4h8.8a1.4 1.4 0 0 0 1.4-1.4v-7" />
      <path d="M8.2 10.8h3.6" />
    </>
  ),
  // Service, not record safety: a padlock beside a pause has to read as a
  // different kind of action at a glance, because they are.
  suspend: (
    <>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M8.4 7.6v4.8M11.6 7.6v4.8" />
    </>
  ),
  reactivate: (
    <>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M8.5 7.3l4.4 2.7-4.4 2.7Z" />
    </>
  ),
  restore: (
    <>
      <path d="M3.4 10a6.6 6.6 0 1 0 1.9-4.6" />
      <path d="M3 3.2v3.4h3.4" />
    </>
  ),
  // SRS §3 custody. An open ledger, for going into a client's books — not a
  // door or an arrow, which would read as navigation rather than as entering
  // somebody else's accounts.
  books: (
    <>
      <path d="M10 6.1C8.5 5.1 6.6 4.7 4.6 4.8v9.4c2-.1 3.9.3 5.4 1.3 1.5-1 3.4-1.4 5.4-1.3V4.8c-2-.1-3.9.3-5.4 1.3Z" />
      <path d="M10 6.1v9.4" />
    </>
  ),
  // Who is authorised: two people, not one, because the question is always
  // "which of my staff", never "this person".
  staff: (
    <>
      <circle cx="7.8" cy="7.4" r="2.5" />
      <path d="M3.5 15.8a4.4 4.4 0 0 1 8.6 0" />
      <path d="M13.1 5.3a2.5 2.5 0 0 1 0 4.2" />
      <path d="M14.2 11.8a4.4 4.4 0 0 1 2.7 4" />
    </>
  ),
  // Two arrows passing: the account changes hands in one direction or the
  // other, which is exactly what the provisioning modes do.
  swap: (
    <>
      <path d="M3.4 7.6h11.2l-2.6-2.6" />
      <path d="M16.6 12.4H5.4l2.6 2.6" />
    </>
  ),
  // Units cut out of the master pool and given to a client.
  allocate: (
    <>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M10 6.6v6.8M6.6 10h6.8" />
    </>
  ),
} as const;

export function Card({
  title,
  actions,
  children,
  className,
  accent = 'slate',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  accent?: keyof typeof CARD_ACCENTS;
}) {
  const tone = CARD_ACCENTS[accent];

  return (
    <section className={cx('rounded-lg border shadow-sm', tone.rim, tone.body, className)}>
      {(title || actions) && (
        <header
          className={cx(
            'flex items-center justify-between gap-3 rounded-t-lg border-b px-4 py-3',
            tone.header,
          )}
        >
          {typeof title === 'string' ? (
            <h2 className={cx('text-sm font-semibold', tone.title)}>{title}</h2>
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

/**
 * The three verdicts on one sales document, told apart.
 *
 * `status` is a single column carrying three different questions, and the last
 * writer wins: a buyer answering AP turns ACCEPTED_BY_FTA into
 * ACCEPTED_BY_BUYER, so a list showing the status alone can report what the
 * customer decided or what the tax authority ruled, never both. That is fine on
 * a detail page with room to explain and wrong in a column an accountant scans
 * to find the invoices that did not clear.
 *
 * So the clearance half is recovered from the facts the overwrite cannot touch
 * — the IRN and the cleared timestamp — and the buyer half is read from the
 * response code rather than from the status it displaced.
 */
export interface DocumentStates {
  document: { label: string; tone: string };
  fta: { label: string; tone: string };
  buyer: { label: string; tone: string };
}

const NEUTRAL = 'bg-slate-100 text-slate-600';
const QUIET = 'text-slate-400';

export function documentStates(item: {
  status: string;
  ftaIrn?: string | null;
  clearedAt?: string | null;
  latestResponseCode?: string | null;
  isCommercialDispute?: boolean;
  disputeResolved?: boolean;
}): DocumentStates {
  const cleared = Boolean(item.clearedAt ?? item.ftaIrn);

  // Where the document sits in our own workflow, which is the only one of the
  // three a person here can act on directly.
  const document =
    item.status === 'DRAFT'
      ? { label: 'Draft', tone: NEUTRAL }
      : item.status === 'PENDING_CFO_APPROVAL'
        ? { label: 'Awaiting approval', tone: 'bg-warn-50 text-warn-700' }
        : item.status === 'VALIDATION_FAILED'
          ? { label: 'Failed checks', tone: 'bg-danger-50 text-danger-700' }
          : item.status === 'VALIDATED'
            ? { label: 'Ready to submit', tone: 'bg-brand-50 text-brand-600' }
            : item.status === 'ARCHIVED'
              ? { label: 'Archived', tone: NEUTRAL }
              : { label: 'Filed', tone: 'bg-slate-100 text-slate-700' };

  const fta =
    item.status === 'REJECTED_BY_FTA'
      ? { label: 'Rejected', tone: 'bg-danger-50 text-danger-700' }
      : cleared
        ? { label: 'Cleared', tone: 'bg-ok-50 text-ok-700' }
        : item.status === 'SUBMITTED_TO_ASP'
          ? { label: 'Awaiting', tone: 'bg-warn-50 text-warn-700' }
          : { label: 'Not submitted', tone: QUIET };

  // A buyer cannot have an opinion about a document that never reached them.
  const buyer = !cleared
    ? { label: '—', tone: QUIET }
    : item.latestResponseCode === 'RE'
      ? { label: 'Rejected', tone: 'bg-danger-50 text-danger-700' }
      : item.latestResponseCode === 'UQ'
        ? { label: 'Under query', tone: 'bg-warn-50 text-warn-700' }
        : item.latestResponseCode === 'AP'
          ? { label: 'Accepted', tone: 'bg-ok-50 text-ok-700' }
          : item.latestResponseCode === 'CA'
            ? { label: 'Accepted with conditions', tone: 'bg-ok-50 text-ok-700' }
            : item.latestResponseCode === 'AB'
              ? { label: 'Acknowledged', tone: 'bg-brand-50 text-brand-600' }
              : item.latestResponseCode === 'IP'
                ? { label: 'In process', tone: 'bg-brand-50 text-brand-600' }
                : { label: 'No reply', tone: QUIET };

  return { document, fta, buyer };
}

/**
 * The same three questions asked of a bill we received.
 *
 * The parties are the same three — the tax authority, the trading partner, and
 * our own ledger — but two of them swap roles. On an outbound document the
 * partner passes judgement on us; here we pass judgement on them, so the middle
 * column is our verdict rather than theirs. And the ledger question is real
 * money: a bill can be cleared and accepted and still be unposted.
 */
export function purchaseStates(item: {
  ftaIrn?: string | null;
  apPostingStatus?: string | null;
  latestResponseCode?: string | null;
}): DocumentStates {
  const fta = item.ftaIrn
    ? { label: 'Cleared', tone: 'bg-ok-50 text-ok-700' }
    : { label: 'No IRN', tone: QUIET };

  const verdict =
    item.latestResponseCode === 'RE'
      ? { label: 'Rejected', tone: 'bg-danger-50 text-danger-700' }
      : item.latestResponseCode === 'UQ'
        ? { label: 'Under query', tone: 'bg-warn-50 text-warn-700' }
        : item.latestResponseCode === 'AP'
          ? { label: 'Accepted', tone: 'bg-ok-50 text-ok-700' }
          : item.latestResponseCode === 'CA'
            ? { label: 'Accepted with conditions', tone: 'bg-ok-50 text-ok-700' }
            : item.latestResponseCode === 'AB'
              ? { label: 'Acknowledged', tone: 'bg-brand-50 text-brand-600' }
              : item.latestResponseCode === 'IP'
                ? { label: 'In process', tone: 'bg-brand-50 text-brand-600' }
                : { label: 'Not reviewed', tone: 'bg-warn-50 text-warn-700' };

  const posting =
    item.apPostingStatus === 'POSTED'
      ? { label: 'Posted', tone: 'bg-ok-50 text-ok-700' }
      : item.apPostingStatus === 'BLOCKED'
        ? { label: 'Blocked', tone: 'bg-danger-50 text-danger-700' }
        : item.apPostingStatus === 'ON_HOLD'
          ? { label: 'On hold', tone: 'bg-warn-50 text-warn-700' }
          : { label: 'Not posted', tone: QUIET };

  return { document: posting, fta, buyer: verdict };
}

/** One of the three states above, as a pill. */
export function StatePill({ state }: { state: { label: string; tone: string } }) {
  return state.tone === QUIET ? (
    <span className="text-xs text-slate-400">{state.label}</span>
  ) : (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        state.tone,
      )}
    >
      {state.label}
    </span>
  );
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

/**
 * Field chrome without a width, for a control sized by the row it sits in.
 *
 * Adding `w-auto` beside `inputClass` does not work and looks like it should:
 * both widths land in the class list, neither is more specific, and which one
 * wins is decided by the order Tailwind emits them rather than by the order
 * they are written. A filter row full of full-width selects is what that looks
 * like from the outside.
 */
export const inputBase =
  'rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm ' +
  'focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 ' +
  'disabled:bg-slate-50 disabled:text-slate-500';

export const inputClass = `w-full ${inputBase}`;

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
        {/* Take the whole viewport bar the backdrop padding and this panel's
            own header and footer, so a form scrolls internally only once it
            genuinely cannot fit on the screen. */}
        <div className="max-h-[calc(100vh-11rem)] overflow-y-auto p-4">{children}</div>
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
  tone?: 'neutral' | 'info' | 'ok' | 'warn' | 'danger';
  onClick?: () => void;
}) {
  // The tile carries the colour, not just the figure inside it. Tinting only
  // the number left a wall of white cards that had to be read one at a time to
  // find the one in trouble, which is the opposite of what a row of tiles is
  // for.
  //
  // Two of these are not verdicts. Neutral is white — no signal is itself a
  // signal — and info is the brand tint, for a row where every tile is meant to
  // be readable as a set and a white gap would read as "this one is different".
  // Keeping them apart from ok/warn/danger is what lets a red tile still mean
  // "look here" on a screen where everything is coloured.
  const tones = {
    neutral: { tile: 'border-slate-200 bg-white', hover: 'hover:border-brand-300 hover:bg-brand-50/40', value: 'text-slate-900' },
    info: { tile: 'border-brand-100 bg-brand-50', hover: 'hover:bg-brand-50/70', value: 'text-brand-700' },
    ok: { tile: 'border-ok-200 bg-ok-50', hover: 'hover:bg-ok-50/70', value: 'text-ok-700' },
    warn: { tile: 'border-warn-200 bg-warn-50', hover: 'hover:bg-warn-50/70', value: 'text-warn-700' },
    danger: { tile: 'border-danger-200 bg-danger-50', hover: 'hover:bg-danger-50/70', value: 'text-danger-700' },
  };

  const content = (
    <>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold tabular-nums', tones[tone].value)}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-slate-600">{hint}</div>}
    </>
  );

  if (onClick) {
    return (
      <button
        onClick={onClick}
        className={cx(
          'rounded-lg border p-4 text-left shadow-sm transition-colors',
          tones[tone].tile,
          tones[tone].hover,
        )}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={cx('rounded-lg border p-4 shadow-sm', tones[tone].tile)}>{content}</div>
  );
}
