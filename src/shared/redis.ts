import { Redis, type RedisOptions } from 'ioredis';

import { config } from './config';
import { loggerFor } from './logger';

const log = loggerFor('redis');

const connections = new Set<Redis>();

/**
 * Redis carries last-known vehicle positions, rate-limit counters, OTP
 * throttles and the BullMQ queues (architecture Part 1.3, Part 11.3).
 *
 * Connections are lazy so a process can start and report itself unready while
 * Redis is still coming up, rather than crash-looping against it.
 */
export function createRedis(purpose: string, overrides: RedisOptions = {}): Redis {
  const client = new Redis(config.redis.url, {
    lazyConnect: true,
    enableAutoPipelining: true,
    connectionName: `movead:${purpose}`,
    maxRetriesPerRequest: 3,
    ...overrides,
  });

  client.on('error', (error: Error) => log.error({ err: error, purpose }, 'redis error'));
  client.on('end', () => log.warn({ purpose }, 'redis connection closed'));

  connections.add(client);
  return client;
}

/** The general-purpose client: caching, counters, live positions. */
export const redis = createRedis('app');

export async function pingRedis(): Promise<void> {
  if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
  await redis.ping();
}

export async function closeRedis(): Promise<void> {
  await Promise.all(
    [...connections].map(async (client) => {
      if (client.status !== 'end') await client.quit();
    }),
  );
  connections.clear();
  log.info('redis connections closed');
}
