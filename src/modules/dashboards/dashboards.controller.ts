import { type Request, type Response } from 'express';

import {
  AdminDashboardQuerySchema,
  AdvertiserDashboardQuerySchema,
  LivePositionsQuerySchema,
  VehicleListQuerySchema,
} from '../../contracts/dashboards';
import { ForbiddenError, NotFoundError } from '../../shared/errors';
import { assertPermission, currentUser } from '../../shared/http/middleware/auth';
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

/**
 * The live map, read by operations over the fleet and by an advertiser over
 * their own vehicles.
 *
 * The scope is taken from the session, never from the query. `campaignId` used
 * to be the only filter, which meant an advertiser who simply omitted it was
 * served every vehicle on the platform — including the plates of a
 * competitor's campaign. Whose vehicles you may watch is not a parameter.
 */
export async function livePositions(req: Request, res: Response): Promise<void> {
  const query = parseQuery(req, LivePositionsQuerySchema);
  const { user } = currentUser(req);

  if (user.audience === 'driver') {
    throw new ForbiddenError('The live map is not part of the driver app.');
  }

  const advertiserId = user.audience === 'advertiser' ? user.advertiserId : null;

  if (user.audience === 'advertiser') {
    if (!advertiserId) throw new ForbiddenError('This account is not linked to an advertiser.');
    assertPermission(user, 'advertiser.tracking.read');

    /*
     * A 404 rather than an empty list. The advertiser filter below would
     * already return nothing for someone else's campaign, but "no vehicles
     * are tracking" and "that campaign is not yours" are different answers
     * and a buyer acts differently on each. 404 rather than 403 for the
     * reason the advertiser dashboard gives: whether another account's
     * campaign exists is not ours to confirm.
     */
    if (query.campaignId) {
      const campaign = await Campaign.findOne({
        where: { id: query.campaignId, advertiserId },
      });
      if (!campaign) throw new NotFoundError('That campaign does not exist.');
    }
  } else {
    assertPermission(user, 'vehicle.read');
  }

  res.json(
    await dashboards.livePositions({
      campaignId: query.campaignId ?? null,
      advertiserId,
      vehicleNumber: query.vehicleNumber ?? null,
    }),
  );
}

export async function vehicles(req: Request, res: Response): Promise<void> {
  const query = parseQuery(req, VehicleListQuerySchema);

  res.json(await dashboards.vehicleListing(query));
}
