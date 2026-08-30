import { useState } from 'react';
import { ApiError, downloadFile, downloadPdf, printPdf } from '../lib/api';
import { Button } from './ui';

/**
 * The Print / PDF / Excel row, wherever a document or report leaves the screen.
 *
 * Both buttons hit the same endpoint and get the same bytes back; only the
 * content disposition differs. Doing it that way rather than with a print
 * stylesheet means the page a merchant prints and the file they email to a
 * customer are the same document — a second layout in CSS would be a second
 * thing to keep correct, and the one that drifts is always the one nobody looks
 * at until an auditor does.
 *
 * Excel is offered only where `xlsxPath` is given, because it only makes sense
 * where the thing on screen is a table. A tax invoice is a document with a
 * layout, and a spreadsheet of it would be a worse copy of a thing that already
 * has a right one.
 *
 * The failure is shown inline rather than thrown: a report that will not render
 * must not take the table the user is reading down with it.
 */
export function PdfActions({
  path,
  xlsxPath,
  disabled,
  size = 'md',
  label = 'PDF',
}: {
  /** The API path that renders the PDF, without the disposition parameter. */
  path: string;
  /** The API path that renders the workbook. Omit where a table is not the point. */
  xlsxPath?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  /** Wording for the download button — "PDF" on a toolbar, "Download PDF" alone. */
  label?: string;
}) {
  const [busy, setBusy] = useState<'print' | 'download' | 'excel' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: 'print' | 'download' | 'excel') => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'print') await printPdf(path);
      else if (kind === 'download') await downloadPdf(path);
      else if (xlsxPath) await downloadFile(xlsxPath);
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
      {xlsxPath && (
        <Button size={size} disabled={disabled || busy !== null} onClick={() => run('excel')}>
          {busy === 'excel' ? 'Building…' : 'Excel'}
        </Button>
      )}
    </div>
  );
}
