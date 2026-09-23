import { type Worker } from 'bullmq';

import { closeDatabase } from '../db/sequelize';
import { computeMissing } from '../modules/impressions/impressions.service';
import { recomputeBaselines } from '../modules/traffic/traffic.service';
import { closeQueues, getQueue, QueueName, registerWorker } from '../queue/queues';
import { installProcessHandlers, onShutdown } from '../shared/lifecycle';
import { loggerFor } from '../shared/logger';
import { closeRedis } from '../shared/redis';
import { IST } from '../shared/time';

/**
 * The worker service: the pipeline, and no HTTP surface at all.
 *
 * Classification, fraud checks, allocation, billing and payout accrual all run
 * here. None of it belongs in a request — a driver's phone should not wait on
 * a PostGIS intersection, and a retry must not double-charge an advertiser
 * because someone refreshed a page.
 */

const SERVICE = 'worker';
const log = loggerFor(SERVICE);

/**
 * Processors register here as each pipeline module lands, e.g.
 *   workers.push(registerWorker(QueueName.ClassifySessionWindow, classifyHandler));
 */
const workers: Worker[] = [];

/**
 * Overnight, in the platform's own timezone rather than the host's.
 *
 * The hour is not load-shedding — the job is a handful of aggregates — it is
 * that a baseline recomputed mid-shift would change what a vehicle currently
 * driving is told about the road it is on. Moving the reference once a day, at
 * a time almost nobody is driving, keeps a campaign's reported numbers stable
 * within the day they are read.
 */
const NIGHTLY_IST = '0 1 * * *';

async function scheduleRecurring(): Promise<void> {
  await getQueue(QueueName.RecomputeSpeedBaselines).upsertJobScheduler(
    'nightly',
    { pattern: NIGHTLY_IST, tz: IST },
    { name: 'recompute' },
  );
}

function main(): void {
  installProcessHandlers();

  workers.push(
    /*
     * Re-measure the roads, then express the driving against them. In that
     * order, and as two jobs rather than one: the second is worth running on
     * its own after a backlog import, and the first is worth retrying without
     * dragging the second through the same retry.
     */
    registerWorker(QueueName.RecomputeSpeedBaselines, async () => {
      await recomputeBaselines();
      await getQueue(QueueName.ComputeImpressions).add('compute', {});
    }),

    registerWorker(QueueName.ComputeImpressions, async () => {
      await computeMissing();
    }),
  );

  onShutdown('workers', async () => {
    // Closing a worker lets its current job finish before the connection goes.
    await Promise.all(workers.map((worker) => worker.close()));
  });
  onShutdown('queues', () => closeQueues());
  onShutdown('database', () => closeDatabase());
  onShutdown('redis', () => closeRedis());

  log.info({ queues: workers.length }, 'worker started');

  // Fire and forget: a worker that cannot reach Redis to register its schedule
  // should still come up and process anything already queued.
  void scheduleRecurring().catch((error: unknown) => {
    log.error({ err: error }, 'could not install the recurring job schedule');
  });
}

if (require.main === module) {
  main();
}
