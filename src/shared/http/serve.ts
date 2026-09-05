import { type Server } from 'node:http';

import { type Express } from 'express';
import { createHttpTerminator } from 'http-terminator';

import { closeDatabase } from '../../db/sequelize';
import { config } from '../config';
import { onShutdown, installProcessHandlers } from '../lifecycle';
import { loggerFor } from '../logger';
import { closeRedis } from '../redis';

/**
 * Boots an HTTP service and wires it into the shutdown sequence.
 *
 * `http-terminator` is here because `server.close()` alone waits for keep-alive
 * connections to go idle, which they never do while a client is polling. It
 * closes idle sockets immediately and lets in-flight requests finish.
 */
export function serve(app: Express, options: { serviceName: string; port: number }): Server {
  const log = loggerFor(options.serviceName);

  installProcessHandlers();

  const server = app.listen(options.port, () => {
    log.info(
      { port: options.port, env: config.env, version: config.version },
      `${options.serviceName} listening`,
    );
  });

  const terminator = createHttpTerminator({ server });

  onShutdown('http', () => terminator.terminate());
  onShutdown('database', () => closeDatabase());
  onShutdown('redis', () => closeRedis());

  return server;
}
