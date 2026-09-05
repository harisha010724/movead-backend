import { randomUUID } from 'node:crypto';

import { type RequestHandler } from 'express';

import { runWithContext } from '../../context';

const HEADER = 'x-request-id';

/**
 * Opens the async-local context for the life of the request and echoes the
 * correlation id back. Reusing an inbound id lets one trace span the mobile
 * app, the load balancer and every log line the request produces.
 *
 * This must be mounted before anything that logs.
 */
export function requestContext(): RequestHandler {
  return (req, res, next) => {
    const inbound = req.get(HEADER);
    const requestId = inbound && inbound.length <= 128 ? inbound : randomUUID();

    res.setHeader(HEADER, requestId);
    runWithContext({ requestId }, () => {
      next();
    });
  };
}
