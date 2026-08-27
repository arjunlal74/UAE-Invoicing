import { PAYMENT_MEANS_CODES, UOM_CODES } from '@uae/domain';
import { z } from 'zod';
import { InvoiceStatus, ValidationSeverity } from './enums.js';
import { Permission } from './permissions.js';

/**
 * Ingestion channel 1 — the programmatic API (SRS v1.2 §"POST /v1/invoices",
 * v2.1 §1.2).
 *
 * This is the one contract in the system that a third party writes code
 * against, so it is deliberately *not* the internal `StagedInvoiceDto`. That
 * shape carries a synthetic row id, a spreadsheet row number and a full set of
 * pre-computed totals, all of which exist to serve the staging grid and none of
 * which an ERP should have to know about or get right.
 *
 * What an ERP knows is: who the buyer is, what was supplied, and what it costs
 * per unit. Everything derivable from that — line nets, VAT per line, document
 * totals — is derived here, because the platform is going to recompute it
 * before filing anyway and a contract that asks for a number it intends to
 * overwrite is a contract that invites a silent disagreement.
 */

const money = z
  .string()
  .trim()
  .regex(/^-?\d{1,15}(\.\d{1,6})?$/, 'Expected a decimal amount as a string');

/** Amounts travel as strings. A JSON number cannot hold 0.1 + 0.2 honestly. */
const optionalMoney = money.optional();

export const IngestLine = z.object({
  /** Free text as it should read on the printed invoice. */
  description: z.string().trim().min(1).max(500),
  /** Harmonised System code, where the supply is goods. */
  hsCode: z.string().trim().max(20).optional(),
  quantity: money,
  /**
   * UN/ECE Rec 20 unit code. Constrained to the list the UAE validator accepts
   * rather than left open: a sender who writes `EA` for "each" should be told
   * so by the schema, in the same response as every other shape problem, not by
   * a tax-rule failure three layers down that reads like the invoice was wrong.
   */
  uom: z.enum(UOM_CODES).default('PCE'),
  unitPrice: money,
  /** Line-level discount, already in currency. Defaults to zero. */
  discount: optionalMoney,
  /** UBL tax category: S standard, Z zero-rated, E exempt, O out of scope. */
  vatCategory: z.enum(['S', 'Z', 'E', 'O']).default('S'),
  /**
   * The rate is fixed by the category, so this is accepted only so that a
   * sender can state what it believes and be told when the two disagree.
   */
  vatRate: optionalMoney,
});
export type IngestLine = z.infer<typeof IngestLine>;

export const IngestBuyer = z.object({
  /**
   * A customer already in the §6 directory. When given, the buyer block is
   * read from that record and the fields below are ignored — the directory is
   * the tenant's own maintained truth about who it bills.
   */
  customerId: z.string().uuid().optional(),
  /** Or the tenant's own code for the customer, which an ERP is likelier to hold. */
  customerCode: z.string().trim().max(50).optional(),
  name: z.string().trim().max(255).optional(),
  /** Required for a B2B tax invoice; absent is what makes a document simplified. */
  trn: z.string().trim().max(15).optional(),
  emirate: z.string().trim().max(50).optional(),
});
export type IngestBuyer = z.infer<typeof IngestBuyer>;

export const IngestInvoiceRequest = z.object({
  /**
   * Omit to have the platform assign the next number in the tenant's series.
   * An ERP that owns its own numbering should always send one — the uniqueness
   * constraint is then what stops the same document being filed twice.
   */
  invoiceNumber: z.string().trim().max(100).optional(),
  /** UN/CEFACT 1001: 380 tax invoice, 388 simplified, 381 credit, 383 debit. */
  invoiceType: z.enum(['380', '388', '381', '383']).default('380'),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').optional(),
  issueTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Expected HH:MM or HH:MM:SS').optional(),
  currency: z.string().trim().length(3).default('AED'),
  /** Required when `currency` is not AED; the FTA wants the AED equivalent. */
  exchangeRate: optionalMoney,

  buyer: IngestBuyer,

  poReference: z.string().trim().max(100).optional(),
  /**
   * UN/ECE 4461 payment means. Required by BR-UAE-30, so it defaults to bank
   * transfer — far and away the common case for a B2B invoice, and better than
   * refusing a payload for a field most ERPs do not model at all. A customer's
   * own default in the §6 directory takes precedence over this.
   */
  paymentMeans: z.enum(PAYMENT_MEANS_CODES).optional(),

  /**
   * The document being corrected. Required for 381 and 383, and named by
   * *number* rather than by our internal id — a sending ERP holds the invoice
   * number it issued and has never seen our primary keys.
   */
  precedingInvoiceNumber: z.string().trim().max(100).optional(),
  /** Why the correction was issued (§8.2 reason codes). */
  reasonCode: z.enum(['REF', 'PRI', 'QTY', 'ITM', 'DEL', 'NON', 'OTH']).optional(),
  note: z.string().trim().max(1000).optional(),

  lines: z.array(IngestLine).min(1, 'An invoice must have at least one line').max(1000),

  /**
   * What the sender believes the document comes to. Optional, and checked
   * rather than used: a mismatch means the two systems disagree about the
   * arithmetic, and an ERP would far rather hear that on submission than
   * discover it in a tax return.
   */
  totals: z
    .object({
      taxExclusiveAmount: optionalMoney,
      vatTotalAmount: optionalMoney,
      payableAmount: optionalMoney,
    })
    .optional(),

  /**
   * Hold the document for a human to release even when the key could file it
   * outright. An ERP rolling out to production uses this to prove the feed is
   * correct before letting it reach the tax authority unattended.
   */
  holdForApproval: z.boolean().default(false),
});
export type IngestInvoiceRequest = z.infer<typeof IngestInvoiceRequest>;

