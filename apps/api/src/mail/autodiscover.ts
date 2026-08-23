import { resolveMx } from 'node:dns/promises';
import { logger } from '../logger.js';
import {
  domainOf,
  guessCandidates,
  presetForDomain,
  presetForMx,
  type ProviderPreset,
  type SmtpCandidate,
} from './providers.js';
import { PROBE_TIMEOUT_MS, verifySmtp, type SmtpResult } from './transport.js';

/**
 * Automatic account setup.
 *
 * Given an address and a password, work out the outgoing server the way a mail
 * client does: match a known provider, otherwise ask DNS who handles the
 * domain's mail, otherwise try the conventional hostnames — and confirm the
 * guess by actually signing in, because a hostname that resolves is not the
 * same as a hostname that accepts this account.
 *
 * Two limits are deliberate. Only hosts derived from the address's own domain
 * or from a preset are ever contacted, so a typed address cannot be used to
 * make the server open connections to somewhere unrelated. And probing stops
 * the moment a server rejects the *password* rather than the connection: at
 * that point the right server has been found, and further attempts would push
 * the account towards its provider's lockout threshold.
 */

const MAX_PROBES = 6;
const OVERALL_BUDGET_MS = 30_000;

export interface ProbeAttempt {
  host: string;
  port: number;
  encryption: SmtpCandidate['encryption'];
  username: string;
  ok: boolean;
  message: string;
}

export interface AutodiscoverResult {
  found: boolean;
  provider: { key: string; label: string; note?: string } | null;
  settings: {
    host: string;
    port: number;
    encryption: SmtpCandidate['encryption'];
    username: string;
    authRequired: boolean;
  } | null;
  /** Populated when nothing worked: the best guess to prefill manual setup. */
  suggestion: {
    host: string;
    port: number;
    encryption: SmtpCandidate['encryption'];
    username: string;
  } | null;
  message: string;
  attempts: ProbeAttempt[];
}

async function mxHostsFor(domain: string): Promise<string[]> {
  try {
    const records = await resolveMx(domain);
    return records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
  } catch {
    // No MX, or DNS is unavailable inside the container. Neither is fatal —
    // it only means the guessed hostnames get their turn sooner.
    return [];
  }
}

function dedupe(candidates: SmtpCandidate[]): SmtpCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = `${c.host}:${c.port}:${c.encryption}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function autodiscover(email: string, password: string): Promise<AutodiscoverResult> {
  const address = email.trim().toLowerCase();
  const domain = domainOf(address);
  const localPart = address.split('@')[0] ?? address;

  if (!domain) {
    return {
      found: false,
      provider: null,
      settings: null,
      suggestion: null,
      message: 'That does not look like an e-mail address.',
      attempts: [],
    };
  }

  let preset: ProviderPreset | null = presetForDomain(domain);
  if (!preset) preset = presetForMx(await mxHostsFor(domain));

  const candidates = dedupe([
    ...(preset ? [preset as SmtpCandidate] : []),
    ...guessCandidates(domain),
  ]).slice(0, MAX_PROBES);

  const attempts: ProbeAttempt[] = [];
  const deadline = Date.now() + OVERALL_BUDGET_MS;

  for (const candidate of candidates) {
    if (Date.now() > deadline) break;

    // Most providers want the whole address; a few older hosts want only the
    // part before the @. The second form is tried only against a server that
    // has already proved it is reachable and speaks SMTP.
    for (const username of [address, localPart]) {
      const result: SmtpResult = await verifySmtp(
        {
          host: candidate.host,
          port: candidate.port,
          encryption: candidate.encryption,
          authRequired: Boolean(password),
          username,
          password,
        },
        PROBE_TIMEOUT_MS,
      );

      attempts.push({
        host: candidate.host,
        port: candidate.port,
        encryption: candidate.encryption,
        username,
        ok: result.ok,
        message: result.message,
      });

      if (result.ok) {
        logger.info(
          { host: candidate.host, port: candidate.port, providerKey: candidate.providerKey },
          'mail autodiscover succeeded',
        );
        return {
          found: true,
          provider: preset
            ? { key: preset.providerKey, label: preset.label, note: preset.note }
            : null,
          settings: {
            host: candidate.host,
            port: candidate.port,
            encryption: candidate.encryption,
            username,
            authRequired: Boolean(password),
          },
          suggestion: null,
          message: 'Your account has been configured and the sign-in was accepted.',
          attempts,
        };
      }

      // Wrong password on the right server: stop here rather than replaying the
      // same rejected credentials across every remaining candidate.
      if (result.reason === 'AUTH') {
        if (username === localPart || localPart === address) {
          return {
            found: false,
            provider: preset
              ? { key: preset.providerKey, label: preset.label, note: preset.note }
              : null,
            settings: null,
            suggestion: {
              host: candidate.host,
              port: candidate.port,
              encryption: candidate.encryption,
              username: address,
            },
            message: result.message,
            attempts,
          };
        }
        continue; // Same host, try the local-part username.
      }

      break; // Connection-level failure: this host is not it, move on.
    }
  }

  const fallback = candidates[0];
  return {
    found: false,
    provider: preset ? { key: preset.providerKey, label: preset.label, note: preset.note } : null,
    settings: null,
    suggestion: fallback
      ? {
          host: fallback.host,
          port: fallback.port,
          encryption: fallback.encryption,
          username: address,
        }
      : null,
    message:
      'No outgoing mail server could be found for that address automatically. Enter the settings your provider gave you.',
    attempts,
  };
}
