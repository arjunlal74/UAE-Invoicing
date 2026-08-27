import { IngestInvoiceRequest, type IngestInvoiceResponse } from '@uae/contracts';
import { readFile } from 'node:fs/promises';
import { audit, type AuditActor } from '../audit/audit.js';
import { config } from '../config.js';
import { jsonb, withTenant } from '../db/client.js';
import { AppError } from '../lib/errors.js';
import { sha256Hex } from '../lib/crypto.js';
import { logger } from '../logger.js';
import { acceptWorkbook, extensionOf } from '../modules/batches/service.js';
import { ingestInvoice } from '../modules/ingestion/service.js';
import type { CandidateFile, Drop } from './drops.js';

/**
 * What a dropped file becomes.
 *
 * Two formats, chosen because they are the two an ERP can actually produce.
 *
 *   `.json`  — one document or an array of them, the same body the REST
 *              endpoint takes. Each is filed synchronously and appears in the
 *              receipt with its own outcome, so a file of two hundred invoices
 *              with one bad line does not lose the other hundred and ninety-nine.
 *
 *   `.xlsx`  — the platform's own template, handed to the staging pipeline
 *              exactly as a portal upload is. It cannot be filed synchronously
 *              and should not be: the workbook is the format a *person* fixes,
 *              and the receipt's job is to say which batch to open.
 *
 * The asymmetry is deliberate. JSON is a machine asserting a finished document;
 * a spreadsheet is a machine handing over something a human still owns.
 */

export type DeliveryStatus = 'ACCEPTED' | 'PARTIAL' | 'REJECTED' | 'DUPLICATE';

export interface Receipt {
  file: string;
  receivedAt: string;
  processedAt: string;
  status: DeliveryStatus;
  /** One entry per document in a JSON drop. */
  documents?: {
    index: number;
    invoiceNumber: string | null;
    accepted: boolean;
    id?: string;
    status?: string;
    queued?: boolean;
    pendingApproval?: boolean;
    error?: { code: string; message: string; details?: unknown };
  }[];
  /** Set for a workbook drop. */
  batch?: { id: string; reference: string; message: string };
  error?: { code: string; message: string; details?: unknown };
}

export interface ProcessOutcome {
  status: DeliveryStatus;
  receipt: Receipt;
  invoiceCount: number;
  batchId: string | null;
}

const machineActor = (drop: Drop): AuditActor => ({
  actorId: drop.apiKeyId,
  actorName: `${drop.keyName} (sftp:${drop.username})`,
  actorType: 'API_KEY',
  ip: null,
  userAgent: `sftp-drop/${drop.username}`,
  tenantId: drop.tenantId,
});

