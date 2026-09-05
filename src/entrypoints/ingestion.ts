import { Router } from 'express';

import { healthRoutes } from '../modules/health/health.routes';
import { config } from '../shared/config';
import { createApp } from '../shared/http/createApp';
import { serve } from '../shared/http/serve';

/**
 * The ingestion service: the GPS write path and nothing else.
 *
 * Separate for three reasons (Part 2.1). It scales on a different curve from
 * the rest of the platform — vehicles upload on a timer whether anyone is
 * looking at a dashboard or not. It needs its own rate limit, sized for
 * batches rather than for people. And if it falls over, payouts and admin must
 * stay up.
 */

const SERVICE = 'ingestion';

/** `POST /v1/tracking/points` lands here when the ingestion module is built. */
const v1 = Router();

export const app = createApp({
  serviceName: SERVICE,
  routers: [
    { path: '/health', router: healthRoutes(SERVICE) },
    { path: '/v1', router: v1 },
  ],
  /** A 500-point batch with all its metadata; comfortably above the ceiling. */
  jsonLimit: '2mb',
  /**
   * One batch per vehicle per minute is the design point, so this is roughly
   * two orders of magnitude of headroom per source — generous for a retry
   * storm after a network outage, tight enough to matter.
   */
  rateLimit: { windowMs: 60_000, max: 240 },
});

if (require.main === module) {
  serve(app, { serviceName: SERVICE, port: config.http.ingestionPort });
}