export const IngestFinding = z.object({
  ruleCode: z.string(),
  severity: ValidationSeverity,
  message: z.string(),
  /** The field the rule objected to, in the language of this API. */
  field: z.string(),
  /** Set when the objection is to a specific line, 1-based. */
  line: z.number().nullable(),
});
export type IngestFinding = z.infer<typeof IngestFinding>;

export const IngestInvoiceResponse = z.object({
  /** The platform's identifier. Stable, and what `GET .../status/{id}` takes. */
  id: z.string().uuid(),
  invoiceNumber: z.string(),
  status: InvoiceStatus,
  /** True once the document is on its way to the tax authority. */
  queued: z.boolean(),
  /** True when it is parked for a human to release (§16). */
  pendingApproval: z.boolean(),
  /** Warnings that did not block filing. Errors come back as a 422 instead. */
  findings: z.array(IngestFinding),
  totals: z.object({
    taxExclusiveAmount: z.string(),
    vatTotalAmount: z.string(),
    payableAmount: z.string(),
    payableAmountAed: z.string(),
    currency: z.string(),
  }),
  /** True when this response was replayed from a previous identical request. */
  duplicate: z.boolean(),
});
export type IngestInvoiceResponse = z.infer<typeof IngestInvoiceResponse>;

/**
 * The asynchronous status an ERP polls for.
 *
 * Named by invoice number rather than by our id because that is what the
 * sending system stored on its own ledger row.
 */
export const InvoiceStatusResponse = z.object({
  id: z.string().uuid(),
  invoiceNumber: z.string(),
  status: InvoiceStatus,
  /** The clearance identifier, once the tax authority has issued one. */
  ftaIrn: z.string().nullable(),
  /** Why the authority refused it, when it did. */
  rejectionReason: z.string().nullable(),
  /** The counterparty's verdict once they have given one (§11). */
  buyerResponseCode: z.string().nullable(),
  isDisputed: z.boolean(),
  submittedAt: z.string().nullable(),
  clearedAt: z.string().nullable(),
  totals: z.object({
    taxExclusiveAmount: z.string(),
    vatTotalAmount: z.string(),
    payableAmount: z.string(),
    payableAmountAed: z.string(),
    currency: z.string(),
  }),
});
export type InvoiceStatusResponse = z.infer<typeof InvoiceStatusResponse>;

// ---------------------------------------------------------------------------
// Key management (portal-facing)
// ---------------------------------------------------------------------------

export const CreateApiKeyRequest = z.object({
  name: z.string().trim().min(1, 'Give the key a name').max(120),
  scopes: z.array(Permission).min(1, 'A key with no scopes can do nothing'),
  /** ISO date. Omit for a key that does not expire on its own. */
  expiresAt: z.string().datetime().nullable().optional(),
  /**
   * Bind an SFTP drop directory to this key (§1.2 channel 1, SFTP limb). The
   * key's scopes then govern what a file left in that directory may do, and
   * revoking the key closes it. It is a filesystem path segment, so the
   * character set is narrow and it is unique across the whole platform rather
   * than per tenant.
   */
  sftpUsername: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z][a-z0-9_-]{2,31}$/,
      'Use 3–32 characters: a letter first, then lower-case letters, digits, hyphen or underscore',
    )
    .nullable()
    .optional(),
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequest>;

export const ApiKeySummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** The non-secret leading segment, for telling two keys apart. */
  keyPrefix: z.string(),
  scopes: z.array(z.string()),
  /** The drop directory this key owns, when one is bound. */
  sftpUsername: z.string().nullable(),
  createdByName: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ApiKeySummary = z.infer<typeof ApiKeySummary>;

export const CreatedApiKey = z.object({
  key: ApiKeySummary,
  /** Returned exactly once, at creation. The platform stores only a hash. */
  token: z.string(),
});
export type CreatedApiKey = z.infer<typeof CreatedApiKey>;
