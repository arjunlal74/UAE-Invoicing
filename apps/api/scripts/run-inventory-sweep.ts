/**
 * Run the §15.5 minimum buffer sweep once, now.
 *
 * The worker runs this hourly. This is for the two occasions an hour is too
 * long to wait: verifying the alert path after changing a threshold, and an
 * operator who has just backfilled procurement contracts and wants the console
 * and the alerts to agree with reality before anyone asks.
 *
 * Safe to run at any time — the sweep is idempotent, announcing each breach
 * once and re-arming only when a balance climbs back over its floor.
 *
 * Usage: pnpm --filter @uae/api inventory:sweep
 */
import { closeDb } from '../src/db/client.js';
import { inventorySweepJob } from '../src/jobs/inventorySweep.js';
import { closeQueues } from '../src/queue/queues.js';
import { logger } from '../src/logger.js';

const result = await inventorySweepJob();

logger.info(result, 'inventory sweep finished');
console.log(
  `${result.breaches} account(s) newly below their floor, ${result.rearmed} re-armed after a top-up.`,
);

await closeQueues();
await closeDb();
