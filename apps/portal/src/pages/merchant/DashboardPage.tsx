import type { DashboardResponse, InvoiceStatus, ResponseStatusCode } from '@uae/contracts';
import { RESPONSE_CODE_LABELS } from '@uae/contracts';
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
  statusLabel,
} from '../../components/ui';
import { api } from '../../lib/api';

/**
 * The merchant landing page.
 *
 * Ordered by the question a finance user actually arrives with — "is anything
 * wrong?" — so the needs-attention block comes before the totals.
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

  const counts = data.counts ?? {};
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  return (
    <div className="space-y-6">
      {!data.canSubmit && (
        <Alert kind="warn" title="Submissions are not yet available">
          Your account status is <StatusBadge status={data.tenantStatus} /> and your provider
          connection is <StatusBadge status={data.aspStatus} />. You can upload files and correct
          errors now; invoices can be submitted once activation completes.
        </Alert>
      )}

      {/* Always rendered: the buyer-verdict tiles below hold their place at
          nought, so this card no longer disappears on a quiet morning. */}
      <Card title="Needs your attention">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            count={data.needsAttention.batchesWithErrors}
            label="Batches with errors"
            detail="Uploaded files containing invoices that failed validation."
            to="/batches"
            tone="danger"
          />
          <Tile
            count={data.needsAttention.rejectedInvoices}
            label="Rejected by the FTA"
            detail="These were not filed. Correct and resubmit them."
            to="/invoices?status=REJECTED_BY_FTA"
            tone="danger"
          />
          <Tile
            count={data.needsAttention.stuckTransmissions}
            label="Awaiting a verdict"
            detail="Sent over an hour ago with no response yet."
            to="/invoices?status=SUBMITTED_TO_ASP"
            tone="warn"
          />
          {/* The buyer verdicts hold their place at nought. A merchant checks
              "has anyone refused an invoice?" precisely on the mornings when
              the answer is no, and a tile that disappears cannot answer it. */}
          <Tile
            count={data.needsAttention.customerRejections}
            label="Rejected by customers"
            detail="The buyer refuses the invoice. Only a credit note closes one."
            to="/ar/disputes"
            tone="danger"
            showZero
          />
          <Tile
            count={data.needsAttention.customerQueries}
            label="Queried by customers"
            detail="The buyer has raised a question and is holding payment until it is answered."
            to="/ar/disputes"
            tone="warn"
            showZero
          />
          <Tile
            count={data.needsAttention.conditionalAcceptances}
            label="Accepted with conditions"
            detail="Accepted, but the buyer attached a condition someone has to meet."
            to="/ar/disputes?state=conditions"
            tone="ok"
            showZero
          />
        </div>
      </Card>

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
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {CLEARANCE_TILES.map(({ status, tone, detail }) => (
              <Tile
                key={status}
                count={counts[status as keyof typeof counts] ?? 0}
                label={statusLabel(status)}
                detail={detail}
                tone={tone}
                to={`/invoices?status=${status}`}
                showZero
              />
            ))}
          </div>
        )}
      </Card>

      <CustomerResponses data={data.customerResponses} />
    </div>
  );
}

/**
 * The FTA clearance axis, in the order a document travels it.
 *
 * Colour follows the verdict, not the volume: green is filed and done, red is
 * not filed at all, amber is out of our hands, blue is ours to act on, grey is
 * closed. Every tile holds its place at nought — a merchant reads this card to
 * confirm that nothing failed, and a missing tile cannot confirm anything.
 */
const CLEARANCE_TILES: { status: InvoiceStatus; tone: Tone; detail: string }[] = [
  {
    status: 'VALIDATED',
    tone: 'info',
    detail: 'Passed every check and waiting to be filed with the FTA.',
  },
  {
    status: 'SUBMITTED_TO_ASP',
    tone: 'warn',
    detail: 'With the provider. No verdict back from the FTA yet.',
  },
  {
    status: 'ACCEPTED_BY_FTA',
    tone: 'ok',
    detail: 'Filed and cleared. The IRN is on the document.',
  },
  {
    status: 'REJECTED_BY_FTA',
    tone: 'danger',
    detail: 'Not filed. Correct the document and resubmit it.',
  },
  {
    status: 'VALIDATION_FAILED',
    tone: 'danger',
    detail: 'Stopped by our own checks before it ever reached the FTA.',
  },
  {
    status: 'ARCHIVED',
    tone: 'neutral',
    detail: 'Closed out and retained for the audit period.',
  },
];

/**
 * What customers did with the invoices after they cleared (SRS v2.7 §11).
 *
 * Kept apart from "Invoices by status" on purpose. Clearance and acceptance are
 * two different verdicts from two different parties, and an invoice can be
 * cleared by the FTA and rejected by the buyer at the same time — folding the
 * two into one row of tiles would make that invoice invisible in whichever axis
 * it was not counted under.
 *
 * Grouped by Peppol response code rather than by our own status because AP and
 * CA both land on ACCEPTED_BY_BUYER, and "accepted, with conditions" is exactly
 * the one a collections clerk needs to see separately.
 */
