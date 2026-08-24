import { create } from 'xmlbuilder2';
import { UAE_TRN_SCHEME_ID } from './invoice.js';

/**
 * Peppol BIS Invoice Response 3.0 — the ApplicationResponse document.
 *
 * This is the message that carries a commercial verdict between trading
 * partners, and the platform builds it in both directions (SRS v2.7 §11, §12.3):
 *
 *   Outbound (Module 2 / AP) — our own AP desk accepts, queries or rejects a
 *     supplier's purchase invoice, and this document is what tells them.
 *   Inbound  (Module 1 / AR) — a buyer sends us the same document about one of
 *     our sales invoices; `parseApplicationResponse` reads it.
 *
 * Note it is NOT a clearance message. The FTA has already accepted the invoice;
 * this is the trade dispute that follows, and its statuses live on a separate
 * axis from the clearance ones.
 */

const NS = {
  response: 'urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
} as const;

export const RESPONSE_CUSTOMIZATION_ID =
  'urn:fdc:peppol.eu:poacc:trns:invoice_response:3';
export const RESPONSE_PROFILE_ID = 'urn:fdc:peppol.eu:poacc:bis:invoice_response:3';

export type ResponseCode = 'AB' | 'IP' | 'UQ' | 'CA' | 'AP' | 'RE';
export type ReasonCode = 'REF' | 'PRI' | 'QTY' | 'ITM' | 'DEL' | 'NON' | 'OTH';

export interface ResponseParty {
  trn: string | null;
  name: string;
}

export interface BuildApplicationResponseOptions {
  /** Stable UUID for this response document. */
  responseUuid: string;
  /** Identifier of the response itself, distinct from the invoice's. */
  responseId: string;
  issueDate: string;
  issueTime: string;
  /** The party issuing the verdict — us, when our AP desk rejects a bill. */
  sender: ResponseParty;
  /** The party that issued the invoice being responded to. */
  recipient: ResponseParty;
  /** The document under judgement. */
  document: {
    invoiceNumber: string;
    issueDate: string;
    /** The invoice's own Peppol UUID, when we know it. */
    peppolUuid?: string | null;
  };
  responseCode: ResponseCode;
  /** Required in practice for UQ and RE; meaningless for AP. */
  reasonCode?: ReasonCode | null;
  /** Free text the clerk typed. Peppol allows one description per response. */
  description?: string | null;
}

export function buildApplicationResponseXml(
  options: BuildApplicationResponseOptions,
): string {
  const doc = create({ version: '1.0', encoding: 'UTF-8' }).ele('ApplicationResponse', {
    xmlns: NS.response,
    'xmlns:cac': NS.cac,
    'xmlns:cbc': NS.cbc,
  });

  doc.ele('cbc:CustomizationID').txt(RESPONSE_CUSTOMIZATION_ID);
  doc.ele('cbc:ProfileID').txt(RESPONSE_PROFILE_ID);
  doc.ele('cbc:ID').txt(options.responseId);
  doc.ele('cbc:IssueDate').txt(options.issueDate);
  doc.ele('cbc:IssueTime').txt(options.issueTime);

  party(doc, 'cac:SenderParty', options.sender);
  party(doc, 'cac:ReceiverParty', options.recipient);

  // --- The verdict ---------------------------------------------------------
  const documentResponse = doc.ele('cac:DocumentResponse');

  const response = documentResponse.ele('cac:Response');
  response.ele('cbc:ResponseCode').txt(options.responseCode).up();
  if (options.description?.trim()) {
    response.ele('cbc:Description').txt(options.description.trim()).up();
  }

  // The reason rides inside the Response as a Status block. A rejection with no
  // reason is technically well-formed and commercially useless — the supplier
  // has been told "no" with no way to act on it — so callers are expected to
  // supply one and the AP contract enforces it before we get here.
  if (options.reasonCode) {
    const status = response.ele('cac:Status');
    status.ele('cbc:StatusReasonCode', { listID: 'OPStatusReason' }).txt(options.reasonCode).up();
    if (options.description?.trim()) {
      status.ele('cbc:StatusReason').txt(options.description.trim()).up();
    }
    status.up();
  }
  response.up();

  const reference = documentResponse.ele('cac:DocumentReference');
  reference.ele('cbc:ID').txt(options.document.invoiceNumber).up();
  if (options.document.peppolUuid) {
    reference.ele('cbc:UUID').txt(options.document.peppolUuid).up();
  }
  reference.ele('cbc:IssueDate').txt(options.document.issueDate).up();
  reference.ele('cbc:DocumentTypeCode').txt('380').up();
  reference.up();

  documentResponse.up();

  return doc.end({ prettyPrint: true, indent: '  ' });
}

