/**
 * Message bodies.
 *
 * Plain inline-styled HTML with a text alternative, because mail clients are
 * not browsers: no stylesheets, no web fonts, and a table is still the only
 * layout primitive that survives Outlook. Every interpolated value is escaped —
 * a display name is user-supplied and ends up inside markup.
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

function layout(heading: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;">
      <tr>
        <td style="padding:20px 24px;background:#1e3a5f;border-radius:8px 8px 0 0;color:#ffffff;">
          <span style="display:inline-block;padding:4px 8px;background:rgba(255,255,255,0.15);border-radius:4px;font-size:12px;font-weight:700;letter-spacing:0.05em;">UAE</span>
          <span style="margin-left:8px;font-size:14px;font-weight:600;">E-Invoicing Portal</span>
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
          This is an automated message from the UAE E-Invoicing Portal. If you were not expecting it, you can ignore it.
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function renderInvite(params: {
  fullName: string;
  inviteUrl: string;
  organisation: string | null;
  roleLabel: string;
  expiresInDays: number;
}): RenderedMail {
  const { fullName, inviteUrl, organisation, roleLabel, expiresInDays } = params;
  const where = organisation ? ` for ${organisation}` : '';

  const html = layout(
    `You have been invited to the UAE E-Invoicing Portal`,
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">Hello ${escapeHtml(fullName)},</p>
     <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
       An account has been created for you${escapeHtml(where)} with the role
       <strong>${escapeHtml(roleLabel)}</strong>. Use the button below to choose a password and sign in.
     </p>
     <p style="margin:24px 0;">
       <a href="${escapeHtml(inviteUrl)}"
          style="display:inline-block;padding:12px 20px;background:#1e5aa8;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">
         Set up my account
       </a>
     </p>
     <p style="margin:0 0 12px;font-size:13px;line-height:1.6;color:#475569;">
       This invitation expires in ${expiresInDays} days and can only be used once.
     </p>
     <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;word-break:break-all;">
       If the button does not work, copy this address into your browser:<br>${escapeHtml(inviteUrl)}
     </p>`,
  );

  const text = [
    `Hello ${fullName},`,
    '',
    `An account has been created for you${where} with the role ${roleLabel}.`,
    'Open the link below to choose a password and sign in:',
    '',
    inviteUrl,
    '',
    `This invitation expires in ${expiresInDays} days and can only be used once.`,
  ].join('\n');

  return { subject: 'Your UAE E-Invoicing Portal invitation', html, text };
}

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

  return { subject: 'UAE E-Invoicing Portal — test message', html, text };
}
