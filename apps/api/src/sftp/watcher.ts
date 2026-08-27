import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  claim,
  ensureDropDirectories,
  listStableFiles,
  loadDrops,
  recoverAbandoned,
  rootIsMounted,
  settle,
  type Drop,
} from './drops.js';
import { processFile } from './process.js';

/**
 * The SFTP watcher (SRS v2.1 §1.2 channel 1).
 *
 * Polling, not `fs.watch`. Inotify does not cross a network filesystem, and
 * every realistic deployment of this puts the share on one — an NFS mount, EFS,
 * a Docker volume, whatever the managed SFTP service writes into. A watcher
 * that works on the developer's laptop and silently sees nothing in production
 * is worse than no watcher, so this one asks.
 *
 * The loop is deliberately serial. An ERP's nightly export is a burst of files
 * whose invoice numbers run in sequence, and filing them concurrently would
 * interleave a tenant's series for no gain — the work is dominated by the
 * database and the submission queue, both of which are already shared.
 */

export interface SftpWatcher {
  stop(): Promise<void>;
}

export function startSftpWatcher(): SftpWatcher | null {
  const cfg = config();

  if (!cfg.SFTP_ENABLED) {
    logger.debug('sftp: watcher disabled (SFTP_ENABLED is not set)');
    return null;
  }

  let stopped = false;
  let sweeping: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const recovered = new Set<string>();

  const tick = async () => {
    if (stopped) return;
    sweeping = sweep(recovered);
    try {
      await sweeping;
    } catch (err) {
      // One bad poll must not end the watcher. The share being briefly
      // unreachable is an operational event, not a reason to stop watching it.
      logger.error({ err }, 'sftp: sweep failed');
    } finally {
      sweeping = null;
      if (!stopped) timer = setTimeout(() => void tick(), cfg.SFTP_POLL_SECONDS * 1000);
    }
  };

  logger.info(
    { root: cfg.SFTP_ROOT, everySeconds: cfg.SFTP_POLL_SECONDS },
    'sftp: watching drop directories',
  );
  void tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Let the file in flight finish. Stopping in the middle of one would
      // leave it in `processing`, which works — startup recovers it — but
      // re-files a document that may already have gone to the tax authority.
      if (sweeping) await sweeping.catch(() => undefined);
    },
  };
}

async function sweep(recovered: Set<string>): Promise<void> {
  if (!(await rootIsMounted())) {
    logger.warn(
      { root: config().SFTP_ROOT },
      'sftp: the configured root is not readable — is the share mounted?',
    );
    return;
  }

  const drops = await loadDrops();
  if (drops.length === 0) return;

  for (const drop of drops) {
    try {
      await ensureDropDirectories(drop);

      // Once per drop per process lifetime: anything sitting in `processing`
      // was claimed by a worker that died holding it.
      if (!recovered.has(drop.apiKeyId)) {
        await recoverAbandoned(drop);
        recovered.add(drop.apiKeyId);
      }

      await drain(drop);
    } catch (err) {
      // One tenant's share being broken must not stop the others being served.
      logger.error({ username: drop.username, err }, 'sftp: drop could not be swept');
    }
  }
}

async function drain(drop: Drop): Promise<void> {
  const files = await listStableFiles(drop);

  for (const file of files) {
    const claimed = await claim(drop, file);
    // Null means another worker took it between the listing and the rename,
    // which is the ordinary outcome of a shared mount rather than a fault.
    if (!claimed) continue;

    const started = Date.now();
    try {
      const outcome = await processFile(drop, file, claimed);

      // The question an ERP asks of these directories is "did this file result
      // in filings?". For a rejection and for a duplicate the answer is no, so
      // both go to `failed` — a duplicate is benign, and its receipt says so,
      // but shelving it beside the files that *were* filed would tell the
      // sender the opposite of what happened.
      await settle(
        drop,
        claimed,
        file.name,
        outcome.status === 'ACCEPTED' || outcome.status === 'PARTIAL' ? 'processed' : 'failed',
        outcome.receipt,
      );

      logger.info(
        {
          username: drop.username,
          file: file.name,
          status: outcome.status,
          invoices: outcome.invoiceCount,
          batchId: outcome.batchId,
          ms: Date.now() - started,
        },
        'sftp: delivery processed',
      );
    } catch (err) {
      // The processor answers with a receipt for anything it understands, so
      // reaching here means something unexpected. The file goes to `failed`
      // with a receipt rather than being left in `processing`, where it would
      // be silently retried on every restart forever.
      logger.error({ username: drop.username, file: file.name, err }, 'sftp: delivery failed');

      await settle(drop, claimed, file.name, 'failed', {
        file: file.name,
        receivedAt: file.modifiedAt.toISOString(),
        processedAt: new Date().toISOString(),
        status: 'REJECTED',
        error: {
          code: 'INTERNAL',
          message:
            'This file could not be processed. It has not been filed. Contact support quoting this file name before re-sending it.',
        },
      });
    }
  }
}
