import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';

import { BadRequestError } from '../../shared/errors';
import { requireAuth, requirePermission } from '../../shared/http/middleware/auth';

import * as controller from './campaigns.controller';
import './campaigns.model';

const MAX_BYTES = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

function singleCreative(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }

    if (isLimit(error)) {
      next(new BadRequestError('File must be 25 MB or smaller.'));
      return;
    }

    next(error);
  });
}

function isLimit(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'LIMIT_FILE_SIZE');
}

/**
 * Advertiser campaigns, mounted at `/v1/campaigns`.
 *
 * Scope is the signed-in user's `advertiserId`, not a query parameter — an
 * advertiser cannot ask for someone else's list by id.
 */
export function campaignRoutes(): Router {
  const router = Router();

  router.use(requireAuth('advertiser'));

  router.get('/', requirePermission('advertiser.campaign.read'), controller.list);
  router.post('/', requirePermission('advertiser.campaign.create'), controller.create);
  router.post('/estimate', requirePermission('advertiser.campaign.create'), controller.estimate);
  router.post(
    '/available-vehicles',
    requirePermission('advertiser.vehicle.select'),
    controller.availableVehicles,
  );
  router.post(
    '/creatives',
    requirePermission('advertiser.campaign.create'),
    singleCreative,
    controller.uploadCreative,
  );
  router.get(
    '/creatives/:userId/:fileName',
    requirePermission('advertiser.campaign.read'),
    controller.downloadCreative,
  );
  router.get('/:id', requirePermission('advertiser.campaign.read'), controller.get);
  router.patch('/:id', requirePermission('advertiser.campaign.create'), controller.update);

  return router;
}
