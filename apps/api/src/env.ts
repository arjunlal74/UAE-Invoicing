import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load the repository's `.env` into `process.env`.
 *
 * The monorepo keeps one `.env` at the root, but processes start from several
 * working directories (`apps/api` under tsx, `/app` in Docker, the package root
 * under vitest). Walking up from this file finds it in all of them, so nobody
 * has to remember `--env-file` or a `dotenv` import order.
 *
 * Existing environment variables always win: in Docker and CI the real values
 * are already injected and must not be overwritten by a stray dev file.
 */

let loaded = false;

function parse(contents: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip matching surrounding quotes, honouring escapes inside double quotes.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }

    if (key) out[key] = value;
  }

  return out;
}

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];

  // Walk up from this module and from the working directory; either may be the
  // one that sits below the repository root.
  for (const start of [here, process.cwd()]) {
    let dir = resolve(start);
    for (let depth = 0; depth < 6; depth++) {
      candidates.push(join(dir, '.env'));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;

    try {
      for (const [key, value] of Object.entries(parse(readFileSync(candidate, 'utf8')))) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
    } catch {
      // An unreadable .env is not fatal — config validation will report
      // whatever is genuinely missing, with better messages than we could.
    }
    return;
  }
}
