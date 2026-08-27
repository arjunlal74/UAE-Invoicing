import { API_KEY_SCOPES, type Permission } from '@uae/contracts';
import { constants } from 'node:fs';
import { access, mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from '../config.js';
import { withPlatformAccess } from '../db/client.js';
import { logger } from '../logger.js';

/**
 * Drop directories — the SFTP limb of ingestion channel 1 (SRS v2.1 §1.2).
 *
 * The platform does not run an SSH daemon. An SFTP endpoint is infrastructure
 * that already exists in every deployment target — `atmoz/sftp` beside the
 * other containers here, AWS Transfer Family in a real one — and putting one
 * inside the process that files tax documents would mean owning host keys,
 * cipher negotiation and a chroot jail in exchange for nothing the platform
 * needs. What the platform owns is the half nobody else can do: deciding whose
 * directory this is, what that party is allowed to file, and what happened.
 *
 * The layout under `SFTP_ROOT/<username>/`:
 *
 *   inbox/        where the ERP puts files
 *   processing/   claimed by rename — an atomic take on a POSIX filesystem
 *   processed/    something was filed, with a `.receipt.json` beside it
 *   failed/       nothing was filed, with a `.receipt.json` saying why
 *
 * The split between the last two answers the only question an ERP polling these
 * directories actually has: did this file result in filings? A duplicate is
 * benign and its receipt says so, but it produced nothing, so it is shelved with
 * the refusals rather than beside the files that were filed.
 *
 * `inbox` is the one the sender writes to by convention; whether the others are
 * writable to it is a property of how the SFTP account was created, not
 * something enforced here. Claiming by rename rather than by a lock is what
 * makes the watcher safe to run in more than one worker: `rename(2)` either
 * moves the file or fails because somebody else already did.
 */

export const DROP_DIRECTORIES = ['inbox', 'processing', 'processed', 'failed'] as const;
export type DropDirectory = (typeof DROP_DIRECTORIES)[number];

export interface Drop {
  apiKeyId: string;
  tenantId: string;
  keyName: string;
  username: string;
  scopes: Permission[];
  root: string;
}

/**
 * The drops that are open for business.
 *
 * A revoked or expired key is not returned, which closes its directory without
 * anything else having to know that keys can be revoked. Files already sitting
 * in it stay where they are — deleting a merchant's data because their
 * credential lapsed would be the wrong response to an expiry.
 */
export async function loadDrops(): Promise<Drop[]> {
  const rows = await withPlatformAccess(
    (tx) => tx<
      {
        id: string;
        tenant_id: string;
        name: string;
        sftp_username: string;
        scopes: string[];
      }[]
    >`
      SELECT k.id, k.tenant_id, k.name, k.sftp_username, k.scopes
      FROM api_keys k
      JOIN tenants t ON t.id = k.tenant_id
      WHERE k.sftp_username IS NOT NULL
        AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > now())
        AND t.status = 'ACTIVE'
    `,
  );

  return rows.map((row) => ({
    apiKeyId: row.id,
    tenantId: row.tenant_id,
    keyName: row.name,
    username: row.sftp_username,
    scopes: row.scopes.filter((s): s is Permission =>
      (API_KEY_SCOPES as string[]).includes(s),
    ),
    root: dropRoot(row.sftp_username),
  }));
}

/**
 * The directory a username owns.
 *
 * The name is constrained by a database CHECK to `[a-z][a-z0-9_-]{2,31}`, but
 * it is re-validated here and the result is re-checked against the configured
 * root. A path that escaped `SFTP_ROOT` would be this feature reading and
 * writing anywhere the worker can reach, and one dropped constraint should not
 * be all that stands between a column and that.
 */
export function dropRoot(username: string): string {
  if (!/^[a-z][a-z0-9_-]{2,31}$/.test(username)) {
    throw new Error(`Refusing an SFTP username that is not a safe path segment: ${username}`);
  }

  const root = resolve(config().SFTP_ROOT);
  const path = resolve(join(root, username));
  if (path !== join(root, username)) {
    throw new Error(`Refusing an SFTP path outside the configured root: ${username}`);
  }
  return path;
}

/**
 * Make sure the four directories exist, and say something useful when they
 * cannot be made.
 *
 * On a real deployment they are created with the SFTP account and this is a
 * no-op. The failure worth naming is the one an operator will actually hit:
 * a key was given an `sftp_username` but nobody created the matching account,
 * so there is nothing under the root and the worker cannot make one because the
 * root is not its to write to.
 */
export async function ensureDropDirectories(drop: Drop): Promise<void> {
  for (const directory of DROP_DIRECTORIES) {
    try {
      await mkdir(join(drop.root, directory), { recursive: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') {
        throw new Error(
          `No drop directory for "${drop.username}" and it could not be created (${code}). Create the SFTP account with inbox, processing, processed and failed directories owned by the worker's user.`,
        );
      }
      throw err;
    }
  }
}

export interface CandidateFile {
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt: Date;
}

/**
 * Files in `inbox` that look finished.
 *
 * An SFTP upload is not atomic: the file appears at zero bytes and grows. Two
 * defences, because clients differ. Most write to a temporary name and rename
 * on completion, so anything that still looks temporary is skipped outright.
 * The rest are only claimed once size and mtime have held still for
 * `SFTP_STABLE_SECONDS` — a file being written to is a file that changed
 * recently, and one that has not moved in five seconds is done or abandoned.
 */
const IGNORED = /^\.|\.(filepart|part|tmp|temp|swp|crdownload)$/i;

export async function listStableFiles(drop: Drop): Promise<CandidateFile[]> {
  const inbox = join(drop.root, 'inbox');

  let names: string[];
  try {
    names = await readdir(inbox);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const cfg = config();
  const settledBefore = Date.now() - cfg.SFTP_STABLE_SECONDS * 1000;
  const files: CandidateFile[] = [];

  for (const name of names) {
    if (IGNORED.test(name)) continue;

    const path = join(inbox, name);
    let info;
    try {
      info = await stat(path);
    } catch {
      // Vanished between the listing and the stat — somebody else took it, or
      // the uploader cancelled. Either way it is not ours to worry about.
      continue;
    }

    if (!info.isFile()) continue;
    if (info.mtimeMs > settledBefore) continue;

    if (info.size === 0) {
      logger.debug({ username: drop.username, name }, 'sftp: skipping an empty file');
      continue;
    }

    files.push({ name, path, sizeBytes: info.size, modifiedAt: info.mtime });
  }

  // Oldest first, so a backlog drains in the order the ERP produced it and an
  // invoice series is filed in sequence.
  return files.sort((a, b) => a.modifiedAt.getTime() - b.modifiedAt.getTime());
}

/**
 * Take a file, atomically.
 *
 * Returns null when somebody else got there first, which is the ordinary
 * outcome of two workers polling the same share rather than an error.
 */
export async function claim(drop: Drop, file: CandidateFile): Promise<string | null> {
  const target = join(drop.root, 'processing', file.name);
  try {
    await rename(file.path, target);
    return target;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Put back anything left mid-flight by a crash.
 *
 * A file in `processing` at startup is one this worker — or its predecessor —
 * died holding. Returning it to the inbox retries it, which is safe because the
 * expensive half is idempotent twice over: the delivery log refuses the same
 * content, and an invoice number that was already filed cannot be filed again.
 */
export async function recoverAbandoned(drop: Drop): Promise<number> {
  const processing = join(drop.root, 'processing');

  let names: string[];
  try {
    names = await readdir(processing);
  } catch {
    return 0;
  }

  let recovered = 0;
  for (const name of names) {
    try {
      await rename(join(processing, name), join(drop.root, 'inbox', name));
      recovered += 1;
    } catch (err) {
      logger.warn({ username: drop.username, name, err }, 'sftp: could not recover a claimed file');
    }
  }

  if (recovered > 0) {
    logger.info({ username: drop.username, recovered }, 'sftp: returned abandoned files to the inbox');
  }
  return recovered;
}

/**
 * File the outcome away and write the receipt beside it.
 *
 * The receipt is a courtesy — a file on a share that anyone can delete — so it
 * is written *after* the delivery row that is the actual record. A receipt that
 * failed to write is logged and shrugged at; a delivery that failed to record
 * is a real problem.
 */
export async function settle(
  drop: Drop,
  claimedPath: string,
  fileName: string,
  outcome: 'processed' | 'failed',
  receipt: unknown,
): Promise<void> {
  const destination = join(drop.root, outcome, fileName);

  try {
    await rename(claimedPath, destination);
  } catch (err) {
    logger.error({ username: drop.username, fileName, err }, 'sftp: could not move a settled file');
  }

  try {
    await writeFile(
      join(drop.root, outcome, `${fileName}.receipt.json`),
      `${JSON.stringify(receipt, null, 2)}\n`,
      'utf8',
    );
  } catch (err) {
    logger.warn({ username: drop.username, fileName, err }, 'sftp: could not write a receipt');
  }
}

/**
 * Whether the configured root exists at all — a mount that never happened.
 *
 * Read and traverse, not write. The root is the parent of every drop and is
 * owned by root on a real deployment: sshd refuses a chroot target the user can
 * write to, so a check for W_OK here would fail on exactly the configuration
 * this is meant to run in. What the worker writes to are the directories one
 * level down, and `ensureDropDirectories` reports on those.
 */
export async function rootIsMounted(): Promise<boolean> {
  try {
    await access(resolve(config().SFTP_ROOT), constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
