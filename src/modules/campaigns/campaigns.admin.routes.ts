import { Router } from 'express';

import { requireAuth, requirePermission } from '../../shared/http/middleware/auth';

import * as controller from './campaigns.controller';
import './campaigns.model';

/**
 * Operations review of advertiser campaigns, mounted at `/v1/admin`.
 *
 * Distinct from `/v1/campaigns`, which is scoped to the signed-in advertiser.
 * A submitted campaign moves through review, print, then install, and once
 * live can be paused, resumed, stopped or completed. Each transition is a
 * named action so the advertiser hears the real stage, not a single
 * "approved" that skipped the printer — and so does every driver carrying it.
 */
export function adminCampaignRoutes(): Router {
  const router = Router();

  router.use(requireAuth('admin'));

  router.get('/campaigns', requirePermission('campaign.read'), controller.adminList);
  router.get('/campaigns/:id', requirePermission('campaign.read'), controller.adminGet);
  router.get('/campaigns/:id/creative', requirePermission('campaign.read'), controller.adminCreative);
  router.post('/campaigns/:id/approve', requirePermission('campaign.approve'), controller.adminApprove);
  router.post('/campaigns/:id/print-ready', requirePermission('campaign.approve'), controller.adminPrintReady);
  router.post('/campaigns/:id/installed', requirePermission('campaign.approve'), controller.adminInstalled);
  router.post('/campaigns/:id/reject', requirePermission('campaign.approve'), controller.adminReject);
  router.post('/campaigns/:id/pause', requirePermission('campaign.approve'), controller.adminPause);
  router.post('/campaigns/:id/resume', requirePermission('campaign.approve'), controller.adminResume);
  router.post('/campaigns/:id/complete', requirePermission('campaign.approve'), controller.adminComplete);
  router.post('/campaigns/:id/stop', requirePermission('campaign.approve'), controller.adminStop);

  return router;
}
