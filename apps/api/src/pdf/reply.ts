import type { FastifyReply, FastifyRequest } from 'fastify';
import { safeFilename } from './document.js';

/**
 * Send a rendered PDF.
 *
 * `?disposition=inline` is what the portal's Print button asks for. The same
 * bytes serve both buttons and there is no second render for printing: a PDF
 * sent as an attachment goes straight to the downloads folder and never reaches
 * the viewer that has the print control on it, so the disposition is the whole
 * difference between "save this" and "print this".
 */
export function sendPdf(
  request: FastifyRequest,
  reply: FastifyReply,
  pdf: Buffer,
  filename: string,
): FastifyReply {
  const inline = (request.query as { disposition?: string } | undefined)?.disposition === 'inline';

  return reply
    .header('content-type', 'application/pdf')
    .header('content-length', String(pdf.length))
    .header(
      'content-disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${safeFilename(filename)}.pdf"`,
    )
    .send(pdf);
}
