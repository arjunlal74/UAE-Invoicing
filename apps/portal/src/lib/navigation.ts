/**
 * Where a document was opened from, so closing it goes back there.
 *
 * A document detail page is reachable from half a dozen lists — the sales
 * documents table, the dispute desk, the approval queue, a report, the usage
 * ledger — and it used to send everyone back to the same one. Someone working
 * an approval queue was returned to a list of every invoice they have ever
 * filed, with their place in the queue lost, which makes the queue unworkable
 * for the one job it exists for.
 *
 * The origin travels in the URL rather than in router state so that it survives
 * a refresh and can be pasted to a colleague, and it is a whole relative path
 * so a filtered list comes back filtered.
 */

/**
 * The lists a document may be opened from. An allow-list rather than trusting
 * the parameter: whatever arrives in `from` is put into a link, and a link
 * built from an arbitrary string is somebody else's navigation.
 */
const ORIGINS: Record<string, string> = {
  '/invoices': 'All invoices',
  '/approvals': 'Approvals',
  '/ar/customers': 'Customers',
  '/ar/disputes': 'Customer responses',
  '/ar/drafts': 'Drafts',
  '/batches': 'Batches',
  '/reports': 'Dispute analytics',
  '/settings/usage': 'Usage & balance',
  '/ap/documents': 'Purchase documents',
  '/ap/disputes': 'Supplier disputes',
  '/ap/inbox': 'Verification desk',
};

export interface Origin {
  to: string;
  label: string;
}

/** Append the current list — path and filters both — to a document link. */
export function withOrigin(to: string, from: { pathname: string; search: string }): string {
  const origin = `${from.pathname}${from.search}`;
  const separator = to.includes('?') ? '&' : '?';
  return `${to}${separator}from=${encodeURIComponent(origin)}`;
}

/**
 * Carry an origin onward to a related document, so following a credit note from
 * an approval queue and then closing it still returns to the queue rather than
 * stranding the reader one document deeper with no way back.
 */
export function keepOrigin(to: string, origin: Origin): string {
  const separator = to.includes('?') ? '&' : '?';
  return `${to}${separator}from=${encodeURIComponent(origin.to)}`;
}

/** Read it back, falling back to the list the page belongs to by default. */
export function originFrom(search: string, fallback: Origin): Origin {
  const raw = new URLSearchParams(search).get('from');
  if (!raw || !raw.startsWith('/')) return fallback;

  const label = ORIGINS[raw.split('?')[0] ?? ''];
  return label ? { to: raw, label } : fallback;
}
