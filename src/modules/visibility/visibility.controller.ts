import type { Request, Response } from 'express';

import { IdParamSchema } from '../../contracts/common';
import { ForbiddenError } from '../../shared/errors';
import { currentUser } from '../../shared/http/middleware/auth';
import { parseParams } from '../../shared/http/validate';
import * as campaigns from '../campaigns/campaigns.service';

import * as visibility from './visibility.service';

/**
 * The advertiser's own readability figures.
 *
 * Resolved through `getForAdvertiser`, which is the ownership check as well
 * as the lookup: a campaign belonging to another advertiser is not found.
 * Scoping by the signed-in account rather than by a parameter means
 * over-reach is impossible rather than merely refused.
 */

function advertiserIdOf(req: Request): string {
  const { user } = currentUser(req);
  if (!user.advertiserId) {
    throw new ForbiddenError('Only an advertiser account can read campaign visibility.');
  }
  return user.advertiserId;
}

export async function forCampaign(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const campaign = await campaigns.getForAdvertiser(advertiserIdOf(req), id);

  res.json(await visibility.forCampaign(campaign.id));
}
