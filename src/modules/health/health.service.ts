import { type Liveness, type Readiness } from '../../contracts/health';
import { pingDatabase } from '../../db/sequelize';
import { config } from '../../shared/config';
import { pingRedis } from '../../shared/redis';

/**
 * Liveness and readiness are deliberately different questions.
 *
 * Liveness asks whether the process is wedged; a failing answer gets the
 * container killed. Readiness asks whether it can serve; a failing answer just
 * takes it out of the load balancer. Checking the database in the liveness
 * probe conflates the two, and turns a brief RDS failover into a rolling
 * restart of every container at once.
 */

const PROBE_TIMEOUT_MS = 2_000;

export function liveness(service: string): Liveness {
  return {
    status: 'ok',
    service,
    version: config.version,
    uptimeSeconds: Math.round(process.uptime()),
  };
}

export async function readiness(service: string): Promise<Readiness> {
  const [database, redis] = await Promise.all([check(pingDatabase), check(pingRedis)]);

  return {
    status: database.status === 'up' && redis.status === 'up' ? 'ready' : 'degraded',
    service,
    version: config.version,
    checks: { database, redis },
  };
}

async function check(probe: () => Promise<unknown>) {
  const startedAt = performance.now();
  try {
    await withTimeout(probe(), PROBE_TIMEOUT_MS);
    return {
      status: 'up' as const,
      latencyMs: Math.round(performance.now() - startedAt),
      error: null,
    };
  } catch (error) {
    return {
      status: 'down' as const,
      latencyMs: null,
      error: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

/**
 * A probe that hangs is a probe that fails. Without this, a half-open socket
 * to Redis leaves the readiness endpoint itself hanging until the ALB times
 * the request out, which reads as a different fault entirely.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
