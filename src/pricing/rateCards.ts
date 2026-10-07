import { money, toLedger, type Money } from './money';
import { ADVERTISER_RATE, DRIVER_SHARE, type PricingZone } from './rates';

/** Advertiser ₹/km for the three zones. */
export type ZoneRateMap = Record<PricingZone, Money>;

export function defaultAdvertiserRates(): ZoneRateMap {
  return { ...ADVERTISER_RATE };
}

/** AC-15.3 — driver pay is exactly 60% of the advertiser rate in every zone. */
export function driverRatesFrom(advertiser: ZoneRateMap): ZoneRateMap {
  return {
    prime: toLedger(money(advertiser.prime).times(DRIVER_SHARE)),
    secondary: toLedger(money(advertiser.secondary).times(DRIVER_SHARE)),
    network: toLedger(money(advertiser.network).times(DRIVER_SHARE)),
  };
}

export function advertiserRatesFromCampaign(row: {
  ratePrime?: string | null;
  rateSecondary?: string | null;
  rateNetwork?: string | null;
}): ZoneRateMap {
  return {
    prime: (row.ratePrime ?? ADVERTISER_RATE.prime) as Money,
    secondary: (row.rateSecondary ?? ADVERTISER_RATE.secondary) as Money,
    network: (row.rateNetwork ?? ADVERTISER_RATE.network) as Money,
  };
}

export function pricingBundle(advertiser: ZoneRateMap): {
  advertiser: ZoneRateMap;
  driver: ZoneRateMap;
} {
  return { advertiser, driver: driverRatesFrom(advertiser) };
}
