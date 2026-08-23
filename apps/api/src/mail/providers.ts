/**
 * Known SMTP providers.
 *
 * The wizard asks for an address and a password and works the rest out, which
 * only happens if something knows that `@gmail.com` means smtp.gmail.com on
 * 587. This table is that knowledge; anything not listed falls back to MX
 * inspection and then to probing the domain's own hostnames.
 *
 * `note` is shown in the portal after a preset matches. It exists because the
 * most common setup failure by far is not a wrong hostname — it is a provider
 * that refuses the account password and wants an app-specific one, which looks
 * identical to a typo unless someone says so.
 */

export type Encryption = 'NONE' | 'STARTTLS' | 'SSL';

export interface SmtpCandidate {
  host: string;
  port: number;
  encryption: Encryption;
  /** Preset that produced this candidate, or null when it was guessed. */
  providerKey: string | null;
  /** How the username is derived: the full address, or its local part. */
  usernameStyle?: 'EMAIL' | 'LOCAL_PART';
}

export interface ProviderPreset extends SmtpCandidate {
  providerKey: string;
  label: string;
  /** Address domains that select this preset outright. */
  domains: string[];
  /** MX-hostname fragments that select it for a custom domain. */
  mxMatches?: string[];
  note?: string;
}

export const PROVIDERS: ProviderPreset[] = [
  {
    providerKey: 'GMAIL',
    label: 'Gmail / Google Workspace',
    domains: ['gmail.com', 'googlemail.com'],
    mxMatches: ['google.com', 'googlemail.com'],
    host: 'smtp.gmail.com',
    port: 587,
    encryption: 'STARTTLS',
    note: 'Google rejects your normal account password over SMTP. Turn on 2-Step Verification and create an App Password, then paste that here.',
  },
  {
    providerKey: 'OUTLOOK_COM',
    label: 'Outlook.com / Hotmail',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'hotmail.co.uk', 'live.co.uk'],
    host: 'smtp-mail.outlook.com',
    port: 587,
    encryption: 'STARTTLS',
    note: 'If the account has two-step verification enabled, create an app password rather than using the account password.',
  },
  {
    providerKey: 'OFFICE365',
    label: 'Microsoft 365',
    domains: [],
    mxMatches: ['protection.outlook.com', 'mail.protection.outlook.com'],
    host: 'smtp.office365.com',
    port: 587,
    encryption: 'STARTTLS',
    note: 'Microsoft 365 disables SMTP AUTH on new tenants by default. If sign-in fails, ask your Microsoft administrator to enable authenticated SMTP for this mailbox.',
  },
  {
    providerKey: 'YAHOO',
    label: 'Yahoo Mail',
    domains: ['yahoo.com', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com'],
    mxMatches: ['yahoodns.net'],
    host: 'smtp.mail.yahoo.com',
    port: 465,
    encryption: 'SSL',
    note: 'Yahoo requires an app password generated from Account Security.',
  },
  {
    providerKey: 'ICLOUD',
    label: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    mxMatches: ['icloud.com'],
    host: 'smtp.mail.me.com',
    port: 587,
    encryption: 'STARTTLS',
    note: 'iCloud requires an app-specific password.',
  },
  {
    providerKey: 'ZOHO',
    label: 'Zoho Mail',
    domains: ['zoho.com', 'zohomail.com'],
    mxMatches: ['zoho.com', 'zohomail.com'],
    host: 'smtp.zoho.com',
    port: 587,
    encryption: 'STARTTLS',
    note: 'Zoho accounts with two-factor authentication need an application-specific password.',
  },
  {
    providerKey: 'FASTMAIL',
    label: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm'],
    mxMatches: ['messagingengine.com'],
    host: 'smtp.fastmail.com',
    port: 465,
    encryption: 'SSL',
    note: 'Fastmail requires an app password scoped to SMTP.',
  },
  {
    providerKey: 'YANDEX',
    label: 'Yandex Mail',
    domains: ['yandex.com', 'yandex.ru'],
    mxMatches: ['yandex.net', 'yandex.ru'],
    host: 'smtp.yandex.com',
    port: 465,
    encryption: 'SSL',
  },
  {
    providerKey: 'GMX',
    label: 'GMX',
    domains: ['gmx.com', 'gmx.net', 'gmx.de'],
    host: 'mail.gmx.com',
    port: 587,
    encryption: 'STARTTLS',
  },
  {
    providerKey: 'AOL',
    label: 'AOL Mail',
    domains: ['aol.com'],
    host: 'smtp.aol.com',
    port: 587,
    encryption: 'STARTTLS',
    note: 'AOL requires an app password.',
  },
  {
    providerKey: 'GODADDY',
    label: 'GoDaddy',
    domains: [],
    mxMatches: ['secureserver.net'],
    host: 'smtpout.secureserver.net',
    port: 465,
    encryption: 'SSL',
  },
  {
    providerKey: 'NAMECHEAP',
    label: 'Namecheap Private Email',
    domains: [],
    mxMatches: ['registrar-servers.com', 'privateemail.com'],
    host: 'mail.privateemail.com',
    port: 465,
    encryption: 'SSL',
  },
];

export function domainOf(email: string): string {
  return email.trim().toLowerCase().split('@')[1] ?? '';
}

export function presetForDomain(domain: string): ProviderPreset | null {
  return PROVIDERS.find((p) => p.domains.includes(domain)) ?? null;
}

export function presetForMx(mxHosts: string[]): ProviderPreset | null {
  const haystack = mxHosts.map((h) => h.toLowerCase());
  return (
    PROVIDERS.find((p) =>
      p.mxMatches?.some((fragment) => haystack.some((mx) => mx.includes(fragment))),
    ) ?? null
  );
}

export function providerByKey(key: string | null): ProviderPreset | null {
  return key ? (PROVIDERS.find((p) => p.providerKey === key) ?? null) : null;
}

/**
 * Hostnames to try for a domain nothing recognises.
 *
 * Ordered by how likely each is to be the answer rather than by port number:
 * submission on 587 is the modern default, 465 is still common on shared
 * hosting, and 25 is last because it is usually either blocked or unauthenticated.
 */
export function guessCandidates(domain: string): SmtpCandidate[] {
  const hosts = [`smtp.${domain}`, `mail.${domain}`, `smtp.mail.${domain}`, domain];
  const shapes: Array<{ port: number; encryption: Encryption }> = [
    { port: 587, encryption: 'STARTTLS' },
    { port: 465, encryption: 'SSL' },
  ];

  const out: SmtpCandidate[] = [];
  for (const host of hosts) {
    for (const shape of shapes) {
      out.push({ host, ...shape, providerKey: null });
    }
  }
  return out;
}
