import { withTenant } from '../../db/client.js';
import { sha256Hex } from '../../lib/crypto.js';
import { badRequest } from '../../lib/errors.js';
import { PARSE_JOB_OPTIONS, batchParseQueue } from '../../queue/queues.js';
import { buildKey, putObject } from '../../storage/objectStore.js';

/**
 * Accepting a workbook, once.
 *
 * Two things now hand a spreadsheet to the staging pipeline: a person clicking
 * upload in the portal, and an ERP dropping a file into an SFTP directory
 * (§1.2 channel 1). The evidentiary rules are the same for both — archive the
 * bytes before parsing them, refuse a byte-identical re-send, reference the
 * batch by a human number — so they run the same code.
 */

export const ACCEPTED_EXTENSIONS = ['.xlsx', '.xlsm'];

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface AcceptWorkbookOptions {
  tenantId: string;
  fileName: string;
  buffer: Buffer;
  /** The ingestion channel to record on the batch. */
  source: 'EXCEL_UPLOAD' | 'SFTP';
  /** Exactly one of these — a machine is not a user (see migration 0007). */
  uploadedByUserId: string | null;
  uploadedByApiKeyId?: string | null;
}

export interface AcceptedWorkbook {
  id: string;
  reference: string;
  hash: string;
  sizeBytes: number;
}

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot).toLowerCase();
}

export async function acceptWorkbook(
  options: AcceptWorkbookOptions,
): Promise<AcceptedWorkbook> {
  const { tenantId, fileName, buffer } = options;

  const extension = extensionOf(fileName);
  if (!ACCEPTED_EXTENSIONS.includes(extension)) {
    throw badRequest(
      `Only Excel workbooks are accepted (${ACCEPTED_EXTENSIONS.join(', ')}). Save your file as .xlsx and try again.`,
    );
  }
  if (buffer.length === 0) throw badRequest('That file is empty.');

  const hash = sha256Hex(buffer);

  // The uploaded file is archived to WORM storage BEFORE anything is parsed.
  // It is the evidentiary original: whatever is later edited in the staging
  // grid, this is what the merchant actually sent us.
  const stored = await putObject(
    buildKey(tenantId, 'source', `${hash.slice(0, 16)}-${fileName}`, extension.slice(1)),
    buffer,
    XLSX_MIME,
    {
      tenantId,
      uploadedBy: options.uploadedByUserId ?? options.uploadedByApiKeyId ?? 'unknown',
      originalName: fileName,
    },
  );

  const batch = await withTenant(tenantId, async (tx) => {
    // A re-send of a byte-identical file is almost always a double click, an
    // impatient retry, or a scheduler that fired twice — not an intent to file
    // everything a second time.
    const duplicates = await tx<{ id: string; reference: string }[]>`
      SELECT id, reference FROM batch_uploads
      WHERE tenant_id = ${tenantId} AND file_hash_sha256 = ${hash}
        AND created_at > now() - interval '24 hours'
      ORDER BY created_at DESC LIMIT 1
    `;
    if (duplicates[0]) {
      throw badRequest(
        `This exact file was received within the last 24 hours as ${duplicates[0].reference}. Open that batch instead, or change the file if this is a new set of invoices.`,
      );
    }

    const sequence = await tx<{ next: string }[]>`
      SELECT lpad((count(*) + 1)::text, 4, '0') AS next
      FROM batch_uploads
      WHERE tenant_id = ${tenantId} AND created_at::date = CURRENT_DATE
    `;

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const reference = `BATCH-${stamp}-${sequence[0]!.next}`;

    const inserted = await tx<{ id: string }[]>`
      INSERT INTO batch_uploads (
        tenant_id, reference, file_name, file_s3_uri, file_hash_sha256,
        file_size_bytes, source, status, uploaded_by_user_id, uploaded_by_api_key_id
      ) VALUES (
        ${tenantId}, ${reference}, ${fileName}, ${stored.uri}, ${hash},
        ${buffer.length}, ${options.source}::ingestion_source, 'UPLOADED',
        ${options.uploadedByUserId}, ${options.uploadedByApiKeyId ?? null}
      )
      RETURNING id
    `;

    return { id: inserted[0]!.id, reference };
  });

  await batchParseQueue().add(
    'parse',
    { batchId: batch.id, tenantId, actorUserId: options.uploadedByUserId },
    PARSE_JOB_OPTIONS,
  );

  return { ...batch, hash, sizeBytes: buffer.length };
}
