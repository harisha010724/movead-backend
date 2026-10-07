import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';

import { BadRequestError } from '../../shared/errors';
import { requireAuth, requirePermission } from '../../shared/http/middleware/auth';

import * as controller from './brandingProofs.controller';
import './brandingProofs.model';

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

export function adminBrandingProofRoutes(): Router {
  const router = Router();
  router.use(requireAuth('admin'));

  router.get('/branding-proofs', requirePermission('branding.review'), controller.queue);
  router.get('/branding-proofs/waiting', requirePermission('branding.review'), controller.waiting);
  router.get('/branding-proofs/eligible', requirePermission('branding.review'), controller.eligible);
  router.post(
    '/assignments/:id/branding-proofs',
    requirePermission('branding.review'),
    controller.request,
  );
  router.get(
    '/branding-proof-photos/:photoId',
    requirePermission('branding.review'),
    controller.photoFile,
  );

  return router;
}

export function driverBrandingProofRoutes(): Router {
  const router = Router();

  router.get('/branding-proof', controller.current);
  router.post('/branding-proofs', controller.start);
  router.post('/branding-proofs/:id/photos', singlePhoto, controller.uploadPhoto);
  router.post('/branding-proofs/:id/submit', controller.submit);
  router.get('/branding-proof-photos/:photoId', controller.driverPhoto);

  return router;
}