function party(
  doc: ReturnType<typeof create> | ReturnType<ReturnType<typeof create>['ele']>,
  element: string,
  value: ResponseParty,
) {
  const node = (doc as ReturnType<ReturnType<typeof create>['ele']>).ele(element);
  if (value.trn) {
    node.ele('cbc:EndpointID', { schemeID: UAE_TRN_SCHEME_ID }).txt(value.trn).up();
    node
      .ele('cac:PartyIdentification')
      .ele('cbc:ID', { schemeID: UAE_TRN_SCHEME_ID })
      .txt(value.trn)
      .up()
      .up();
  }
  node
    .ele('cac:PartyLegalEntity')
    .ele('cbc:RegistrationName')
    .txt(value.name)
    .up()
    .up();
  node.up();
}

// ===========================================================================
// Reading a response someone else sent us
// ===========================================================================

export interface ParsedApplicationResponse {
  responseId: string | null;
  responseUuid: string | null;
  issueDate: string | null;
  /** The invoice being responded to. */
  invoiceNumber: string | null;
  invoicePeppolUuid: string | null;
  responseCode: ResponseCode | null;
  reasonCode: ReasonCode | null;
  description: string | null;
  senderTrn: string | null;
}

const RESPONSE_CODES: ResponseCode[] = ['AB', 'IP', 'UQ', 'CA', 'AP', 'RE'];
const REASON_CODES: ReasonCode[] = ['REF', 'PRI', 'QTY', 'ITM', 'DEL', 'NON', 'OTH'];

/**
 * Pull the fields we act on out of an inbound ApplicationResponse.
 *
 * Deliberately a targeted extraction rather than a full UBL object model: we
 * respond to five values, and a document that carries extra structure we do not
 * understand should still be processed rather than rejected. Anything the
 * regexes cannot find comes back null, and the caller decides whether that is
 * fatal.
 */
export function parseApplicationResponse(xml: string): ParsedApplicationResponse {
  const code = firstMatch(xml, /<cbc:ResponseCode[^>]*>([^<]+)<\/cbc:ResponseCode>/);
  const reason = firstMatch(xml, /<cbc:StatusReasonCode[^>]*>([^<]+)<\/cbc:StatusReasonCode>/);

  // The DocumentReference block names the invoice. Scoping the ID lookup to it
  // matters: the response's own cbc:ID appears earlier in the document and
  // would otherwise be read as the invoice number.
  const documentReference = firstMatch(
    xml,
    /<cac:DocumentReference>([\s\S]*?)<\/cac:DocumentReference>/,
  );

  return {
    responseId: firstMatch(xml, /<cbc:ID[^>]*>([^<]+)<\/cbc:ID>/),
    responseUuid: firstMatch(xml, /<cbc:UUID[^>]*>([^<]+)<\/cbc:UUID>/),
    issueDate: firstMatch(xml, /<cbc:IssueDate[^>]*>([^<]+)<\/cbc:IssueDate>/),
    invoiceNumber: documentReference
      ? firstMatch(documentReference, /<cbc:ID[^>]*>([^<]+)<\/cbc:ID>/)
      : null,
    invoicePeppolUuid: documentReference
      ? firstMatch(documentReference, /<cbc:UUID[^>]*>([^<]+)<\/cbc:UUID>/)
      : null,
    responseCode: RESPONSE_CODES.includes(code as ResponseCode) ? (code as ResponseCode) : null,
    reasonCode: REASON_CODES.includes(reason as ReasonCode) ? (reason as ReasonCode) : null,
    description:
      firstMatch(xml, /<cbc:StatusReason[^>]*>([^<]+)<\/cbc:StatusReason>/) ??
      firstMatch(xml, /<cbc:Description[^>]*>([^<]+)<\/cbc:Description>/),
    senderTrn: firstMatch(
      firstMatch(xml, /<cac:SenderParty>([\s\S]*?)<\/cac:SenderParty>/) ?? '',
      /<cbc:EndpointID[^>]*>([^<]+)<\/cbc:EndpointID>/,
    ),
  };
}

function firstMatch(source: string, pattern: RegExp): string | null {
  const match = pattern.exec(source);
  return match?.[1] ? decodeEntities(match[1].trim()) : null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
