import { Router } from 'express';

import { getLiveness, getReadiness } from './health.controller';

/**
 * Routers stay thin: a path, a method, a handler. No logic, so the route table
 * remains readable as a table.
 *
 * Health sits outside `/v1` on purpose — probes belong to the deployment, not
 * to the published API, and must keep working across a version bump.
 */
export function healthRoutes(service: string): Router {
  const router = Router();

  router.get('/live', getLiveness(service));
  router.get('/ready', getReadiness(service));

  return router;
}
