import { useState } from 'react';
import { ApiError, downloadPdf, printPdf } from '../lib/api';
import { Button } from './ui';

/**
 * The Print / PDF pair, wherever a document or report can be put on paper.
 *
 * Both buttons hit the same endpoint and get the same bytes back; only the
 * content disposition differs. Doing it that way rather than with a print
 * stylesheet means the page a merchant prints and the file they email to a
 * customer are the same document — a second layout in CSS would be a second
 * thing to keep correct, and the one that drifts is always the one nobody looks
 * at until an auditor does.
 *
 * The failure is shown inline rather than thrown: a report that will not render
 * must not take the table the user is reading down with it.
 */
export function PdfActions({
  path,
  disabled,
  size = 'md',
  label = 'PDF',
}: {
  /** The API path that renders the PDF, without the disposition parameter. */
  path: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  /** Wording for the download button — "PDF" on a toolbar, "Download PDF" alone. */
  label?: string;
}) {
  const [busy, setBusy] = useState<'print' | 'download' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: 'print' | 'download') => {
    setBusy(kind);
    setError(null);
    try {
      await (kind === 'print' ? printPdf(path) : downloadPdf(path));
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'That document could not be rendered.',
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-danger-700">{error}</span>}
      <Button size={size} disabled={disabled || busy !== null} onClick={() => run('print')}>
        {busy === 'print' ? 'Preparing…' : 'Print'}
      </Button>
      <Button size={size} disabled={disabled || busy !== null} onClick={() => run('download')}>
        {busy === 'download' ? 'Rendering…' : label}
      </Button>
    </div>
  );
}
