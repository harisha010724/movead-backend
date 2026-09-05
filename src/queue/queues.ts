import { Queue, Worker, type ConnectionOptions, type Processor } from 'bullmq';

import { createRedis } from '../shared/redis';
import { loggerFor } from '../shared/logger';

const log = loggerFor('queue');

/**
 * The pipeline's job names. Everything downstream of a GPS batch is a job,
 * enqueued by the outbox relay rather than by the ingestion request itself
 * (architecture Part 5.5, Part 13).
 *
 * Each is declared here even though the processors arrive module by module,
 * so the queue names live in one place and cannot drift between the producer
 * and the consumer.
 */
export const QueueName = {
  ClassifySessionWindow: 'classify.session.window',
  AllocateSegments: 'allocate.segments',
  AccrueEarnings: 'accrue.earnings',
  RunPayouts: 'payouts.run',
  ArchivePartitions: 'archive.partitions',
} as const;

export type QueueName = (typeof QueueName)[keyof typeof QueueName];

/**
 * BullMQ blocks on its connection, so it needs its own client with retries
 * disabled — sharing the app client would stall ordinary commands behind a
 * blocking read.
 */
function connection(purpose: string): ConnectionOptions {
  return createRedis(purpose, { maxRetriesPerRequest: null });
}

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  const existing = queues.get(name);
  if (existing) return existing;

  const queue = new Queue(name, {
    connection: connection(`queue:${name}`),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 86_400 * 7 },
    },
  });

  queues.set(name, queue);
  return queue;
}

/**
 * Every job must be safe to run twice — a retry after a partial failure is
 * normal, and the billing chain has to be idempotent by construction rather
 * than by the queue promising exactly-once delivery (Part 13.2).
 */
export function registerWorker<T>(name: QueueName, processor: Processor<T>): Worker<T> {
  const worker = new Worker<T>(name, processor, {
    connection: connection(`worker:${name}`),
    concurrency: 5,
  });

  worker.on('failed', (job, error) => {
    log.error(
      { err: error, queue: name, jobId: job?.id, attempt: job?.attemptsMade },
      'job failed',
    );
  });
  worker.on('completed', (job) => {
    log.debug({ queue: name, jobId: job.id }, 'job completed');
  });

  return worker;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
}
