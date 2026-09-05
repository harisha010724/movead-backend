import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';

import { BadRequestError } from '../../shared/errors';
import { requireAuth } from '../../shared/http/middleware/auth';
import * as installations from '../installations/installations.controller';
import * as notifications from '../notifications/notifications.controller';
import * as tracking from '../tracking/tracking.controller';

import * as controller from './drivers.controller';

/**
 * The signed-in driver's own pages. Audience, not a permission name, is the
 * gate — WEB-001. These read the driver linked on the session.
 *
 * Campaign and eligibility live in the installations module because that is
 * where assignment and installation state is; the driver sees the same shapes
 * the mobile app does.
 */

const MAX_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

/**
 * Multer's own errors surface as 500s unless they are translated, and the one
 * a driver on a phone will actually hit is the size limit — worth saying in
 * words rather than letting a 12 MP photo fail anonymously.
 */
function singleDocument(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    next(
      isLimit(error)
        ? new BadRequestError('Each document must be 10 MB or smaller.')
        : new BadRequestError('Could not read the upload.'),
    );
  });
}

/** Same handling, a smaller ceiling: an avatar has no business being 10 MB. */
function singlePhoto(req: Request, res: Response, next: NextFunction): void {
  photoUpload.single('file')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    next(
      isLimit(error)
        ? new BadRequestError('Your photo must be 5 MB or smaller.')
        : new BadRequestError('Could not read the upload.'),
    );
  });
}

function isLimit(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'LIMIT_FILE_SIZE'
  );
}

export function driverPortalRoutes(): Router {
  const router = Router();

  router.use(requireAuth('driver'));

  router.get('/me', controller.portalMe);
  router.patch('/me', controller.portalUpdateMe);
  router.post('/me/payout/reveal', controller.portalRevealPayout);
  router.post('/me/photo', singlePhoto, controller.portalUploadPhoto);
  router.get('/me/photo', controller.portalPhoto);

  /*
   * UI-015, UI-016. The plate and the category are absent by design: they are
   * what the vehicle *is*, and the driver owns everything that merely
   * describes it.
   */
  router.get('/me/vehicle', controller.portalVehicle);
  router.patch('/me/vehicle', controller.portalUpdateVehicle);
  router.post('/me/vehicle/photo', singlePhoto, controller.portalUploadVehiclePhoto);
  router.get('/me/vehicle/photo', controller.portalVehiclePhoto);

  /*
   * AC-04.3 keeps this off the terms screen and on its own. `PUT` rather than
   * `POST` because the driver is asserting a state — "I do consent" — and
   * sending it twice must not stack two decisions on top of each other.
   */
  router.get('/me/consent', controller.portalConsent);
  router.put('/me/consent', controller.portalSetConsent);

  router.get('/earnings', controller.portalEarnings);
  router.get('/campaign', installations.driverCampaign);
  router.get('/campaign/creative', installations.driverCreative);
  router.post('/assignments/:id/accept', installations.driverAccept);
  router.get('/eligibility', installations.driverEligibility);

  router.get('/documents', controller.portalDocuments);
  router.post('/documents', singleDocument, controller.portalUploadDocument);
  router.get('/documents/:id/file', controller.portalDocumentFile);

  /*
   * The driver's inbox, and the only way the phone hears about a status change
   * it did not cause. Assignment and installation already wrote rows here;
   * until now nothing could read them.
   */
  router.get('/notifications', notifications.list);
  router.post('/notifications/read-all', notifications.readAll);
  router.post('/notifications/:id/read', notifications.readOne);

  /*
   * Tracking. Mounted here, on the API, rather than on the ingestion service
   * it is architecturally destined for: a phone holds one base URL, and the
   * pipeline has to be provably correct before it is worth splitting off. It
   * is a router, so moving it later is a deployment change and not a rewrite.
   *
   * `/tracking/eligibility` is the same handler as `/eligibility` above. The
   * app was already asking for it under this path and getting a 404 that read,
   * on screen, as every condition failing.
   */
  router.get('/tracking/eligibility', installations.driverEligibility);
  router.post('/tracking/session', tracking.startSession);
  router.get('/tracking/session', tracking.readSession);
  router.delete('/tracking/session', tracking.stopSession);
  router.post('/tracking/points', tracking.ingestPoints);

  return router;
}
