import { Router } from 'express';

import { requireAuth, requirePermission } from '../../shared/http/middleware/auth';

import * as controller from './drivers.controller';

/**
 * Admin-side onboarding routes.
 *
 * Read and write are separate permissions throughout, so a future read-only
 * support role is a grant rather than a new set of endpoints (ADM-028).
 */
export function adminDriverRoutes(): Router {
  const router = Router();

  router.use(requireAuth('admin'));

  router.post('/drivers', requirePermission('driver.create'), controller.create);
  router.get('/drivers', requirePermission('driver.read'), controller.list);
  router.get('/drivers/:id', requirePermission('driver.read'), controller.detail);
  router.patch('/drivers/:id', requirePermission('driver.create'), controller.update);
  // Its own permission, not `driver.suspend`: suspending stops a driver
  // working, removing takes them off the platform. Separable later (ADM-028).
  router.delete('/drivers/:id', requirePermission('driver.delete'), controller.remove);

  router.post('/drivers/:id/approve', requirePermission('driver.approve'), controller.approve);
  router.post('/drivers/:id/reject', requirePermission('driver.approve'), controller.reject);
  router.post('/drivers/:id/suspend', requirePermission('driver.suspend'), controller.suspend);
  router.post('/drivers/:id/reinstate', requirePermission('driver.suspend'), controller.reinstate);

  router.post('/drivers/:id/vehicles', requirePermission('driver.create'), controller.addVehicle);

  router.post(
    '/vehicles/in-zones',
    requirePermission('vehicle.read'),
    controller.vehiclesInZones,
  );
  router.patch('/vehicles/:id', requirePermission('driver.create'), controller.updateVehicle);

  router.post(
    '/vehicles/:id/verify-documents',
    requirePermission('vehicle.approve'),
    controller.verifyVehicleDocuments,
  );
  router.post(
    '/vehicles/:id/approve',
    requirePermission('vehicle.approve'),
    controller.approveVehicle,
  );
  router.post(
    '/vehicles/:id/reject',
    requirePermission('vehicle.approve'),
    controller.rejectVehicle,
  );
  router.post(
    '/vehicles/:id/suspend',
    requirePermission('vehicle.suspend'),
    controller.suspendVehicle,
  );
  router.post(
    '/vehicles/:id/reinstate',
    requirePermission('vehicle.suspend'),
    controller.reinstateVehicle,
  );
  router.get('/vehicles/:id/history', requirePermission('vehicle.read'), controller.vehicleHistory);
  /*
   * `vehicle.read` rather than `vehicle.approve`, matching the document file
   * route above: looking at the car is a lower bar than deciding about it.
   */
  router.get('/vehicles/:id/photo', requirePermission('vehicle.read'), controller.vehiclePhoto);

  router.post('/documents', requirePermission('document.verify'), controller.registerDocument);
  /*
   * Reading a document is a lower bar than deciding on one: an operator may
   * need to look at a licence without holding the authority to verify it. This
   * is the first route to use `document.read`, which has been in the
   * permission catalogue since the first migration with nothing behind it.
   */
  router.get(
    '/documents/:id/file',
    requirePermission('document.read'),
    controller.documentFile,
  );
  router.post(
    '/documents/:id/verify',
    requirePermission('document.verify'),
    controller.verifyDocument,
  );
  router.post(
    '/documents/:id/reject',
    requirePermission('document.verify'),
    controller.rejectDocument,
  );

  return router;
}
