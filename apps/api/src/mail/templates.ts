import { PASSWORD_RULES } from '@uae/contracts';
import { config } from '../config.js';

/**
 * The transactional templates of SRS v2.3 §5.
 *
 * Four of them, and the distinction between the first two matters: a direct
 * tenant is told the platform provisioned their account, while a managed
 * sub-tenant is told their accountant did, and is pointed at that accountant
 * rather than at us for help. Sending A to a managed client would have them
 * chasing a support desk that has never heard of them.
 *
 * Plain inline-styled HTML with a text alternative, because mail clients are
 * not browsers. Every interpolated value is escaped: a company name is
 * user-supplied and ends up inside markup.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

function platform() {
  const cfg = config();
  return {
    name: cfg.PLATFORM_NAME,
    supportEmail: cfg.SUPPORT_EMAIL,
    supportPhone: cfg.SUPPORT_PHONE,
  };
}

function layout(heading: string, bodyHtml: string): string {
  const { name } = platform();
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;">
      <tr>
        <td style="padding:20px 24px;background:#1e3a5f;border-radius:8px 8px 0 0;color:#ffffff;">
          <span style="display:inline-block;padding:4px 8px;background:rgba(255,255,255,0.15);border-radius:4px;font-size:12px;font-weight:700;letter-spacing:0.05em;">UAE</span>
          <span style="margin-left:8px;font-size:14px;font-weight:600;">${escapeHtml(name)}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:24px;">
          <h1 style="margin:0 0 16px;font-size:18px;font-weight:600;">${escapeHtml(heading)}</h1>
          ${bodyHtml}
        </td>
      </tr>
      <tr>
        <td style="padding:16px 24px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;">
          This is an automated message from ${escapeHtml(name)}.
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function actionButton(url: string, label: string): string {
  return `<p style="margin:24px 0;">
       <a href="${escapeHtml(url)}"
          style="display:inline-block;padding:12px 20px;background:#1e5aa8;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">
         ${escapeHtml(label)}
       </a>
     </p>
     <p style="margin:0 0 12px;font-size:12px;line-height:1.6;color:#64748b;word-break:break-all;">
       If the button does not work, copy this address into your browser:<br>${escapeHtml(url)}
     </p>`;
}

/** §3.2 requires the rules to appear in the activation mail itself. */
function requirementsHtml(): string {
  const items = PASSWORD_RULES.map((r) => `<li>${escapeHtml(r.label)}</li>`).join('');
  return `<p style="margin:0 0 4px;font-size:13px;font-weight:600;">Required specifications:</p>
     <ul style="margin:0 0 12px;padding-left:20px;font-size:13px;line-height:1.6;color:#475569;">${items}</ul>`;
}

function requirementsText(): string {
  return ['Required specifications:', ...PASSWORD_RULES.map((r) => `  - ${r.label}`)].join('\n');
}

const EXPIRY_NOTICE = 'Security notice: this link remains active for exactly 24 hours.';

/**
 * Template A — direct tenants and channel partners (§5.1).
 *
 * Sent when the platform itself provisioned the account.
 */
