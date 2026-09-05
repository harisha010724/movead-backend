import pino, { type Logger } from 'pino';

import { config } from './config';
import { getContext } from './context';

/**
 * Structured JSON logs with a correlation id, per architecture Part 14.1.
 *
 * In production this is one JSON object per line for CloudWatch to parse. In
 * development `pino-pretty` renders it for humans; it is a devDependency, so
 * the transport is only ever configured off the production path.
 */

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.otp',
  '*.code',
  '*.accessToken',
  '*.refreshToken',
  '*.token',
];

export const logger: Logger = pino({
  level: config.logLevel,
  base: { version: config.version },
  redact: { paths: redactPaths, censor: '[redacted]' },
  formatters: {
    level: (label) => ({ level: label }),
  },
  /**
   * Every log line carries the correlation id of whatever request or job is
   * running, without a single call site having to pass it.
   */
  mixin() {
    const context = getContext();
    return context ? { requestId: context.requestId, actorId: context.actor?.id } : {};
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(config.isProduction || config.isTest
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,version' },
        },
      }),
});

/** A child logger tagged with the subsystem that owns it. */
export function loggerFor(component: string): Logger {
  return logger.child({ component });
}
