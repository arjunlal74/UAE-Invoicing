import { recalcInvoice, type StagedInvoice } from '@uae/domain';

/**
 * Invoice QR payload.
 *
 * ⚠️ The FTA has not published a final byte-level QR specification in the
 * material this system was built from. What follows is the TLV (tag-length-
 * value, base64-encoded) construction used across the region, carrying the
 * five fields every published variant includes: seller name, seller TRN,
 * timestamp, invoice total, and VAT total.
 *
 * The encoding is isolated here, behind `buildQrPayload`, precisely so that
 * conforming to the final spec is a change to this one function. Tag numbers
 * and field selection MUST be reconciled against the FTA's published QR
 * specification before production use.
 */

export const QR_TAGS = {
  SELLER_NAME: 1,
  SELLER_TRN: 2,
  TIMESTAMP: 3,
  INVOICE_TOTAL: 4,
  VAT_TOTAL: 5,
} as const;

const MAX_TLV_VALUE_BYTES = 255;

/**
 * Truncate to at most `maxBytes` of UTF-8 without splitting a character.
 *
 * Walking back over trailing continuation bytes is not sufficient — that stops
 * on the lead byte of the split character and leaves it stranded, producing a
 * replacement character on decode. Accumulating whole code points instead is
 * both correct and obvious. Iterating the string yields code points (surrogate
 * pairs included), so astral characters are never halved either.
 */
function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;

  let used = 0;
  let out = '';
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

function tlv(tag: number, value: string): Buffer {
  // TLV length is a single byte, so a value can never exceed 255 bytes.
  const payload = Buffer.from(truncateUtf8(value, MAX_TLV_VALUE_BYTES), 'utf8');
  return Buffer.concat([Buffer.from([tag, payload.length]), payload]);
}

export interface QrOptions {
  invoice: StagedInvoice;
  sellerName: string;
  sellerTrn: string;
  /** ISO 8601 timestamp of issue. Derived from the invoice when omitted. */
  timestamp?: string;
}

export function buildQrPayload(options: QrOptions): string {
  const invoice = recalcInvoice(options.invoice);
  const timestamp =
    options.timestamp ??
    `${invoice.issueDate}T${invoice.issueTime || '00:00:00'}Z`;

  return Buffer.concat([
    tlv(QR_TAGS.SELLER_NAME, options.sellerName),
    tlv(QR_TAGS.SELLER_TRN, options.sellerTrn),
    tlv(QR_TAGS.TIMESTAMP, timestamp),
    tlv(QR_TAGS.INVOICE_TOTAL, invoice.payableAmount),
    tlv(QR_TAGS.VAT_TOTAL, invoice.vatTotalAmount),
  ]).toString('base64');
}

/** Decode a payload back to its fields. Used by tests and the invoice viewer. */
export function decodeQrPayload(base64: string): Record<number, string> {
  const buf = Buffer.from(base64, 'base64');
  const out: Record<number, string> = {};
  let i = 0;
  while (i + 2 <= buf.length) {
    const tag = buf[i]!;
    const len = buf[i + 1]!;
    const start = i + 2;
    if (start + len > buf.length) break;
    out[tag] = buf.subarray(start, start + len).toString('utf8');
    i = start + len;
  }
  return out;
}
