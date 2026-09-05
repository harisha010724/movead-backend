import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { amountFor } from '../src/pricing/money';
import { ADVERTISER_RATE, DRIVER_RATE, DRIVER_SHARE, type PricingZone } from '../src/pricing/rates';

/**
 * The rate card (AC-02.1, AC-15).
 *
 * Two numbers per zone, and the relationship between them is the business
 * model: AC-15.3 fixes the driver's share at exactly 60% everywhere, so the
 * platform's gross margin is 40% whatever mix of Prime, Secondary and Network
 * a month happens to produce. A change to one side that misses the other does
 * not fail anywhere else — the pipeline would price it, the invoice would
 * render it, and the margin would simply be different.
 */

const ZONES: PricingZone[] = ['prime', 'secondary', 'network'];

describe('the rate card', () => {
  it('charges the pilot rates', () => {
    expect(ADVERTISER_RATE).toEqual({
      prime: '5.0000',
      secondary: '2.0000',
      network: '1.0000',
    });
  });

  it('pays the driver exactly 60% in every zone', () => {
    for (const zone of ZONES) {
      const share = new Decimal(DRIVER_RATE[zone]).dividedBy(ADVERTISER_RATE[zone]);
      expect(share.toString()).toBe(DRIVER_SHARE);
    }
  });

  it('leaves the platform 40% whatever the zone mix', () => {
    for (const zone of ZONES) {
      const margin = new Decimal(ADVERTISER_RATE[zone]).minus(DRIVER_RATE[zone]);
      expect(margin.dividedBy(ADVERTISER_RATE[zone]).toString()).toBe('0.4');
    }
  });

  it('prices the worked example from AC-14', () => {
    const charge = new Decimal(amountFor('60', ADVERTISER_RATE.prime))
      .plus(amountFor('25', ADVERTISER_RATE.secondary))
      .plus(amountFor('113', ADVERTISER_RATE.network));

    expect(charge.toFixed(2)).toBe('463.00');
  });

  it('prices the worked example from AC-21', () => {
    // 5 km Prime, 2 km Secondary, 3 km Prime = ₹44, and notably not the ₹50
    // that classifying the whole 10 km by its starting zone would produce.
    const charge = new Decimal(amountFor('5', ADVERTISER_RATE.prime))
      .plus(amountFor('2', ADVERTISER_RATE.secondary))
      .plus(amountFor('3', ADVERTISER_RATE.prime));

    expect(charge.toFixed(2)).toBe('44.00');
  });
});
