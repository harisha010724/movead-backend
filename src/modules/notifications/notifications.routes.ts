import { Router } from 'express';

import { requireAuth } from '../../shared/http/middleware/auth';

import * as controller from './notifications.controller';
import './notifications.model';

/**
 * Staff inbox, mounted at `/v1/admin`.
 *
 * Anyone signed in as admin can read their own rows. There is no separate
 * permission — a notification is not a privileged action, it is the inbox.
 */
export function adminNotificationRoutes(): Router {
  const router = Router();

  router.use(requireAuth('admin'));

  router.get('/notifications', controller.list);
  router.post('/notifications/read-all', controller.readAll);
  router.post('/notifications/:id/read', controller.readOne);

  return router;
}

/**
 * Advertiser inbox, mounted at `/v1/notifications`.
 *
 * Own rows only. Approve and reject write here so the customer hears the
 * decision without refreshing the campaigns table.
 */
export function advertiserNotificationRoutes(): Router {
  const router = Router();

  router.use(requireAuth('advertiser'));

  router.get('/', controller.list);
  router.post('/read-all', controller.readAll);
  router.post('/:id/read', controller.readOne);

  return router;
}
