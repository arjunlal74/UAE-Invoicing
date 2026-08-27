import {
  type IngestFinding,
  type InvoiceStatus,
  type IngestInvoiceRequest,
  type IngestInvoiceResponse,
} from '@uae/contracts';
import {
  INVOICE_TYPES,
  emptyLine,
  recalcInvoice,
  type InvoiceTypeCode,
  type StagedInvoice,
  type StagedLine,
} from '@uae/domain';
import { randomUUID } from 'node:crypto';
import { withTenant, type Tx } from '../../db/client.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import {
  applyCustomer,
  applySeller,
  assertCanFile,
  insertDocument,
  nextNumber,
  queueSubmission,
  validateDocument,
  writeLines,
} from '../ar/documents.js';

/**
 * Ingestion channel 1 — an ERP posting a document (SRS v2.1 §1.2).
 *
 * The other two channels are interactive: a person uploads a spreadsheet or
 * types into a form, sees what is wrong, and fixes it. A machine gets one shot
 * and a status code, which changes what the endpoint owes it:
 *
 *   - **A verdict, synchronously.** The document is validated inside the same
 *     request. An ERP that gets 201 knows the invoice is legal and on its way;
 *     one that gets 422 gets every finding at once, not the first.
 *   - **No draft state.** There is nobody to come back and finish it. Either
 *     the payload is a filing or it is an error.
 *   - **Its own vocabulary.** Findings come back keyed to the fields of *this*
 *     API — `lines[2].unitPrice` — not to a spreadsheet cell reference for a
 *     workbook the caller has never seen.
 */

/** The API's field names, mapped from the internal staged ones. */
const FIELD_NAMES: Record<string, string> = {
  invoiceNumber: 'invoiceNumber',
  invoiceType: 'invoiceType',
  issueDate: 'issueDate',
  issueTime: 'issueTime',
  currency: 'currency',
  fxRate: 'exchangeRate',
  supplierTrn: 'seller.trn',
  supplierName: 'seller.name',
  buyerTrn: 'buyer.trn',
  buyerName: 'buyer.name',
  buyerEmirate: 'buyer.emirate',
  poReference: 'poReference',
  precedingInvoiceId: 'precedingInvoiceNumber',
  paymentMeans: 'paymentMeans',
  quantity: 'quantity',
  unitPrice: 'unitPrice',
  lineDiscount: 'discount',
  vatCategory: 'vatCategory',
  vatRate: 'vatRate',
  description: 'description',
  uom: 'uom',
};

function toApiFindings(
  findings: { ruleCode: string; severity: string; message: string; field: string; lineId?: string }[],
  lineIndexById: Map<string, number>,
): IngestFinding[] {
  return findings.map((finding) => {
    const line = finding.lineId ? (lineIndexById.get(finding.lineId) ?? null) : null;
    const name = FIELD_NAMES[finding.field] ?? finding.field;
    return {
      ruleCode: finding.ruleCode,
      severity: finding.severity as IngestFinding['severity'],
      message: finding.message,
      field: line === null ? name : `lines[${line - 1}].${name}`,
      line,
    };
  });
}

/**
 * Turn the public payload into the internal staged shape.
 *
 * Every derived amount is left blank for `recalcInvoice` to fill. Accepting the
 * sender's totals here and trusting them would make this the one channel where
 * a client's arithmetic reaches the FTA unchecked.
 */
function toStagedInvoice(body: IngestInvoiceRequest): StagedInvoice {
  const lines: StagedLine[] = body.lines.map((line, index) => ({
    ...emptyLine(randomUUID(), index + 1),
    description: line.description,
    hsCode: line.hsCode ?? '',
    quantity: line.quantity,
    uom: line.uom,
    unitPrice: line.unitPrice,
    lineDiscount: line.discount ?? '0',
    vatCategory: line.vatCategory,
    // The category dictates the rate, and `recalcInvoice` enforces that. A
    // stated rate is kept only so the validator can report the contradiction
    // against what the sender actually said (BR-UAE-14).
    vatRate: line.vatRate ?? '',
    sourceRow: null,
  }));

  const now = new Date();

  return {
    id: randomUUID(),
    invoiceNumber: body.invoiceNumber ?? '',
    invoiceType: body.invoiceType,
    issueDate: body.issueDate ?? now.toISOString().slice(0, 10),
    issueTime: body.issueTime ? normaliseTime(body.issueTime) : now.toISOString().slice(11, 19),
    currency: body.currency,
    fxRate: body.exchangeRate ?? '1.000000',
    supplierTrn: '',
    supplierName: '',
    buyerTrn: body.buyer.trn ?? '',
    buyerName: body.buyer.name ?? '',
    buyerEmirate: body.buyer.emirate ?? '',
    poReference: body.poReference ?? '',
    precedingInvoiceId: body.precedingInvoiceNumber ?? '',
    paymentMeans: body.paymentMeans ?? '',
    lines,
    lineExtensionAmount: '',
    taxExclusiveAmount: '',
    vatTotalAmount: '',
    taxInclusiveAmount: '',
    payableAmount: '',
    payableAmountAed: '',
    sourceRow: null,
  };
}

