import { config } from './config';
import { logger } from './logger';

/**
 * Orderly shutdown.
 *
 * ECS sends SIGTERM and waits before SIGKILL. In that window the process must
 * stop taking new work, let what is in flight finish, and close its pools. A
 * worker killed mid-transaction is not a data loss problem — the transaction
 * rolls back — but a GPS batch dropped between `COPY` and the outbox insert
 * would be, which is why both live in one transaction (Part 5.5).
 */

type ShutdownTask = () => Promise<void> | void;

const tasks: { name: string; run: ShutdownTask }[] = [];
let shuttingDown = false;

/** Tasks run in reverse registration order: last opened, first closed. */
export function onShutdown(name: string, run: ShutdownTask): void {
  tasks.push({ name, run });
}

export async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ reason }, 'shutting down');

  const forceExit = setTimeout(() => {
    logger.fatal({ reason }, 'shutdown timed out, forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  for (const task of [...tasks].reverse()) {
    try {
      await task.run();
    } catch (error) {
      logger.error({ err: error, task: task.name }, 'shutdown task failed');
    }
  }

  clearTimeout(forceExit);
  logger.info({ reason }, 'shutdown complete');
  process.exit(exitCode);
}

export function installProcessHandlers(): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  /**
   * An unhandled rejection or uncaught exception means the process is in a
   * state nobody reasoned about. Log it and leave: a restarted container is
   * more trustworthy than one carrying unknown state through a payout run.
   */
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });
}
