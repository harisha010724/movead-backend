import type { Request, Response } from 'express';

import { IdParamSchema } from '../../contracts/common';
import { ImpressionDayParamSchema } from '../../contracts/impressions';
import { ForbiddenError } from '../../shared/errors';
import { currentUser } from '../../shared/http/middleware/auth';
import { parseParams } from '../../shared/http/validate';
import * as campaigns from '../campaigns/campaigns.service';

import * as impressions from './impressions.service';

/**
 * The advertiser's own audience figures.
 *
 * Both routes resolve the campaign through `getForAdvertiser`, which is the
 * ownership check as well as the lookup: a campaign belonging to another
 * advertiser is not found. Scoping by the signed-in account rather than by a
 * parameter means over-reach is impossible rather than merely refused.
 */

function advertiserIdOf(req: Request): string {
  const { user } = currentUser(req);
  if (!user.advertiserId) {
    throw new ForbiddenError('Only an advertiser account can read campaign impressions.');
  }
  return user.advertiserId;
}

export async function forCampaign(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const campaign = await campaigns.getForAdvertiser(advertiserIdOf(req), id);

  res.json(await impressions.forCampaign({ id: campaign.id, name: campaign.name }));
}

export async function forDay(req: Request, res: Response): Promise<void> {
  const { id, date } = parseParams(req, ImpressionDayParamSchema);

  // Resolved before the day is read, so an advertiser probing another
  // advertiser's campaign gets the same 404 whatever date they ask for.
  const campaign = await campaigns.getForAdvertiser(advertiserIdOf(req), id);

  res.json(await impressions.forCampaignDay(campaign.id, date));
}
