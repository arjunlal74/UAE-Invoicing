import { Worker } from 'bullmq';
import { config } from './config.js';
import { closeDb } from './db/client.js';
import { parseBatchJob } from './jobs/parseBatch.js';
import { pollStatusJob } from './jobs/pollStatus.js';
import { sendMailJob } from './jobs/sendMail.js';
import { sendResponseJob } from './jobs/sendResponse.js';
import { submitInvoiceJob } from './jobs/submitInvoice.js';
import { logger } from './logger.js';
import './modules/asp/service.js'; // registers the ASP drivers
import {
  QUEUE_MAIL,
  QUEUE_PARSE,
  QUEUE_POLL,
  QUEUE_RESPONSE,
  QUEUE_SUBMIT,
  aspBackoff,
  closeQueues,
  redis,
  statusPollQueue,
  type ParseBatchJob,
  type PollStatusJob,
  type SendMailJob,
  type SendResponseJob,
  type SubmitInvoiceJob,
} from './queue/queues.js';

/**
 * Background worker. Same codebase as the API, separate process.
 *
 * Parsing is memory-hungry (a whole workbook in the heap) and capped at two
 * concurrent jobs; submission is IO-bound and runs wider. Separating the queues
 * stops one merchant's 10,000-row upload from starving everyone's filings.
 */
async function main() {
  const cfg = config();
  const connection = redis();

  const parseWorker = new Worker<ParseBatchJob>(
    QUEUE_PARSE,
    async (job) => parseBatchJob(job.data),
    { connection, concurrency: 2 },
  );

  const submitWorker = new Worker<SubmitInvoiceJob>(
    QUEUE_SUBMIT,
    async (job) => submitInvoiceJob(job.data),
    {
      connection,
      concurrency: 8,
      settings: {
        // Mirrors the SRS retry matrix: ~1m, 5m, 15m, 1h with jitter, so a
        // recovering provider is not hit by every tenant at the same instant.
        backoffStrategy: (attemptsMade: number) => aspBackoff(attemptsMade),
      },
    },
  );

  // Mail is IO-bound and low-volume, but a provider that throttles will hold
  // each connection open — a narrow lane keeps that from occupying the process.
  const mailWorker = new Worker<SendMailJob>(
    QUEUE_MAIL,
    async (job) => sendMailJob(job.data),
    { connection, concurrency: 3 },
  );

  // AP verdicts (SRS v2.7 §12.3). Narrow, because a supplier's access point
  // being slow must not consume the lanes that file tax documents.
  const responseWorker = new Worker<SendResponseJob>(
    QUEUE_RESPONSE,
    async (job) => sendResponseJob(job.data),
    { connection, concurrency: 4 },
  );

  const pollWorker = new Worker<PollStatusJob>(
    QUEUE_POLL,
    async () => pollStatusJob(),
    { connection, concurrency: 1 },
  );

  for (const [name, worker] of [
    ['parse', parseWorker],
    ['submit', submitWorker],
    ['poll', pollWorker],
    ['mail', mailWorker],
    ['response', responseWorker],
  ] as const) {
    worker.on('failed', (job, err) => {
      logger.error(
        { queue: name, jobId: job?.id, attempts: job?.attemptsMade, err },
        'job failed',
      );
    });
    worker.on('completed', (job) => {
      logger.debug({ queue: name, jobId: job.id }, 'job completed');
    });
  }

  // The sweeper reschedules itself through BullMQ's repeat facility, so it
  // survives worker restarts without an external scheduler.
  await statusPollQueue().add(
    'sweep',
    { reason: 'sweep' },
    {
      repeat: { every: 5 * 60_000 },
      jobId: 'status-poll-sweep',
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 20 },
    },
  );

  logger.info({ env: cfg.NODE_ENV }, 'worker started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    try {
      await Promise.all([
        parseWorker.close(),
        submitWorker.close(),
        pollWorker.close(),
        mailWorker.close(),
        responseWorker.close(),
      ]);
      await closeQueues();
      await closeDb();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during worker shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'failed to start worker');
  process.exit(1);
});
