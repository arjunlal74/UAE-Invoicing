import { useMutation } from '@tanstack/react-query';
import { HEADER_COLUMNS, LINE_COLUMNS } from '@uae/domain';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Spinner, cx } from '../../components/ui';
import { ApiError, api, apiBlob, downloadBlob } from '../../lib/api';
import { canEdit, useAuthStore } from '../../stores/auth';

const MAX_BYTES = 50 * 1024 * 1024;

export function UploadPage() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const editable = canEdit(user);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api<{ id: string; reference: string }>('/api/v1/batches', {
        method: 'POST',
        formData: form,
      });
    },
    onSuccess: (result) => navigate(`/batches/${result.id}`),
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That file could not be uploaded.'),
  });

  const handleFile = (file: File | undefined) => {
    setError(null);
    if (!file) return;

    // Checked here as well as on the server so the user is told immediately
    // rather than after uploading 50MB.
    if (!/\.(xlsx|xlsm)$/i.test(file.name)) {
      setError('Only Excel workbooks (.xlsx) are accepted. Save your file as .xlsx and try again.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(
        `That file is ${(file.size / 1_048_576).toFixed(1)}MB, over the 50MB limit. Split it into smaller uploads.`,
      );
      return;
    }
    if (file.size === 0) {
      setError('That file is empty.');
      return;
    }

    upload.mutate(file);
  };

  const downloadTemplate = async () => {
    setDownloading(true);
    setError(null);
    try {
      const { blob, filename } = await apiBlob('/api/v1/templates/invoice-template.xlsx');
      downloadBlob(blob, filename);
    } catch {
      setError('The template could not be downloaded. Please try again.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-lg font-semibold text-slate-900">Upload invoices</h1>

      <Card title="Step 1 — Get the template">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <p className="max-w-xl text-sm text-slate-600">
            The template arrives with your own TRN and legal name already filled in, dropdown lists
            for every coded field, and the VAT columns calculated for you. Using it removes most of
            the errors we would otherwise have to flag.
          </p>
          <Button variant="primary" onClick={downloadTemplate} disabled={downloading}>
            {downloading ? 'Preparing…' : 'Download template'}
          </Button>
        </div>
      </Card>

      <Card title="Step 2 — Upload your completed file">
        {error && (
          <div className="mb-4">
            <Alert kind="danger">{error}</Alert>
          </div>
        )}

        {!editable ? (
          <Alert kind="info">
            Your role has read-only access. Ask a finance user or administrator to upload invoices.
          </Alert>
        ) : upload.isPending ? (
          <div className="flex flex-col items-center gap-3 py-12">
            <Spinner />
            <p className="text-sm text-slate-600">Uploading and archiving your file…</p>
          </div>
        ) : (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              handleFile(e.dataTransfer.files[0]);
            }}
            onClick={() => inputRef.current?.click()}
            className={cx(
              'flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-12 transition-colors',
              dragging
                ? 'border-brand-500 bg-brand-50'
                : 'border-slate-300 bg-slate-50 hover:border-brand-500 hover:bg-brand-50/40',
            )}
          >
            <p className="text-sm font-medium text-slate-700">
              Drop your Excel file here, or click to choose one
            </p>
            <p className="mt-1 text-xs text-slate-500">
              .xlsx up to 50MB — around 10,000 invoice lines
            </p>
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xlsm"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
          </div>
        )}

        <p className="mt-4 text-xs text-slate-500">
          Your original file is archived unchanged and kept for the statutory retention period. Any
          corrections you make afterwards are recorded separately in the audit trail.
        </p>
      </Card>

      <Card title="What the file must contain">
        <p className="mb-4 text-sm text-slate-600">
          Two sheets, linked by invoice number. If you use your own layout, keep these column
          headings — the order does not matter.
        </p>

        <div className="grid gap-6 md:grid-cols-2">
          <ColumnList title="Sheet: Invoice_Header" columns={HEADER_COLUMNS} />
          <ColumnList title="Sheet: Invoice_Line_Items" columns={LINE_COLUMNS} />
        </div>
      </Card>
    </div>
  );
}

function ColumnList({
  title,
  columns,
}: {
  title: string;
  columns: readonly { col: string; header: string; required: string; hint: string }[];
}) {
  return (
    <div>
      <h3 className="mb-2 font-mono text-xs font-semibold text-slate-700">{title}</h3>
      <ul className="space-y-1.5">
        {columns.map((column) => (
          <li key={column.col} className="flex gap-2 text-xs">
            <span className="w-4 shrink-0 font-mono text-slate-400">{column.col}</span>
            <span className="min-w-0">
              <span className="font-medium text-slate-700">{column.header}</span>
              {column.required === 'yes' && <span className="ml-1 text-danger-500">*</span>}
              {column.required === 'conditional' && (
                <span className="ml-1 text-warn-600" title="Required in some cases">
                  †
                </span>
              )}
              {column.required === 'derived' && (
                <span className="ml-1 text-slate-400">(calculated)</span>
              )}
              <span className="block text-slate-500">{column.hint}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
