import type { FastifyReply } from 'fastify';
import { safeFilename } from '../pdf/document.js';

/**
 * Send a rendered workbook.
 *
 * Always an attachment, unlike a PDF: no browser has a viewer for a spreadsheet,
 * so `inline` would offer the user a file they cannot open in place. The Print
 * button on a report asks for the PDF instead — printing a spreadsheet is a
 * spreadsheet application's job, not ours.
 */
export function sendXlsx(reply: FastifyReply, workbook: Buffer, filename: string): FastifyReply {
  return reply
    .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .header('content-length', String(workbook.length))
    .header('content-disposition', `attachment; filename="${safeFilename(filename)}.xlsx"`)
    .send(workbook);
}
