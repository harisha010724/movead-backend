import type { Money } from './money';

/**
 * What a kilometre costs and what it pays (AC-02.1, AC-15.1).
 *
 * One table, because there are two sides to every kilometre and they are not
 * independent: AC-15.3 fixes the driver's share at exactly 60% in every zone,
 * so platform margin is 40% whatever the zone mix turns out to be. Held apart
 * — as they were, in the campaign service and the installation service — a
 * change to one side is a silent change to the margin, and the number that
 * moved is in a different file from the number that should have moved with it.
 *
 * Rates are platform-fixed for the pilot and are not advertiser-editable
 * (AC-02.3). They are written onto each segment as it is priced, so a later
 * change cannot reprice a kilometre already driven (AC-14.4, AC-15.6).
 */

export type PricingZone = 'prime' | 'secondary' | 'network';

/** AC-02.1 — ₹5 / ₹2 / ₹1. */
export const ADVERTISER_RATE: Record<PricingZone, Money> = {
  prime: '5.0000',
  secondary: '2.0000',
  network: '1.0000',
};

/** AC-15.1 — ₹3.00 / ₹1.20 / ₹0.60, being 60% of the above. */
export const DRIVER_RATE: Record<PricingZone, Money> = {
  prime: '3.0000',
  secondary: '1.2000',
  network: '0.6000',
};

/** AC-15.3. Asserted in `test/rates.test.ts` rather than trusted to review. */
export const DRIVER_SHARE = '0.6';
