import { describe, expect, it } from 'vitest';

import {
  coefficientsFor,
  CURRENT_MODEL_VERSION,
  knownModelVersions,
  type Coefficients,
} from '../src/impressions/coefficients';
import { daypartFactorFor, impressionsFor, vehiclesPerLaneKm } from '../src/impressions/model';

/**
 * The impression model.
 *
 * Every figure an advertiser is shown comes out of this file, so what is
 * tested here is not that the arithmetic runs but that each multiplier does
 * what it claims: that congestion is read as density rather than applied twice,
 * that an empty road still has pedestrians on it, and that the stored
 * breakdown multiplies back to the stored total. The coefficient values are
 * illustrative and will move; the relationships between them are the model.
 */

const V1 = coefficientsFor(CURRENT_MODEL_VERSION);

/** A prime corridor at dusk, driven at a third of free-flow speed. */
const CONGESTED = {
  distanceKm: 0.021,
  observedKmh: 12,
  baselineKmh: 34,
  hourOfDay: 18,
  zone: 'PRIME',
} as const;

describe('reading density out of speed', () => {
  it('finds no traffic on a road being driven at its free-flow speed', () => {
    expect(vehiclesPerLaneKm(34, 34, 150)).toBe(0);
  });

  it('finds a jammed lane where nothing is moving', () => {
    expect(vehiclesPerLaneKm(0, 34, 150)).toBe(150);
  });

  /** Greenshields is linear, which is the property that makes it defensible. */
  it('finds half a jammed lane at half the free-flow speed', () => {
    expect(vehiclesPerLaneKm(17, 34, 150)).toBeCloseTo(75, 6);
  });

  it('treats beating the baseline as an empty road, not as negative traffic', () => {
    expect(vehiclesPerLaneKm(60, 34, 150)).toBe(0);
  });

  it('claims nothing when there is no baseline to compare against', () => {
    expect(vehiclesPerLaneKm(12, 0, 150)).toBe(0);
  });
});

describe('the daypart bands', () => {
  it('counts a midday hour in full', () => {
    expect(daypartFactorFor(12, V1)).toBe(V1.daypart.daylightFactor);
  });

  it('discounts dusk', () => {
    expect(daypartFactorFor(18, V1)).toBe(V1.daypart.duskFactor);
  });

  it('discounts the small hours hardest', () => {
    expect(daypartFactorFor(3, V1)).toBe(V1.daypart.nightFactor);
    expect(daypartFactorFor(23, V1)).toBe(V1.daypart.nightFactor);
  });

  it('never rates a dark hour above a lit one', () => {
    const hours = Array.from({ length: 24 }, (_, hour) => daypartFactorFor(hour, V1));

    expect(Math.max(...hours)).toBe(V1.daypart.daylightFactor);
    expect(Math.min(...hours)).toBe(V1.daypart.nightFactor);
  });
});

describe('one segment, priced as an audience', () => {
  const result = impressionsFor(CONGESTED, V1);

  /**
   * The arithmetic in `docs/impressions-and-audience.md`, to four figures. Not
   * because the number is right — the coefficients are not calibrated — but
   * because the documented worked example and the code have to be the same
   * model. A discrepancy here means one of the two has moved.
   */
  it('matches the worked example in the strategy document', () => {
    expect(result.vehiclesPerLaneKm).toBeCloseTo(97.06, 2);
    expect(result.vehiclesPerKm).toBeCloseTo(388.24, 2);
    expect(result.inVehiclePersonsPerKm).toBeCloseTo(582.35, 2);
    expect(result.personsPresentPerKm).toBeCloseTo(702.35, 2);
    expect(result.impressions).toBeCloseTo(2.82, 2);
  });

  /**
   * The stored row has to be self-justifying: an auditor reading it back must
   * be able to multiply the parts and land on the total, without the code.
   */
  it('multiplies back to its own total', () => {
    const rebuilt =
      result.personsPresentPerKm *
      result.lineOfSightShare *
      result.wrapQuality *
      result.daypartFactor *
      CONGESTED.distanceKm;

    expect(rebuilt).toBeCloseTo(result.impressions, 10);
  });

  it('scales linearly with distance', () => {
    const twice = impressionsFor({ ...CONGESTED, distanceKm: 0.042 }, V1);
    expect(twice.impressions).toBeCloseTo(result.impressions * 2, 10);
  });

  it('gives a segment that covered no ground no audience', () => {
    expect(impressionsFor({ ...CONGESTED, distanceKm: 0 }, V1).impressions).toBe(0);
  });
});

/**
 * The correction that the strategy document's first draft got wrong: density
 * and congestion are one quantity, not two. If congestion were applied a
 * second time on top of a static density, freeing the road would reduce the
 * audience to nothing rather than to the people still standing beside it.
 */
describe('congestion is the density measurement, not a multiplier on top of one', () => {
  it('leaves the pedestrians behind on an empty road', () => {
    const empty = impressionsFor({ ...CONGESTED, observedKmh: 34 }, V1);

    expect(empty.vehiclesPerKm).toBe(0);
    expect(empty.personsPresentPerKm).toBe(V1.zones.PRIME.pedestrianDensity);
    expect(empty.impressions).toBeGreaterThan(0);
  });

  it('grows the audience as the road slows, without compounding', () => {
    const speeds = [30, 24, 18, 12, 6].map(
      (observedKmh) => impressionsFor({ ...CONGESTED, observedKmh }, V1).vehiclesPerKm,
    );

    // Equal steps in speed give equal steps in density. A second congestion
    // factor anywhere in the chain would bend this into a curve.
    const steps = speeds.slice(1).map((value, index) => value - (speeds[index] as number));
    for (const step of steps) expect(step).toBeCloseTo(steps[0] as number, 6);
  });
});

describe('zones', () => {
  it('finds a denser audience in the centre than at the edge', () => {
    const inZone = (zone: 'PRIME' | 'SECONDARY' | 'NETWORK'): number =>
      impressionsFor({ ...CONGESTED, zone }, V1).impressions;

    expect(inZone('PRIME')).toBeGreaterThan(inZone('SECONDARY'));
    expect(inZone('SECONDARY')).toBeGreaterThan(inZone('NETWORK'));
  });
});

describe('model versions', () => {
  it('serves the current version', () => {
    expect(knownModelVersions()).toContain(CURRENT_MODEL_VERSION);
  });

  /**
   * Falling back to the newest coefficients for a version that has gone
   * missing would silently re-price a campaign's audience against a model it
   * was not sold on — the one outcome the versioning exists to prevent.
   */
  it('refuses a version it does not have rather than guessing', () => {
    expect(() => coefficientsFor('v9.9.9')).toThrow(/Unknown impression model version/);
  });

  it('keeps every published version reachable', () => {
    for (const version of knownModelVersions()) {
      expect(coefficientsFor(version)).toBeDefined();
    }
  });

  /**
   * Bounds rather than values: the numbers are expected to move as they are
   * calibrated, but a share above one would be claiming more audience than is
   * present, and these are multiplied together on every segment.
   */
  it('keeps every share a share', () => {
    const shares = (c: Coefficients): number[] => [
      c.lineOfSightShare,
      c.wrapQuality,
      c.daypart.daylightFactor,
      c.daypart.duskFactor,
      c.daypart.nightFactor,
    ];

    for (const version of knownModelVersions()) {
      for (const share of shares(coefficientsFor(version))) {
        expect(share).toBeGreaterThan(0);
        expect(share).toBeLessThanOrEqual(1);
      }
    }
  });
});
