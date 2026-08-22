import type { BatchSummary } from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { config } from '../../config.js';
import { withTenant } from '../../db/client.js';
import { requireContext, requirePermission } from '../../http/context.js';
import { sha256Hex } from '../../lib/crypto.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { PARSE_JOB_OPTIONS, batchParseQueue } from '../../queue/queues.js';
import { buildKey, putObject } from '../../storage/objectStore.js';

export interface BatchRow {
  id: string;
  reference: string;
  file_name: string;
  status: BatchSummary['status'];
  total_records: number;
  valid_records: number;
  invalid_records: number;
  submitted_records: number;
  parse_error: string | null;
  uploaded_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export function toBatchSummary(row: BatchRow): BatchSummary {
  return {
    id: row.id,
    reference: row.reference,
    fileName: row.file_name,
    status: row.status,
    totalRecords: row.total_records,
    validRecords: row.valid_records,
    invalidRecords: row.invalid_records,
    submittedRecords: row.submitted_records,
    uploadedByName: row.uploaded_by_name,
    parseError: row.parse_error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const BATCH_SELECT = `
  b.id, b.reference, b.file_name, b.status, b.total_records, b.valid_records,
  b.invalid_records, b.submitted_records, b.parse_error, b.created_at, b.updated_at,
  u.full_name AS uploaded_by_name
`;

const ACCEPTED_EXTENSIONS = ['.xlsx', '.xlsm'];

export function registerBatchRoutes(app: FastifyInstance) {
  // --- Upload --------------------------------------------------------------
  app.post(
    '/api/v1/batches',
    { preHandler: requirePermission('invoice.edit') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const tenantId = ctx.tenantId;
      if (!tenantId) throw notFound('Tenant');

      const file = await request.file();
      if (!file) throw badRequest('No file was uploaded.');

      const fileName = file.filename ?? 'upload.xlsx';
      const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
      if (!ACCEPTED_EXTENSIONS.includes(extension)) {
        throw badRequest(
          `Only Excel workbooks are accepted (${ACCEPTED_EXTENSIONS.join(', ')}). Save your file as .xlsx and try again.`,
        );
      }

      const buffer = await file.toBuffer();
      if (file.file.truncated) {
        throw badRequest(
          `That file is larger than the ${Math.round(config().UPLOAD_MAX_BYTES / 1_048_576)}MB limit. Split it into smaller uploads.`,
        );
      }
      if (buffer.length === 0) throw badRequest('That file is empty.');

      const hash = sha256Hex(buffer);

      // The uploaded file is archived to WORM storage BEFORE anything is
      // parsed. It is the evidentiary original: whatever the user later edits
      // in the staging grid, this is what they actually sent us.
      const stored = await putObject(
        buildKey(tenantId, 'source', `${hash.slice(0, 16)}-${fileName}`, extension.slice(1)),
        buffer,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        { tenantId, uploadedBy: ctx.userId, originalName: fileName },
      );

      const batch = await withTenant(tenantId, async (tx) => {
        // A re-upload of a byte-identical file is almost always a double click
        // or an impatient retry, not an intent to file everything twice.
        const duplicates = await tx<{ id: string; reference: string }[]>`
          SELECT id, reference FROM batch_uploads
          WHERE tenant_id = ${tenantId} AND file_hash_sha256 = ${hash}
            AND created_at > now() - interval '24 hours'
          ORDER BY created_at DESC LIMIT 1
        `;
        if (duplicates[0]) {
          throw badRequest(
            `You uploaded this exact file within the last 24 hours as ${duplicates[0].reference}. Open that batch instead, or change the file if this is a new set of invoices.`,
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
            file_size_bytes, source, status, uploaded_by_user_id
          ) VALUES (
            ${tenantId}, ${reference}, ${fileName}, ${stored.uri}, ${hash},
            ${buffer.length}, 'EXCEL_UPLOAD', 'UPLOADED', ${ctx.userId}
          )
          RETURNING id
        `;

        return { id: inserted[0]!.id, reference };
      });

      await batchParseQueue().add(
        'parse',
        { batchId: batch.id, tenantId, actorUserId: ctx.userId },
        PARSE_JOB_OPTIONS,
      );

      await audit(actorFromContext(ctx), {
        action: 'BATCH_UPLOADED',
        resourceType: 'BATCH',
        resourceId: batch.id,
        tenantId,
        changes: { fileName, reference: batch.reference, sizeBytes: buffer.length, sha256: hash },
      });

      return reply.status(202).send({
        id: batch.id,
        reference: batch.reference,
        status: 'UPLOADED',
        message: 'Upload received. Parsing has started.',
      });
    },
  );

  // --- List ----------------------------------------------------------------
  app.get('/api/v1/batches', { preHandler: requirePermission('invoice.read') }, async (request, reply) => {
    const ctx = requireContext(request);
    if (!ctx.tenantId) throw notFound('Tenant');

    const query = request.query as { page?: string; pageSize?: string };
    const page = Math.max(1, Number(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 25)));

    const { rows, total } = await withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.unsafe<BatchRow[]>(
        `SELECT ${BATCH_SELECT}
         FROM batch_uploads b
         LEFT JOIN users u ON u.id = b.uploaded_by_user_id
         WHERE b.tenant_id = $1
         ORDER BY b.created_at DESC
         LIMIT $2 OFFSET $3`,
        [ctx.tenantId, pageSize, (page - 1) * pageSize],
      );
      const counted = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM batch_uploads WHERE tenant_id = ${ctx.tenantId}
      `;
      return { rows, total: Number(counted[0]!.count) };
    });

    return reply.send({ items: rows.map(toBatchSummary), total, page, pageSize });
  });

  // --- Single batch --------------------------------------------------------
  app.get(
    '/api/v1/batches/:id',
    { preHandler: requirePermission('invoice.read') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const rows = await withTenant(ctx.tenantId, (tx) =>
        tx.unsafe<BatchRow[]>(
          `SELECT ${BATCH_SELECT}
           FROM batch_uploads b
           LEFT JOIN users u ON u.id = b.uploaded_by_user_id
           WHERE b.id = $1`,
          [id],
        ),
      );

      if (!rows[0]) throw notFound('Batch');
      return reply.send(toBatchSummary(rows[0]));
    },
  );

  // --- Download the original file -----------------------------------------
  app.get(
    '/api/v1/batches/:id/source',
    { preHandler: requirePermission('invoice.read') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const rows = await withTenant(
        ctx.tenantId,
        (tx) => tx<{ file_s3_uri: string; file_name: string }[]>`
          SELECT file_s3_uri, file_name FROM batch_uploads WHERE id = ${id}
        `,
      );

      const row = rows[0];
      if (!row) throw notFound('Batch');

      const { getObject, keyFromUri } = await import('../../storage/objectStore.js');
      const buffer = await getObject(keyFromUri(row.file_s3_uri));

      return reply
        .header(
          'content-type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        .header('content-disposition', `attachment; filename="${row.file_name}"`)
        .send(buffer);
    },
  );
}
