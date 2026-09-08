import { Router } from 'express';

import { requireAnyAuth, requireAuth, requirePermission } from '../../shared/http/middleware/auth';

import * as controller from './dashboards.controller';

/**
 * The reporting surface behind both landing screens.
 *
 * Three routers rather than one because the audience differs per path, and the
 * audience is what the guard checks: operations reads the whole platform, an
 * advertiser reads only their own campaigns, and the live map is read by both.
 * A single router would have to re-derive that per route, which is the shape
 * mistakes hide in.
 */

/** Operations' view of the platform, mounted at `/v1/dashboard`. */
export function adminDashboardRoutes(): Router {
  const router = Router();

  router.use(requireAuth('admin'));

  // `campaign.read` rather than a new key: this is the question the campaign
  // list already answers, asked across every campaign at once.
  router.get('/admin', requirePermission('campaign.read'), controller.admin);

  return router;
}

/** One advertiser's campaign performance, mounted at `/v1/dashboard`. */
export function advertiserDashboardRoutes(): Router {
  const router = Router();

  router.use(requireAuth('advertiser'));

  router.get('/advertiser', requirePermission('advertiser.report.read'), controller.advertiser);

  return router;
}

/**
 * The fleet, mounted at `/v1/vehicles`.
 *
 * Live positions are open to either portal — an operator watching the whole
 * fleet and an advertiser watching one campaign are the same query with a
 * different filter, and the filter comes from the campaign id rather than from
 * who is asking.
 */
export function fleetRoutes(): Router {
  const router = Router();

  router.get('/live-positions', requireAnyAuth(), controller.livePositions);
  router.get('/', requireAuth('admin'), requirePermission('vehicle.read'), controller.vehicles);

  return router;
}