export function renderActivationDirect(params: {
  contactName: string;
  companyName: string;
  activationUrl: string;
}): RenderedMail {
  const { name, supportEmail } = platform();
  const { contactName, companyName, activationUrl } = params;

  const html = layout(
    'Set up your account',
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">Dear ${escapeHtml(contactName)},</p>
     <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
       Welcome to ${escapeHtml(name)}. Your business profile for
       <strong>${escapeHtml(companyName)}</strong> is ready.
     </p>
     <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
       Our platform assists you in preparing and executing your UAE VAT submissions seamlessly.
       To start provisioning your secure profile, use the link below to establish a password.
     </p>
     ${actionButton(activationUrl, 'Set up your password')}
     <p style="margin:0 0 12px;font-size:13px;line-height:1.6;color:#475569;">${EXPIRY_NOTICE}</p>
     ${requirementsHtml()}
     <p style="margin:0;font-size:13px;line-height:1.6;color:#475569;">
       If you did not authorise this configuration, contact our security centre at
       ${escapeHtml(supportEmail)}.
     </p>`,
  );

  const text = [
    `Dear ${contactName},`,
    '',
    `Welcome to ${name}. Your business profile for ${companyName} is ready.`,
    '',
    'To start provisioning your secure profile, open the link below to establish a password:',
    '',
    activationUrl,
    '',
    EXPIRY_NOTICE,
    '',
    requirementsText(),
    '',
    `If you did not authorise this configuration, contact our security centre at ${supportEmail}.`,
  ].join('\n');

  return { subject: `Action required: set up your ${name} account`, html, text };
}

/**
 * Template B — managed sub-tenants (§5.2).
 *
 * The partner provisioned this one, so the help pointer is the partner, not us.
 */
export function renderActivationManaged(params: {
  contactName: string;
  companyName: string;
  partnerName: string;
  partnerContactEmail: string | null;
  activationUrl: string;
}): RenderedMail {
  const { name } = platform();
  const { contactName, companyName, partnerName, partnerContactEmail, activationUrl } = params;
  const partnerContact = partnerContactEmail ?? platform().supportEmail;

  const html = layout(
    'Set up your client account',
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">Dear ${escapeHtml(contactName)},</p>
     <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
       Your tax advisory team at <strong>${escapeHtml(partnerName)}</strong> has provisioned a
       billing instance for <strong>${escapeHtml(companyName)}</strong> on ${escapeHtml(name)}.
     </p>
     <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
       You can use this console to securely examine incoming financial worksheets, confirm
       submitted UAE VAT data, and export your corporate ledgers.
     </p>
     ${actionButton(activationUrl, 'Activate my account and set a password')}
     <p style="margin:0 0 12px;font-size:13px;line-height:1.6;color:#475569;">${EXPIRY_NOTICE}</p>
     ${requirementsHtml()}
     <p style="margin:0;font-size:13px;line-height:1.6;color:#475569;">
       For general profile and setup queries, coordinate directly with your advisory
       representative at ${escapeHtml(partnerContact)}.
     </p>`,
  );

  const text = [
    `Dear ${contactName},`,
    '',
    `Your tax advisory team at ${partnerName} has provisioned a billing instance for ${companyName} on ${name}.`,
    '',
    'To activate your secure login workspace, open the link below and set your password:',
    '',
    activationUrl,
    '',
    EXPIRY_NOTICE,
    '',
    requirementsText(),
    '',
    `For setup queries, coordinate with your advisory representative at ${partnerContact}.`,
  ].join('\n');

  return { subject: `Welcome to ${name} — set up your client account`, html, text };
}

