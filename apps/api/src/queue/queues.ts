import { Queue, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config.js';

/**
 * Job queues.
 *
 * Separated by workload rather than by feature: parsing is CPU-bound and
 * tenant-facing (a user is watching a progress bar), while submission is
 * IO-bound, retried over hours, and must not be starved by a large upload.
 * v2.7 adds the AP module's outbound verdicts, which are IO-bound like
 * submissions but far lower volume and much less urgent — a lane of their own
 * keeps them from queueing behind a month-end filing run.
 *
 * BullMQ rather than the SRS's RabbitMQ/Kafka: the 500 invoices/sec figure in
 * the spec assumes programmatic ERP ingestion, which v1 does not have. The job
 * interface here is narrow enough that swapping the transport later is
 * confined to this directory.
 */

export const QUEUE_PARSE = 'batch-parse';
export const QUEUE_SUBMIT = 'invoice-submit';
export const QUEUE_POLL = 'status-poll';
export const QUEUE_MAIL = 'mail-send';
export const QUEUE_RESPONSE = 'response-send';

export interface ParseBatchJob {
  batchId: string;
  tenantId: string;
  actorUserId: string | null;
}

export interface SubmitInvoiceJob {
  invoiceId: string;
  tenantId: string;
  actorUserId: string | null;
}

export interface SendMailJob {
  /** Row in mail_deliveries this job is fulfilling. */
  deliveryId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface PollStatusJob {
  /**
   * Which sweep to run. Both are low-frequency singleton housekeeping that
   * finds its own work, so they share a lane rather than each carrying a queue,
   * a worker and a shutdown path of their own:
   *
   *   `sweep`     — ask the provider about invoices it has gone quiet on (§10.6)
   *   `inventory` — check every tier against its minimum buffer (v2.8 §15.5)
   */
  reason: 'sweep' | 'inventory';
}

/**
 * Transmit one AP verdict to the supplier who issued the invoice (§12.3).
 *
 * Queued rather than sent inline so that a supplier whose access point is down
 * does not leave an AP clerk staring at a spinner. The verdict is already
 * recorded and binding on our side by the time this runs; delivery is the part
 * that can be retried.
 */
export interface SendResponseJob {
  responseId: string;
  invoiceId: string;
  tenantId: string;
}

let connection: IORedis | null = null;

export function redis(): IORedis {
  if (!connection) {
    connection = new IORedis(config().REDIS_URL, {
      // Required by BullMQ: it manages its own retry semantics and a capped
      // retry count here causes blocking commands to fail mid-wait.
      maxRetriesPerRequest: null,
    });
  }
  return connection;
}

let parseQueue: Queue<ParseBatchJob> | null = null;
let submitQueue: Queue<SubmitInvoiceJob> | null = null;
let pollQueue: Queue<PollStatusJob> | null = null;
let mailQueue: Queue<SendMailJob> | null = null;
let responseQueue: Queue<SendResponseJob> | null = null;

export function batchParseQueue(): Queue<ParseBatchJob> {
  parseQueue ??= new Queue<ParseBatchJob>(QUEUE_PARSE, { connection: redis() });
  return parseQueue;
}

export function invoiceSubmitQueue(): Queue<SubmitInvoiceJob> {
  submitQueue ??= new Queue<SubmitInvoiceJob>(QUEUE_SUBMIT, { connection: redis() });
  return submitQueue;
}

export function statusPollQueue(): Queue<PollStatusJob> {
  pollQueue ??= new Queue<PollStatusJob>(QUEUE_POLL, { connection: redis() });
  return pollQueue;
}

/**
 * Retry policy for ASP submission, mirroring the SRS failure matrix: back off
 * roughly 1m, 5m, 15m, 1h before giving up to the dead-letter state. Jittered
 * so that an ASP outage does not produce a synchronised retry stampede from
 * every tenant the moment it recovers.
 */
export const SUBMIT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'asp', delay: 60_000 },
  removeOnComplete: { age: 86_400, count: 5_000 },
  removeOnFail: false,
};

export const PARSE_JOB_OPTIONS: JobsOptions = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 604_800 },
};

/** Deterministic-ish backoff with jitter, registered on the submit worker. */
export function aspBackoff(attemptsMade: number): number {
  const schedule = [60_000, 300_000, 900_000, 3_600_000];
  const base = schedule[Math.min(attemptsMade - 1, schedule.length - 1)] ?? 3_600_000;
  const jitter = Math.floor(base * 0.2 * Math.random());
  return base + jitter;
}

export function sendMailQueue(): Queue<SendMailJob> {
  mailQueue ??= new Queue<SendMailJob>(QUEUE_MAIL, { connection: redis() });
  return mailQueue;
}

export function responseSendQueue(): Queue<SendResponseJob> {
  responseQueue ??= new Queue<SendResponseJob>(QUEUE_RESPONSE, { connection: redis() });
  return responseQueue;
}

/**
 * A commercial verdict is not urgent to the second but must eventually arrive,
 * so this retries longer and more gently than an invoice submission does.
 */
export const RESPONSE_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 60_000 },
  removeOnComplete: { age: 86_400, count: 2_000 },
  removeOnFail: { age: 604_800 },
};

/**
 * Mail retries are patient but finite. A greylisting server rejects the first
 * attempt on purpose and accepts a minute later, so giving up after one try
 * would lose invitations to a working configuration; retrying for hours after a
 * hard rejection only delays the moment the administrator finds out.
 */
export const MAIL_JOB_OPTIONS: JobsOptions = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 604_800 },
};

export async function closeQueues(): Promise<void> {
  await Promise.all([
    parseQueue?.close(),
    submitQueue?.close(),
    pollQueue?.close(),
    mailQueue?.close(),
    responseQueue?.close(),
  ]);
  parseQueue = submitQueue = pollQueue = mailQueue = null;
  responseQueue = null;
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}
