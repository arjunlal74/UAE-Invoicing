import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '../config.js';

/**
 * Symmetric encryption for secrets held at rest (currently ASP credentials).
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than yielding plausible garbage. The key comes from configuration today; the
 * production path is to replace `encryptSecret`/`decryptSecret` with calls to
 * AWS KMS or Secrets Manager. Everything else in the codebase talks to these
 * two functions, so that swap touches this file only.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, config().secretsKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(
    '.',
  );
}

export function decryptSecret(encoded: string): string {
  const [version, ivB64, tagB64, dataB64] = encoded.split('.');
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted secret');
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    config().secretsKey,
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** A URL-safe random token, returned alongside the hash we actually persist. */
export function generateToken(bytes = 32): { token: string; hash: string } {
  const token = randomBytes(bytes).toString('base64url');
  return { token, hash: sha256Hex(token) };
}

/**
 * Constant-time comparison. Used wherever an attacker controls one side of the
 * comparison — webhook signatures, invite tokens, refresh tokens — so that
 * response timing does not leak how much of a guess was correct.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
