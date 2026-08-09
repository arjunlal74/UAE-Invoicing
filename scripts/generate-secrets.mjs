/**
 * Generate the cryptographic secrets the stack needs and write them into .env.
 *
 * Run once per environment:
 *   node scripts/generate-secrets.mjs
 *
 * Existing non-placeholder values are left alone, so re-running is safe — and
 * important, because replacing SECRETS_ENCRYPTION_KEY makes every stored ASP
 * credential undecryptable.
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(repo, '.env');
const examplePath = join(repo, '.env.example');

if (!existsSync(envPath)) {
  copyFileSync(examplePath, envPath);
  console.log('Created .env from .env.example');
}

const PLACEHOLDER = /dev_only|change_me|replace_me/i;

/**
 * A value is a placeholder if its text OR its base64-decoded form looks like
 * one. The shipped encryption key is base64, so a text-only check would leave
 * the repository's published key in place and report success.
 */
function isPlaceholder(value) {
  if (!value) return true;
  if (PLACEHOLDER.test(value)) return true;
  try {
    return PLACEHOLDER.test(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    return false;
  }
}

const generators = {
  JWT_ACCESS_SECRET: () => randomBytes(48).toString('base64'),
  JWT_REFRESH_SECRET: () => randomBytes(48).toString('base64'),
  // Must decode to exactly 32 bytes for AES-256-GCM.
  SECRETS_ENCRYPTION_KEY: () => randomBytes(32).toString('base64'),
  POSTGRES_PASSWORD: () => randomBytes(18).toString('base64url'),
  APP_DB_PASSWORD: () => randomBytes(18).toString('base64url'),
};

let contents = readFileSync(envPath, 'utf8');
const rotated = [];
const kept = [];

for (const [key, generate] of Object.entries(generators)) {
  const pattern = new RegExp(`^${key}=(.*)$`, 'm');
  const match = pattern.exec(contents);
  const current = match?.[1]?.trim() ?? '';

  if (!isPlaceholder(current)) {
    kept.push(key);
    continue;
  }

  const value = generate();
  contents = match
    ? contents.replace(pattern, `${key}=${value}`)
    : `${contents.trimEnd()}\n${key}=${value}\n`;
  rotated.push(key);
}

writeFileSync(envPath, contents, 'utf8');

if (rotated.length) console.log(`Generated: ${rotated.join(', ')}`);
if (kept.length) console.log(`Left unchanged (already set): ${kept.join(', ')}`);
console.log('\n.env is gitignored. Keep a copy somewhere safe — losing');
console.log('SECRETS_ENCRYPTION_KEY makes stored ASP credentials unrecoverable.');