const normaliseTime = (value: string) => (value.length === 5 ? `${value}:00` : value);

/** Resolve `customerId` or `customerCode` to a directory record. */
async function resolveCustomerId(
  tx: Tx,
  tenantId: string,
  buyer: IngestInvoiceRequest['buyer'],
): Promise<string | null> {
  if (buyer.customerId) return buyer.customerId;
  if (!buyer.customerCode) return null;

  const rows = await tx<{ id: string }[]>`
    SELECT id FROM customers
    WHERE tenant_id = ${tenantId} AND customer_code = ${buyer.customerCode}
  `;
  const found = rows[0];
  if (!found) {
    throw notFound(`Customer with code "${buyer.customerCode}"`);
  }
  return found.id;
}

export interface IngestOptions {
  tenantId: string;
  apiKeyId: string | null;
  userId: string | null;
  /** Whether this caller may file with the FTA outright, or only prepare (§16). */
  canFile: boolean;
}

export interface IngestOutcome {
  response: IngestInvoiceResponse;
  invoiceId: string;
  queued: boolean;
}

export async function ingestInvoice(
  body: IngestInvoiceRequest,
  options: IngestOptions,
): Promise<IngestOutcome> {
  const typeSpec = INVOICE_TYPES[body.invoiceType as InvoiceTypeCode];
  const isReversal = typeSpec?.requiresPrecedingInvoice === true;

  if (isReversal && !body.precedingInvoiceNumber) {
    throw badRequest(
      'A credit or debit note must name the invoice it corrects, in precedingInvoiceNumber.',
    );
  }

  const result = await withTenant(options.tenantId, async (tx) => {
    let invoice = toStagedInvoice(body);
    invoice = await applySeller(tx, options.tenantId, invoice);

    const customerId = await resolveCustomerId(tx, options.tenantId, body.buyer);
    if (customerId) {
      invoice = await applyCustomer(tx, options.tenantId, customerId, invoice);
    } else if (!invoice.buyerName) {
      throw badRequest(
        'Name the buyer: send buyer.customerId, buyer.customerCode, or at least buyer.name.',
      );
    }

    // BR-UAE-30 requires a payment means and most ERPs do not model one. The
    // fallback goes here rather than in the schema so that a directory
    // customer's own default still wins — `applyCustomer` keeps whatever is
    // already set, so defaulting earlier would silently override it.
    if (!invoice.paymentMeans) invoice = { ...invoice, paymentMeans: '30' };

    // §8.2: the corrected document is resolved server-side so the note carries
    // the clearance IRN of the invoice it actually credits, rather than
    // whatever the sending system believed about it.
    let referenced: {
      id: string;
      invoice_number: string;
      fta_irn: string | null;
      customer_id: string | null;
    } | null = null;

    if (isReversal) {
      const rows = await tx<
        {
          id: string;
          invoice_number: string;
          fta_irn: string | null;
          customer_id: string | null;
          status: string;
        }[]
      >`
        SELECT id, invoice_number, fta_irn, customer_id, status::text AS status
        FROM invoices
        WHERE tenant_id = ${options.tenantId}
          AND direction = 'OUTBOUND_SALES_AR'
          AND invoice_number = ${body.precedingInvoiceNumber!}
      `;
      const original = rows[0];
      if (!original) throw notFound(`Invoice ${body.precedingInvoiceNumber}`);
      if (original.status === 'DRAFT' || original.status === 'PENDING_CFO_APPROVAL') {
        throw badRequest(
          `Invoice ${original.invoice_number} has not been filed yet. Correct it rather than crediting it.`,
        );
      }
      referenced = original;
      invoice = { ...invoice, precedingInvoiceId: original.invoice_number };
    }

    if (!invoice.invoiceNumber.trim()) {
      invoice = {
        ...invoice,
        invoiceNumber: await nextNumber(tx, options.tenantId, invoice.invoiceType),
      };
    }

    invoice = recalcInvoice(invoice);

    // The sender's own totals, checked rather than used. Two systems that
    // disagree about what an invoice comes to have a bug in one of them, and an
    // integrator would far rather learn that here than from a tax return.
    assertTotalsAgree(body, invoice);

    const willFile = options.canFile && !body.holdForApproval;
    if (willFile) await assertCanFile(tx, options.tenantId);

    const validation = await validateDocument(tx, options.tenantId, invoice, null);
    const lineIndexById = new Map(
      invoice.lines.map((line, index) => [line.id, index + 1] as const),
    );
    const findings = toApiFindings(validation.findings, lineIndexById);

    if (!validation.submittable) {
      throw unprocessable('This invoice did not pass UAE e-invoicing validation.', {
        findings: findings.filter((f) => f.severity === 'ERROR' || f.severity === 'FATAL'),
      });
    }

    const status: InvoiceStatus = willFile ? 'VALIDATED' : 'PENDING_CFO_APPROVAL';

    const invoiceId = await insertDocument(tx, {
      tenantId: options.tenantId,
      createdByUserId: options.userId,
      createdByApiKeyId: options.apiKeyId,
      invoice,
      customerId: customerId ?? referenced?.customer_id ?? null,
      invoiceTypeDbValue: typeSpec?.dbValue ?? 'TAX_INVOICE',
      status,
      sourceChannel: 'REST_API',
      // A machine caller has no user row to attribute the release to; the audit
      // entry and `created_by_api_key_id` carry that instead.
      approvedByUserId: willFile ? options.userId : null,
      referenced,
      creditNote: isReversal
        ? {
            reasonCode: body.reasonCode ?? null,
            reversalMode: null,
            notes: body.note ?? null,
          }
        : null,
      // §10.6: this document came *from* an ERP, so there is a row over there
      // waiting to be told what the tax authority said about it.
      erpReverseSyncStatus: 'PENDING',
    });

    await writeLines(tx, options.tenantId, invoiceId, invoice);

    return { invoiceId, invoice, status, willFile, findings };
  });

  if (result.willFile) {
    await queueSubmission(result.invoiceId, options.tenantId, options.userId ?? result.invoiceId);
  }

  return {
    invoiceId: result.invoiceId,
    queued: result.willFile,
    response: {
      id: result.invoiceId,
      invoiceNumber: result.invoice.invoiceNumber,
      status: result.status,
      queued: result.willFile,
      pendingApproval: !result.willFile,
      // Only warnings survive to here — anything blocking became a 422 above.
      findings: result.findings,
      totals: {
        taxExclusiveAmount: result.invoice.taxExclusiveAmount,
        vatTotalAmount: result.invoice.vatTotalAmount,
        payableAmount: result.invoice.payableAmount,
        payableAmountAed: result.invoice.payableAmountAed,
        currency: result.invoice.currency,
      },
      duplicate: false,
    },
  };
}

/**
 * Compare the sender's stated totals with the computed ones.
 *
 * Deliberately exact rather than tolerant. A one-fils difference is a rounding
 * rule the two systems implement differently, and that difference does not stay
 * one fils across ten thousand invoices — it becomes a VAT return that does not
 * reconcile. The sender is told which figure disagreed and by how much.
 */
function assertTotalsAgree(body: IngestInvoiceRequest, invoice: StagedInvoice): void {
  if (!body.totals) return;

  const comparisons: [string, string | undefined, string][] = [
    ['taxExclusiveAmount', body.totals.taxExclusiveAmount, invoice.taxExclusiveAmount],
    ['vatTotalAmount', body.totals.vatTotalAmount, invoice.vatTotalAmount],
    ['payableAmount', body.totals.payableAmount, invoice.payableAmount],
  ];

  const mismatches = comparisons
    .filter(([, stated]) => stated !== undefined)
    .filter(([, stated, computed]) => Number(stated) !== Number(computed))
    .map(([field, stated, computed]) => ({ field, stated, computed }));

  if (mismatches.length > 0) {
    throw unprocessable(
      'The totals you sent do not match the totals computed from your lines.',
      { mismatches },
    );
  }
}