export async function processFile(
  drop: Drop,
  file: CandidateFile,
  claimedPath: string,
): Promise<ProcessOutcome> {
  const receivedAt = file.modifiedAt.toISOString();
  const base: Pick<Receipt, 'file' | 'receivedAt' | 'processedAt'> = {
    file: file.name,
    receivedAt,
    processedAt: new Date().toISOString(),
  };

  const cfg = config();
  if (file.sizeBytes > cfg.SFTP_MAX_FILE_BYTES) {
    return rejected(base, {
      code: 'FILE_TOO_LARGE',
      message: `That file is ${Math.round(file.sizeBytes / 1_048_576)}MB; the limit is ${Math.round(cfg.SFTP_MAX_FILE_BYTES / 1_048_576)}MB. Split it into smaller drops.`,
    });
  }

  const buffer = await readFile(claimedPath);
  const hash = sha256Hex(buffer);

  // Byte-identical content is never legitimately sent twice — the invoice
  // numbers inside it are the same — so a scheduler that fired twice is turned
  // away here rather than being allowed to fail invoice by invoice further in.
  const previous = await findPreviousDelivery(drop, hash);
  if (previous) {
    return {
      status: 'DUPLICATE',
      invoiceCount: 0,
      batchId: null,
      receipt: {
        ...base,
        status: 'DUPLICATE',
        error: {
          code: 'DUPLICATE_FILE',
          message: `This file is byte-identical to ${previous.file_name}, received ${previous.processed_at.toISOString()}. Nothing was filed again.`,
        },
      },
    };
  }

  const extension = extensionOf(file.name);
  const outcome =
    extension === '.json'
      ? await processJson(drop, buffer, base)
      : extension === '.xlsx' || extension === '.xlsm'
        ? await processWorkbook(drop, file.name, buffer, base)
        : rejected(base, {
            code: 'UNSUPPORTED_FORMAT',
            message: `\`${extension || file.name}\` is not a format this drop accepts. Send .json (one document or an array) or .xlsx (the platform's invoice template).`,
          });

  await recordDelivery(drop, file, hash, outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

async function processJson(
  drop: Drop,
  buffer: Buffer,
  base: Pick<Receipt, 'file' | 'receivedAt' | 'processedAt'>,
): Promise<ProcessOutcome> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(buffer.toString('utf8')));
  } catch (err) {
    return rejected(base, {
      code: 'MALFORMED_JSON',
      message: `That file is not valid JSON: ${(err as Error).message}`,
    });
  }

  const payloads = Array.isArray(parsed) ? parsed : [parsed];
  if (payloads.length === 0) {
    return rejected(base, { code: 'EMPTY_FILE', message: 'The file contained no documents.' });
  }

  const canFile = drop.scopes.includes('invoice.submit');
  const documents: NonNullable<Receipt['documents']> = [];
  let accepted = 0;

  for (const [index, payload] of payloads.entries()) {
    // Each document is filed on its own. A file of two hundred invoices with
    // one bad line must not cost the merchant the other hundred and ninety-nine
    // — they would have to be re-sent, and half of them would then collide with
    // themselves on the invoice number.
    try {
      const body = IngestInvoiceRequest.parse(payload);
      const result = await ingestInvoice(body, {
        tenantId: drop.tenantId,
        apiKeyId: drop.apiKeyId,
        userId: null,
        canFile,
      });

      documents.push({
        index,
        invoiceNumber: result.response.invoiceNumber,
        accepted: true,
        id: result.response.id,
        status: result.response.status,
        queued: result.response.queued,
        pendingApproval: result.response.pendingApproval,
      });
      accepted += 1;

      await audit(machineActor(drop), {
        action: result.queued ? 'INVOICE_INGESTED' : 'INVOICE_INGESTED_FOR_APPROVAL',
        resourceType: 'INVOICE',
        resourceId: result.invoiceId,
        tenantId: drop.tenantId,
        changes: {
          invoiceNumber: result.response.invoiceNumber,
          channel: 'SFTP',
          file: base.file,
          apiKey: drop.keyName,
        },
      });
    } catch (err) {
      documents.push({
        index,
        invoiceNumber: invoiceNumberOf(payload),
        accepted: false,
        error: describe(err),
      });
    }
  }

  const status: DeliveryStatus =
    accepted === payloads.length ? 'ACCEPTED' : accepted === 0 ? 'REJECTED' : 'PARTIAL';

  return {
    status,
    invoiceCount: accepted,
    batchId: null,
    receipt: { ...base, status, documents },
  };
}

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

