import { type Request, type Response } from 'express';

import { IdParamSchema } from '../../contracts/common';
import { NotificationListQuerySchema } from '../../contracts/notifications';
import { currentUser } from '../../shared/http/middleware/auth';
import { parseParams, parseQuery } from '../../shared/http/validate';

import * as notifications from './notifications.service';

/**
 * Which inbox the signed-in caller owns.
 *
 * A driver session carries a `driverId` and its rows are addressed to it;
 * everyone else reads their `users` row. Deriving this from the session rather
 * than from the route means the driver app cannot read a staff inbox by
 * calling the staff path, whatever the mounting looks like.
 */
function inboxOf(req: Request): notifications.InboxOwner {
  const { user } = currentUser(req);
  if (user.audience === 'driver' && user.driverId) return { driverId: user.driverId };
  return { userId: user.id };
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = parseQuery(req, NotificationListQuerySchema);
  res.json(await notifications.listFor(inboxOf(req), query.limit));
}

export async function readOne(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  res.json(await notifications.markRead(inboxOf(req), id));
}

export async function readAll(req: Request, res: Response): Promise<void> {
  res.json(await notifications.markAllRead(inboxOf(req)));
}