const RESPONSE_TILES: { code: ResponseStatusCode; tone: Tone; detail: string }[] = [
  { code: 'AP', tone: 'ok', detail: 'Accepted outright. Nothing stands between this and payment.' },
  {
    code: 'CA',
    tone: 'ok',
    detail: 'Accepted, subject to a condition your side has to meet.',
  },
  // Blue, not amber: acknowledgement and in-process are the buyer's side
  // working normally. Colouring them as warnings would cry wolf on every
  // invoice that is merely in transit.
  { code: 'AB', tone: 'info', detail: 'Receipt confirmed. The buyer has not ruled on it yet.' },
  { code: 'IP', tone: 'info', detail: 'The buyer has it open and is still reviewing.' },
  { code: 'UQ', tone: 'warn', detail: 'The buyer has raised a question and is holding payment.' },
  { code: 'RE', tone: 'danger', detail: 'The buyer refuses it. Only a credit note closes one.' },
];

function CustomerResponses({ data }: { data: DashboardResponse['customerResponses'] }) {
  const byCode = data.byCode ?? {};
  const responded = RESPONSE_TILES.reduce((sum, r) => sum + (byCode[r.code] ?? 0), 0);

  // Nothing has reached a buyer yet — seven zeroes would say less than nothing.
  if (responded === 0 && data.awaitingResponse === 0) return null;

  return (
    <Card title="Customer responses">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {RESPONSE_TILES.map(({ code, tone, detail }) => (
          <Tile
            key={code}
            count={byCode[code] ?? 0}
            label={RESPONSE_CODE_LABELS[code]}
            detail={detail}
            tone={tone}
            // No screen lists invoices by response code, so these do not link.
            // The two that have a desk behind them are on the attention card.
            showZero
          />
        ))}
        <Tile
          count={data.awaitingResponse}
          label="No reply yet"
          detail="Delivered to the buyer, with nothing back from them so far."
          tone="neutral"
          showZero
        />
      </div>
    </Card>
  );
}

/**
 * A tile carries the colour of the thing it reports, not of its own size:
 * "Rejected by customers" is a red heading whether the number under it is
 * nought or forty, so the eye finds the row it wants without reading.
 *
 * Five tones rather than three, because the page has three genuinely different
 * kinds of nothing-to-do: green means settled, blue means moving on its own,
 * grey means dormant. Painting all of them amber would make the two counts that
 * really are amber — waiting on somebody — impossible to pick out.
 */
type Tone = 'danger' | 'warn' | 'ok' | 'info' | 'neutral';

const TONES: Record<Tone, { tile: string; hover: string; count: string }> = {
  danger: { tile: 'border-danger-200 bg-danger-50', hover: 'hover:bg-danger-50/70', count: 'text-danger-700' },
  warn: { tile: 'border-warn-200 bg-warn-50', hover: 'hover:bg-warn-50/70', count: 'text-warn-700' },
  ok: { tile: 'border-ok-200 bg-ok-50', hover: 'hover:bg-ok-50/70', count: 'text-ok-700' },
  info: { tile: 'border-brand-100 bg-brand-50', hover: 'hover:bg-brand-50/70', count: 'text-brand-600' },
  neutral: { tile: 'border-slate-200 bg-slate-50', hover: 'hover:bg-slate-100', count: 'text-slate-500' },
};

function Tile({
  count,
  label,
  detail,
  tone,
  to,
  showZero = false,
}: {
  count: number;
  label: string;
  detail: string;
  tone: Tone;
  /** Omitted where no screen lists these rows — a link to nowhere is worse than none. */
  to?: string;
  /**
   * Keep the tile on the page at nought. The buyer-verdict counts are held
   * open this way: "no customer has rejected anything" is itself the answer a
   * merchant comes to this card for, and a tile that vanishes cannot give it.
   */
  showZero?: boolean;
}) {
  if (count === 0 && !showZero) return null;

  const body = (
    <>
      <div className={cx('text-2xl font-semibold tabular-nums', TONES[tone].count)}>
        {count.toLocaleString()}
      </div>
      <div className="text-sm font-medium text-slate-800">{label}</div>
      <p className="mt-0.5 text-xs text-slate-600">{detail}</p>
    </>
  );

  return to ? (
    <Link
      to={to}
      className={cx('block rounded-lg border p-3 transition-colors', TONES[tone].tile, TONES[tone].hover)}
    >
      {body}
    </Link>
  ) : (
    <div className={cx('rounded-lg border p-3', TONES[tone].tile)}>{body}</div>
  );
}