async function processWorkbook(
  drop: Drop,
  fileName: string,
  buffer: Buffer,
  base: Pick<Receipt, 'file' | 'receivedAt' | 'processedAt'>,
): Promise<ProcessOutcome> {
  try {
    const batch = await acceptWorkbook({
      tenantId: drop.tenantId,
      fileName,
      buffer,
      source: 'SFTP',
      uploadedByUserId: null,
      uploadedByApiKeyId: drop.apiKeyId,
    });

    await audit(machineActor(drop), {
      action: 'BATCH_UPLOADED',
      resourceType: 'BATCH',
      resourceId: batch.id,
      tenantId: drop.tenantId,
      changes: {
        fileName,
        reference: batch.reference,
        sizeBytes: batch.sizeBytes,
        sha256: batch.hash,
        channel: 'SFTP',
      },
    });

    return {
      status: 'ACCEPTED',
      invoiceCount: 0,
      batchId: batch.id,
      receipt: {
        ...base,
        status: 'ACCEPTED',
        batch: {
          id: batch.id,
          reference: batch.reference,
          // Said plainly, because it is the one thing about a workbook drop
          // that differs from a JSON one and the difference matters.
          message:
            'The workbook was accepted and is being parsed. Its rows are not filed yet — open this batch in the portal to review and submit them.',
        },
      },
    };
  } catch (err) {
    return rejected(base, describe(err));
  }
}

// ---------------------------------------------------------------------------

async function findPreviousDelivery(
  drop: Drop,
  hash: string,
): Promise<{ file_name: string; processed_at: Date } | null> {
  const rows = await withTenant(
    drop.tenantId,
    (tx) => tx<{ file_name: string; processed_at: Date }[]>`
      SELECT file_name, processed_at FROM sftp_deliveries
      WHERE tenant_id = ${drop.tenantId} AND file_hash_sha256 = ${hash}
      ORDER BY processed_at DESC LIMIT 1
    `,
  );
  return rows[0] ?? null;
}

async function recordDelivery(
  drop: Drop,
  file: CandidateFile,
  hash: string,
  outcome: ProcessOutcome,
): Promise<void> {
  try {
    await withTenant(drop.tenantId, async (tx) => {
      await tx`
        INSERT INTO sftp_deliveries (
          tenant_id, api_key_id, sftp_username, file_name, file_hash_sha256,
          size_bytes, status, receipt, batch_id, invoice_count, received_at
        ) VALUES (
          ${drop.tenantId}, ${drop.apiKeyId}, ${drop.username}, ${file.name}, ${hash},
          ${file.sizeBytes}, ${outcome.status}::sftp_delivery_status,
          ${jsonb(tx, outcome.receipt)}, ${outcome.batchId}, ${outcome.invoiceCount},
          ${file.modifiedAt}
        )
        ON CONFLICT (tenant_id, file_hash_sha256) DO NOTHING
      `;
    });
  } catch (err) {
    // The invoices are already filed. Losing the delivery row costs the record
    // of *how* they arrived, which is worth an error in the log but not worth
    // making the whole drop look like a failure and inviting a re-send.
    logger.error(
      { username: drop.username, file: file.name, err },
      'sftp: could not record the delivery',
    );
  }
}

function rejected(
  base: Pick<Receipt, 'file' | 'receivedAt' | 'processedAt'>,
  error: NonNullable<Receipt['error']>,
): ProcessOutcome {
  return {
    status: 'REJECTED',
    invoiceCount: 0,
    batchId: null,
    receipt: { ...base, status: 'REJECTED', error },
  };
}

/** Turn whatever was thrown into something an integrator can act on. */
function describe(err: unknown): { code: string; message: string; details?: unknown } {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, details: err.details };
  }
  if (err && typeof err === 'object' && 'issues' in err) {
    // A Zod failure. The paths are the API's own field names, so they are
    // useful to the sender as they stand.
    const issues = (err as { issues: { path: (string | number)[]; message: string }[] }).issues;
    return {
      code: 'INVALID_PAYLOAD',
      message: 'That document did not match the expected shape.',
      details: issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    };
  }
  return { code: 'INTERNAL', message: 'That document could not be processed.' };
}

/** Best-effort, for naming a document in the receipt when it failed to parse. */
function invoiceNumberOf(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'invoiceNumber' in payload) {
    const value = (payload as { invoiceNumber: unknown }).invoiceNumber;
    if (typeof value === 'string') return value;
  }
  return null;
}

/** Windows exporters write UTF-8 with a byte-order mark, and JSON.parse chokes. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export type { IngestInvoiceResponse };
