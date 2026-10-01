import { Router } from 'express';

import { requireAuth, requirePermission } from '../../shared/http/middleware/auth';

import * as controller from './reports.controller';
import './reports.model';

/**
 * Advertiser reports, mounted at `/v1/reports`.
 *
 * Scoped to the signed-in user's advertiser. A campaign belonging to someone
 * else is not found. Generation is synchronous: the four summaries and the
 * proof pack are small enough to wait on, and a kilometre-detail that would
 * exceed the row cap is refused rather than queued.
 */
export function reportRoutes(): Router {
  const router = Router();

  router.use(requireAuth('advertiser'));

  router.get('/', requirePermission('advertiser.report.read'), controller.list);
  router.post('/export', requirePermission('advertiser.report.read'), controller.create);
  router.get('/:id/download', requirePermission('advertiser.report.read'), controller.download);

  return router;
}
