import { Router } from 'express';

import { requireAuth, requirePermission } from '../../shared/http/middleware/auth';

import * as controller from './drivers.controller';

/**
 * Advertiser fleet browse, mounted at `/v1/vehicles`.
 *
 * Admin onboards the driver and pin. This list is how the advertiser sees
 * where they can place ads — without names or plates (ADV-039).
 */
export function advertiserVehicleRoutes(): Router {
  const router = Router();

  router.use(requireAuth('advertiser'));

  router.get('/available', requirePermission('advertiser.vehicle.read'), controller.availableFleet);

  return router;
}
