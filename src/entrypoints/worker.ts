import { type Worker } from 'bullmq';

import { closeDatabase } from '../db/sequelize';
import { closeQueues } from '../queue/queues';
import { installProcessHandlers, onShutdown } from '../shared/lifecycle';
import { loggerFor } from '../shared/logger';
import { closeRedis } from '../shared/redis';

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

function main(): void {
  installProcessHandlers();

  onShutdown('workers', async () => {
    // Closing a worker lets its current job finish before the connection goes.
    await Promise.all(workers.map((worker) => worker.close()));
  });
  onShutdown('queues', () => closeQueues());
  onShutdown('database', () => closeDatabase());
  onShutdown('redis', () => closeRedis());

  log.info({ queues: workers.length }, 'worker started');

  if (workers.length === 0) {
    log.warn('no processors registered yet — the pipeline modules are not built');
  }
}

if (require.main === module) {
  main();
}
