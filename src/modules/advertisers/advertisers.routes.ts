import { Router } from 'express';

import { requireAuth, requirePermission } from '../../shared/http/middleware/auth';

import * as controller from './advertisers.controller';

/**
 * Advertiser onboarding, mounted at `/v1/admin`.
 *
 * Creating an advertiser's login is `user.create`, the same permission as
 * creating a staff account, because both hand someone a way into the platform.
 */
export function adminAdvertiserRoutes(): Router {
  const router = Router();

  router.use(requireAuth('admin'));

  router.post('/advertisers', requirePermission('advertiser.create'), controller.create);
  router.get('/advertisers', requirePermission('advertiser.read'), controller.list);
  // Correcting an account is the same authority as opening one, as with drivers.
  // Whoever can put a company on the platform can fix what they typed.
  router.patch('/advertisers/:id', requirePermission('advertiser.create'), controller.update);
  router.post('/advertisers/:id/users', requirePermission('user.create'), controller.createUser);

  return router;
}
