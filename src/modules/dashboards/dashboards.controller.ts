import { type Request, type Response } from 'express';

import {
  AdminDashboardQuerySchema,
  AdvertiserDashboardQuerySchema,
  LivePositionsQuerySchema,
  VehicleListQuerySchema,
} from '../../contracts/dashboards';
import { ForbiddenError, NotFoundError } from '../../shared/errors';
import { currentUser } from '../../shared/http/middleware/auth';
import { parseQuery } from '../../shared/http/validate';
import { Campaign } from '../campaigns/campaigns.model';

import * as dashboards from './dashboards.service';

export async function admin(req: Request, res: Response): Promise<void> {
  const query = parseQuery(req, AdminDashboardQuerySchema);

  res.json(await dashboards.adminDashboard(query));
}

/**
 * The advertiser's dashboard, scoped to one of their own campaigns.
 *
 * `campaignId` is optional because the screen opens before one is chosen and
 * the newest campaign is the useful default. It is never trusted: the campaign
 * is re-read against the session's advertiser, so an id belonging to someone
 * else is a 404 rather than a window into their spend.
 */
export async function advertiser(req: Request, res: Response): Promise<void> {
  const query = parseQuery(req, AdvertiserDashboardQuerySchema);
  const { user } = currentUser(req);

  if (!user.advertiserId) throw new ForbiddenError('This account is not linked to an advertiser.');

  const campaign = await Campaign.findOne({
    where: {
      advertiserId: user.advertiserId,
      ...(query.campaignId ? { id: query.campaignId } : {}),
    },
    order: [['createdAt', 'DESC']],
  });

  if (!campaign) throw new NotFoundError('That campaign does not exist.');

  res.json(
    await dashboards.advertiserDashboard({
      campaignId: campaign.id,
      range: { from: query.from, to: query.to },
    }),
  );
}

export async function livePositions(req: Request, res: Response): Promise<void> {
  const query = parseQuery(req, LivePositionsQuerySchema);

  res.json(await dashboards.livePositions(query.campaignId ?? null));
}

export async function vehicles(req: Request, res: Response): Promise<void> {
  const query = parseQuery(req, VehicleListQuerySchema);

  res.json(await dashboards.vehicleListing(query));
}
