import { Op } from 'sequelize';

import { money, toLedger, type Money } from '../../pricing/money';
import {
  advertiserRatesFromCampaign,
  defaultAdvertiserRates,
  driverRatesFrom,
  type ZoneRateMap,
} from '../../pricing/rateCards';
import { NotFoundError } from '../../shared/errors';
import * as audit from '../audit/audit.service';

import { Advertiser } from './advertisers.model';
import { AdvertiserRateCard } from './rateCards.model';

export interface RateCardView {
  prime: Money;
  secondary: Money;
  network: Money;
  driver: { prime: Money; secondary: Money; network: Money };
  source: 'default' | 'custom';
  effectiveFrom: string | null;
}

export async function currentFor(advertiserId: string): Promise<RateCardView> {
  const advertiser = await Advertiser.findByPk(advertiserId);
  if (!advertiser) throw new NotFoundError('No advertiser with that id.');
  return viewFromCard(await latestCard(advertiserId));
}

export async function currentRates(advertiserId: string): Promise<ZoneRateMap> {
  const card = await latestCard(advertiserId);
  if (!card) return defaultAdvertiserRates();
  return {
    prime: toLedger(money(card.prime)),
    secondary: toLedger(money(card.secondary)),
    network: toLedger(money(card.network)),
  };
}

export function ratesFromCampaign(row: {
  ratePrime?: string | null;
  rateSecondary?: string | null;
  rateNetwork?: string | null;
}): ZoneRateMap {
  return advertiserRatesFromCampaign(row);
}

export async function latestByAdvertiserIds(
  advertiserIds: string[],
): Promise<Map<string, AdvertiserRateCard>> {
  if (advertiserIds.length === 0) return new Map();

  const rows = await AdvertiserRateCard.findAll({
    where: { advertiserId: { [Op.in]: advertiserIds } },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });

  const latest = new Map<string, AdvertiserRateCard>();
  for (const row of rows) {
    if (!latest.has(row.advertiserId)) latest.set(row.advertiserId, row);
  }
  return latest;
}

export function viewFromCard(card: AdvertiserRateCard | null): RateCardView {
  const advertiser = card
    ? {
        prime: toLedger(money(card.prime)),
        secondary: toLedger(money(card.secondary)),
        network: toLedger(money(card.network)),
      }
    : defaultAdvertiserRates();
  const driver = driverRatesFrom(advertiser);

  return {
    ...advertiser,
    driver,
    source: card ? 'custom' : 'default',
    effectiveFrom: card ? card.createdAt.toISOString() : null,
  };
}

export async function setFor(input: {
  advertiserId: string;
  prime: string;
  secondary: string;
  network: string;
  actorUserId: string;
  ip: string | null;
}): Promise<RateCardView> {
  const advertiser = await Advertiser.findByPk(input.advertiserId);
  if (!advertiser) throw new NotFoundError('No advertiser with that id.');

  const next = {
    prime: toLedger(money(input.prime)),
    secondary: toLedger(money(input.secondary)),
    network: toLedger(money(input.network)),
  };

  const current = await latestCard(input.advertiserId);
  if (
    current &&
    toLedger(money(current.prime)) === next.prime &&
    toLedger(money(current.secondary)) === next.secondary &&
    toLedger(money(current.network)) === next.network
  ) {
    return viewFromCard(current);
  }

  const created = await AdvertiserRateCard.create({
    advertiserId: input.advertiserId,
    prime: next.prime,
    secondary: next.secondary,
    network: next.network,
    createdBy: input.actorUserId,
  });

  await audit.record({
    action: 'advertiser.rate_card_set',
    entityType: 'advertiser',
    entityId: advertiser.id,
    before: current
      ? {
          prime: toLedger(money(current.prime)),
          secondary: toLedger(money(current.secondary)),
          network: toLedger(money(current.network)),
        }
      : null,
    after: next,
    actorUserId: input.actorUserId,
    ip: input.ip,
  });

  return viewFromCard(created);
}

async function latestCard(advertiserId: string): Promise<AdvertiserRateCard | null> {
  return AdvertiserRateCard.findOne({
    where: { advertiserId },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });
}