/** Template C — password reset (§5.3). */
export function renderPasswordReset(params: {
  contactName: string;
  companyName: string | null;
  resetUrl: string;
}): RenderedMail {
  const { name } = platform();
  const { contactName, companyName, resetUrl } = params;
  const account = companyName ? ` associated with ${companyName}` : '';

  const html = layout(
    'Reset your password',
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">Dear ${escapeHtml(contactName)},</p>
     <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
       We received a request to change the access parameters for your ${escapeHtml(name)} account${escapeHtml(account)}.
     </p>
     ${actionButton(resetUrl, 'Reset my password')}
     <p style="margin:0 0 12px;font-size:13px;line-height:1.6;color:#475569;">
       Security notice: this request link auto-expires within 24 hours.
     </p>
     ${requirementsHtml()}
     <p style="margin:0;font-size:13px;line-height:1.6;color:#475569;">
       If you did not trigger this request you can ignore this message. Your existing credentials
       remain secure and operational.
     </p>`,
  );

  const text = [
    `Dear ${contactName},`,
    '',
    `We received a request to change the access parameters for your ${name} account${account}.`,
    '',
    'To establish a new password, open the link below:',
    '',
    resetUrl,
    '',
    'Security notice: this request link auto-expires within 24 hours.',
    '',
    requirementsText(),
    '',
    'If you did not trigger this request you can ignore this message. Your existing credentials remain secure and operational.',
  ].join('\n');

  return { subject: `Reset your password for ${name}`, html, text };
}

/**
 * Template D — password changed confirmation (§5.4).
 *
 * Sent after the fact, and the only one of the four that is a warning rather
 * than an invitation: for the person who did not make this change, it is the
 * one chance to notice.
 */
export function renderPasswordChanged(params: {
  contactName: string;
  companyName: string | null;
  changedAt: Date;
  ip: string | null;
}): RenderedMail {
  const { name, supportEmail, supportPhone } = platform();
  const { contactName, companyName, changedAt, ip } = params;
  const account = companyName ? ` associated with ${companyName}` : '';
  const when = `${changedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
  const from = ip ? ` from IP address ${ip}` : '';
  const phone = supportPhone ? ` or call ${supportPhone}` : '';

  const html = layout(
    'Your password was updated',
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">Dear ${escapeHtml(contactName)},</p>
     <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
       The password for your account${escapeHtml(account)} was successfully updated on
       <strong>${escapeHtml(when)}</strong>${escapeHtml(from)}.
     </p>
     <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
       All previous active sessions have been terminated. If you authorised this change, no
       further action is required.
     </p>
     <p style="margin:0;padding:12px;border-radius:6px;background:#fef2f2;border:1px solid #fecaca;font-size:13px;line-height:1.6;color:#991b1b;">
       <strong>Security warning:</strong> if you did not make this change your account may be
       compromised. Contact our security operations centre immediately at
       ${escapeHtml(supportEmail)}${escapeHtml(phone)}.
     </p>`,
  );

  const text = [
    `Dear ${contactName},`,
    '',
    `The password for your account${account} was successfully updated on ${when}${from}.`,
    'All previous active sessions have been terminated.',
    '',
    'If you authorised this change, no further action is required.',
    '',
    `Security warning: if you did not make this change your account may be compromised. Contact our security operations centre immediately at ${supportEmail}${phone}.`,
  ].join('\n');

  return { subject: `Security alert: your ${name} password was updated`, html, text };
}

/** Not part of §5 — used by the mail settings screen to prove a server works. */
export function renderTest(params: { sentBy: string; host: string }): RenderedMail {
  const html = layout(
    'Mail configuration test',
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
       This test message confirms that the portal can send mail through
       <strong>${escapeHtml(params.host)}</strong>.
     </p>
     <p style="margin:0;font-size:13px;color:#475569;">Requested by ${escapeHtml(params.sentBy)}.</p>`,
  );

  const text = `This test message confirms that the portal can send mail through ${params.host}.\n\nRequested by ${params.sentBy}.`;

  return { subject: `${platform().name} — test message`, html, text };
}

/**
 * Account locked alert.
 *
 * §4.4 step 2 requires this dispatch but §5 defines no template for it, so it
 * is built from the same furniture as the four that are specified. Kept short:
 * its whole job is to tell someone that failures they did not cause are
 * happening, and to point at the way out.
 */
export function renderAccountLocked(params: {
  contactName: string;
  lockMinutes: number;
  ip: string | null;
  resetUrl: string;
}): RenderedMail {
  const { name, supportEmail } = platform();
  const { contactName, lockMinutes, ip, resetUrl } = params;
  const from = ip ? ` The most recent attempt came from IP address ${ip}.` : '';

  const html = layout(
    'Your account has been locked',
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">Dear ${escapeHtml(contactName)},</p>
     <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
       Your ${escapeHtml(name)} account has been locked for ${lockMinutes} minutes after several
       consecutive failed sign-in attempts.${escapeHtml(from)}
     </p>
     <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
       It will unlock by itself once that period passes. To regain access immediately, reset your
       password.
     </p>
     ${actionButton(resetUrl, 'Reset my password')}
     <p style="margin:0;padding:12px;border-radius:6px;background:#fffbeb;border:1px solid #fde68a;font-size:13px;line-height:1.6;color:#92400e;">
       If these attempts were not yours, someone may be trying to reach your account. Contact
       ${escapeHtml(supportEmail)}.
     </p>`,
  );

  const text = [
    `Dear ${contactName},`,
    '',
    `Your ${name} account has been locked for ${lockMinutes} minutes after several consecutive failed sign-in attempts.${from}`,
    '',
    'It will unlock by itself once that period passes. To regain access immediately, reset your password:',
    '',
    resetUrl,
    '',
    `If these attempts were not yours, contact ${supportEmail}.`,
  ].join('\n');

  return { subject: `Security alert: your ${name} account was locked`, html, text };
}

// ===========================================================================
// SRS v2.7 §5.5 and §5.6 — the two module templates
// ===========================================================================
// These differ in kind from A–D. Those are addressed to a person about their
// own account; these are addressed to a *desk* about a document with a deadline
// attached. Both therefore lead with what happened and what it is worth, and
// end with the single action that resolves it.

/** A small labelled table, used by all three operational templates below. */
function detailRows(rows: [string, string][]): string {
  const cells = rows
    .map(
      ([label, value]) => `<tr>
         <td style="padding:4px 12px 4px 0;font-size:13px;color:#64748b;white-space:nowrap;">${escapeHtml(label)}</td>
         <td style="padding:4px 0;font-size:13px;color:#0f172a;font-weight:500;">${escapeHtml(value)}</td>
       </tr>`,
    )
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">${cells}</table>`;
}

/**
 * Template E — commercial rejection / dispute alert (Module 1 AR, §5.5).
 *
 * Sent the moment a buyer returns UQ or RE against a cleared sales invoice. The
 * call to action is the credit note builder rather than the invoice screen,
 * because under UAE VAT law the cleared document cannot be amended and a
 * corrective 381 is the only thing that resolves the dispute.
 */
export function renderDisputeAlert(params: {
  invoiceNumber: string;
  buyerName: string;
  ftaIrn: string | null;
  responseStatus: string;
  reasonCode: string | null;
  reasonLabel: string | null;
  comments: string | null;
  creditNoteUrl: string;
}): RenderedMail {
  const rows: [string, string][] = [
    ['Invoice number', params.invoiceNumber],
    ['Buyer', params.buyerName],
  ];
  if (params.ftaIrn) rows.push(['FTA IRN', params.ftaIrn]);
  rows.push(['Response status', params.responseStatus]);
  if (params.reasonCode) {
    rows.push([
      'Reason code',
      `${params.reasonCode}${params.reasonLabel ? ` — ${params.reasonLabel}` : ''}`,
    ]);
  }

  const comment = params.comments
    ? `<p style="margin:0 0 16px;padding:12px;border-radius:6px;background:#fef2f2;border:1px solid #fecaca;font-size:13px;line-height:1.6;color:#991b1b;">
         <strong>Buyer comment:</strong><br>${escapeHtml(params.comments)}
       </p>`
    : '';

  const html = layout(
    'A buyer has disputed a cleared invoice',
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">Dear Finance Team,</p>
     <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
       The cleared tax invoice <strong>${escapeHtml(params.invoiceNumber)}</strong> issued to
       <strong>${escapeHtml(params.buyerName)}</strong> has been disputed by the buyer over the
       Peppol network.
     </p>
     ${detailRows(rows)}
     ${comment}
     <p style="margin:0 0 4px;font-size:14px;line-height:1.6;">
       A cleared invoice cannot be amended or withdrawn. To correct it, issue a credit note
       (Type 381) that references the original document.
     </p>
     ${actionButton(params.creditNoteUrl, 'Open the credit note builder')}`,
  );

  const text = [
    'Dear Finance Team,',
    '',
    `The cleared tax invoice ${params.invoiceNumber} issued to ${params.buyerName} has been disputed by the buyer over the Peppol network.`,
    '',
    ...rows.map(([label, value]) => `  ${label}: ${value}`),
    ...(params.comments ? ['', `Buyer comment: "${params.comments}"`] : []),
    '',
    'A cleared invoice cannot be amended or withdrawn. To correct it, issue a credit note (Type 381) referencing the original document:',
    '',
    params.creditNoteUrl,
  ].join('\n');

  return {
    subject: `Action required: invoice ${params.invoiceNumber} disputed by ${params.buyerName}`,
    html,
    text,
  };
}

/**
 * Template F — inbound purchase invoice received (Module 2 AP, §5.6).
 *
 * Carries the amount because that is what decides whether the recipient walks
 * over to the verification desk now or after lunch.
 */
export function renderInboundPurchaseInvoice(params: {
  supplierName: string;
  supplierTrn: string | null;
  invoiceNumber: string;
  ftaIrn: string | null;
  totalAmount: string;
  vatAmount: string;
  currency: string;
  isNewSupplier: boolean;
  deskUrl: string;
}): RenderedMail {
  const rows: [string, string][] = [['Supplier', params.supplierName]];
  if (params.supplierTrn) rows.push(['Supplier TRN', params.supplierTrn]);
  rows.push(['Invoice number', params.invoiceNumber]);
  if (params.ftaIrn) rows.push(['FTA IRN', params.ftaIrn]);
  rows.push(
    ['Total payable', `${params.currency} ${params.totalAmount}`],
    ['Of which VAT', `${params.currency} ${params.vatAmount}`],
  );

  const newSupplier = params.isNewSupplier
    ? `<p style="margin:0 0 16px;padding:12px;border-radius:6px;background:#fffbeb;border:1px solid #fde68a;font-size:13px;line-height:1.6;color:#92400e;">
         This is the first invoice received from this TRN. A provisional supplier record has been
         created; confirm the bank and contact details before authorising payment.
       </p>`
    : '';

  const html = layout(
    'New purchase invoice received',
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">Dear Accounts Payable Team,</p>
     <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
       A cleared purchase e-invoice has been received from
       <strong>${escapeHtml(params.supplierName)}</strong> over the FTA Peppol network.
     </p>
     ${detailRows(rows)}
     ${newSupplier}
     <p style="margin:0 0 4px;font-size:14px;line-height:1.6;">
       Verify the line items against your purchase order, then accept or reject the invoice. Input
       tax cannot be claimed until it is accepted.
     </p>
     ${actionButton(params.deskUrl, 'Open the purchase verification desk')}`,
  );

  const text = [
    'Dear Accounts Payable Team,',
    '',
    `A cleared purchase e-invoice has been received from ${params.supplierName} over the FTA Peppol network.`,
    '',
    ...rows.map(([label, value]) => `  ${label}: ${value}`),
    ...(params.isNewSupplier
      ? [
          '',
          'This is the first invoice received from this TRN. A provisional supplier record has been created; confirm the bank and contact details before authorising payment.',
        ]
      : []),
    '',
    'Verify the line items against your purchase order, then accept or reject the invoice:',
    '',
    params.deskUrl,
  ].join('\n');

  return {
    subject: `Action required: new purchase invoice ${params.invoiceNumber} from ${params.supplierName}`,
    html,
    text,
  };
}

/**
 * §15 threshold alert — 80%, 90% and 100% of a prepaid bundle.
 *
 * §5 defines no template for it, but §15 requires the notification, and a
 * tenant who discovers an exhausted bundle by being unable to file on the last
 * day of a VAT period has been failed by the platform rather than by their own
 * planning.
 */
export function renderQuotaThreshold(params: {
  contactName: string;
  companyName: string;
  threshold: number;
  purchasedUnits: number;
  consumedUnits: number;
  remainingUnits: number;
  hardCap: boolean;
  balanceUrl: string;
}): RenderedMail {
  const { name, supportEmail } = platform();
  const exhausted = params.threshold >= 100;

  const consequence = exhausted
    ? params.hardCap
      ? 'Filing is now blocked until the bundle is topped up.'
      : 'Filing continues under your overage agreement, and further documents will be invoiced.'
    : 'No action is required yet, but a top-up ordered now will avoid an interruption.';

  const html = layout(
    exhausted ? 'Your data bundle is exhausted' : `Your data bundle is ${params.threshold}% used`,
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">Dear ${escapeHtml(params.contactName)},</p>
     <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
       The prepaid data bundle for <strong>${escapeHtml(params.companyName)}</strong> has reached
       ${params.threshold}% of its capacity.
     </p>
     ${detailRows([
       ['Purchased', `${params.purchasedUnits.toLocaleString()} documents`],
       ['Consumed', `${params.consumedUnits.toLocaleString()} documents`],
       ['Remaining', `${Math.max(0, params.remainingUnits).toLocaleString()} documents`],
     ])}
     <p style="margin:0 0 4px;font-size:14px;line-height:1.6;">${escapeHtml(consequence)}</p>
     ${actionButton(params.balanceUrl, 'View usage and balance')}
     <p style="margin:0;font-size:13px;color:#475569;">
       To order additional capacity, contact ${escapeHtml(supportEmail)}.
     </p>`,
  );

  const text = [
    `Dear ${params.contactName},`,
    '',
    `The prepaid data bundle for ${params.companyName} has reached ${params.threshold}% of its capacity.`,
    '',
    `  Purchased: ${params.purchasedUnits} documents`,
    `  Consumed:  ${params.consumedUnits} documents`,
    `  Remaining: ${Math.max(0, params.remainingUnits)} documents`,
    '',
    consequence,
    '',
    params.balanceUrl,
    '',
    `To order additional capacity, contact ${supportEmail}.`,
  ].join('\n');

  return {
    subject: exhausted
      ? `${name}: your data bundle is exhausted`
      : `${name}: your data bundle is ${params.threshold}% used`,
    html,
    text,
  };
}

/**
 * Template G — low data inventory buffer alert (SRS v2.8 §5.7).
 *
 * Distinct from the percentage alert above, and the difference is the point.
 * "80% used" is a fact about a bundle; "1,420 units left, ~180 a day" is a fact
 * about next Tuesday. The run rate is what turns the number into a deadline,
 * which is the only form in which a reorder warning actually gets acted on.
 */
export function renderInventoryBuffer(params: {
  contactName: string;
  /** The account the alert is about — host, partner, tenant or sub-tenant. */
  accountName: string;
  tierLabel: string;
  thresholdUnits: number;
  remainingUnits: number;
  /** Units a day over the last 30 days. Zero when nothing has been filed yet. */
  dailyRunRate: number;
  critical: boolean;
  consoleUrl: string;
}): RenderedMail {
  const { name, supportEmail } = platform();

  const remaining = Math.max(0, params.remainingUnits);
  const daysLeft =
    params.dailyRunRate > 0 ? Math.floor(remaining / params.dailyRunRate) : null;

  const runRate =
    params.dailyRunRate > 0
      ? `~${params.dailyRunRate.toLocaleString()} units/day`
      : 'no consumption recorded in the last 30 days';

  const urgency =
    remaining <= 0
      ? 'This account has no units left. Filing is blocked until it is topped up.'
      : daysLeft !== null
        ? `At the current rate that is about ${daysLeft} more day${daysLeft === 1 ? '' : 's'}.`
        : 'There is no recent consumption to project a run-out date from.';

  const heading = params.critical
    ? `Urgent: data units running out for ${params.accountName}`
    : `Data units below the minimum buffer for ${params.accountName}`;

  const html = layout(
    heading,
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">Dear ${escapeHtml(params.contactName)},</p>
     <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
       The available data unit balance for <strong>${escapeHtml(params.accountName)}</strong> has
       fallen below the configured minimum safety buffer.
     </p>
     ${detailRows([
       ['Account tier', params.tierLabel],
       ['Minimum threshold', `${params.thresholdUnits.toLocaleString()} units`],
       ['Currently available', `${remaining.toLocaleString()} units`],
       ['Consumption run-rate', runRate],
     ])}
     <p style="margin:0 0 4px;font-size:14px;line-height:1.6;">${escapeHtml(urgency)}</p>
     <p style="margin:0 0 4px;font-size:14px;line-height:1.6;">
       To prevent an interruption to invoice clearance, procure or allocate additional units now.
     </p>
     ${actionButton(params.consoleUrl, 'Open the data bundle console')}
     <p style="margin:0;font-size:13px;color:#475569;">
       For procurement assistance, contact ${escapeHtml(supportEmail)}.
     </p>`,
  );

  const text = [
    `Dear ${params.contactName},`,
    '',
    `The available data unit balance for ${params.accountName} has fallen below the configured minimum safety buffer.`,
    '',
    `  Account tier:         ${params.tierLabel}`,
    `  Minimum threshold:    ${params.thresholdUnits.toLocaleString()} units`,
    `  Currently available:  ${remaining.toLocaleString()} units`,
    `  Consumption run-rate: ${runRate}`,
    '',
    urgency,
    '',
    'To prevent an interruption to invoice clearance, procure or allocate additional units now.',
    '',
    params.consoleUrl,
    '',
    `For procurement assistance, contact ${supportEmail}.`,
  ].join('\n');

  return {
    subject: params.critical
      ? `${name}: URGENT — data units running out for ${params.accountName}`
      : `${name}: data inventory below minimum threshold for ${params.accountName}`,
    html,
    text,
  };
}
