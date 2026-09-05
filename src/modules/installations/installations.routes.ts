import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';

import { BadRequestError } from '../../shared/errors';
import { requireAuth, requirePermission } from '../../shared/http/middleware/auth';

import * as controller from './installations.controller';
import './installations.model';

const MAX_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

function singlePhoto(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    next(
      isLimit(error)
        ? new BadRequestError('Each photo must be 10 MB or smaller.')
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

/**
 * Operations side of AC-22 and AC-06, mounted at `/v1/admin`.
 *
 * `installation.upload` and `installation.approve` are separate permissions on
 * purpose: AC-06.12 wants the installer and the approver to be different
 * people, and the row-level check constraint enforces it even for an account
 * that somehow holds both.
 */
export function adminInstallationRoutes(): Router {
  const router = Router();

  router.use(requireAuth('admin'));

  router.post(
    '/campaigns/:id/vehicles',
    requirePermission('campaign.assign'),
    controller.assign,
  );
  router.get(
    '/campaigns/:id/vehicles',
    requirePermission('campaign.read'),
    controller.listForCampaign,
  );
  router.post(
    '/assignments/:id/unassign',
    requirePermission('campaign.assign'),
    controller.unassign,
  );

  router.get('/installations', requirePermission('installation.review'), controller.queue);
  router.get(
    '/assignments/:id/photos',
    requirePermission('installation.review'),
    controller.photos,
  );
  router.post(
    '/assignments/:id/photos',
    requirePermission('installation.upload'),
    singlePhoto,
    controller.uploadPhoto,
  );
  router.get(
    '/installation-photos/:photoId',
    requirePermission('installation.review'),
    controller.photoFile,
  );
  router.post(
    '/assignments/:id/submit',
    requirePermission('installation.upload'),
    controller.submit,
  );
  router.post(
    '/assignments/:id/approve',
    requirePermission('installation.approve'),
    controller.approve,
  );
  router.post(
    '/assignments/:id/reject',
    requirePermission('installation.approve'),
    controller.reject,
  );

  return router;
}
