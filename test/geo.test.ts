import { describe, expect, it } from 'vitest';

import { haversineKm, pointInPolygon, splitSegmentByZone, zoneForPoint } from '../src/shared/geo';

/** A box around MG Road, Bengaluru. */
const PRIME = [
  { lat: 12.97, lng: 77.6 },
  { lat: 12.97, lng: 77.62 },
  { lat: 12.98, lng: 77.62 },
  { lat: 12.98, lng: 77.6 },
];

const SECONDARY = [
  { lat: 12.99, lng: 77.58 },
  { lat: 12.99, lng: 77.6 },
  { lat: 13.01, lng: 77.6 },
  { lat: 13.01, lng: 77.58 },
];

describe('pointInPolygon', () => {
  it('accepts a point inside the ring', () => {
    expect(pointInPolygon({ lat: 12.975, lng: 77.61 }, PRIME)).toBe(true);
  });

  it('rejects a point well outside', () => {
    expect(pointInPolygon({ lat: 13.05, lng: 77.7 }, PRIME)).toBe(false);
  });

  it('rejects a ring with fewer than three corners', () => {
    expect(pointInPolygon({ lat: 12.975, lng: 77.61 }, PRIME.slice(0, 2))).toBe(false);
  });
});

describe('zoneForPoint', () => {
  it('prefers Prime when a point sits in both outlines', () => {
    const overlap = {
      prime: { path: PRIME },
      secondary: { path: PRIME },
    };
    expect(zoneForPoint({ lat: 12.975, lng: 77.61 }, overlap)).toBe('prime');
  });

  it('returns Secondary when only that outline contains the pin', () => {
    expect(
      zoneForPoint({ lat: 13.0, lng: 77.59 }, { prime: { path: PRIME }, secondary: { path: SECONDARY } }),
    ).toBe('secondary');
  });

  it('returns null outside both outlines — that is Network, not listed here', () => {
    expect(
      zoneForPoint({ lat: 12.9, lng: 77.5 }, { prime: { path: PRIME }, secondary: { path: SECONDARY } }),
    ).toBeNull();
  });
});

describe('haversineKm', () => {
  it('measures a known distance', () => {
    // One tenth of a degree of latitude is ~11.1 km anywhere on Earth.
    expect(haversineKm({ lat: 12.9, lng: 77.6 }, { lat: 13.0, lng: 77.6 })).toBeCloseTo(11.12, 2);
  });

  it('is zero for a vehicle that has not moved', () => {
    expect(haversineKm({ lat: 12.9, lng: 77.6 }, { lat: 12.9, lng: 77.6 })).toBe(0);
  });
});

/**
 * AC-21, which the spec calls the criterion most likely to be got wrong. The
 * assertions below are mostly about what the split must *not* do: bill a whole
 * journey at the rate of wherever it started, or snap a boundary to the
 * nearest fix. At ₹5 against ₹1 either is most of the bill.
 */
describe('splitSegmentByZone', () => {
  const zones = { prime: { path: PRIME }, secondary: { path: SECONDARY } };

  it('leaves travel that stays in one zone as one part', () => {
    const parts = splitSegmentByZone({ lat: 12.972, lng: 77.605 }, { lat: 12.978, lng: 77.615 }, zones);

    expect(parts).toHaveLength(1);
    expect(parts[0]?.zone).toBe('prime');
  });

  it('cuts at the boundary rather than at the fix, and the parts sum to the whole', () => {
    // Due south out of Prime: the edge is at 12.97, the fixes are either side.
    const from = { lat: 12.975, lng: 77.61 };
    const to = { lat: 12.965, lng: 77.61 };
    const parts = splitSegmentByZone(from, to, zones);

    expect(parts.map((part) => part.zone)).toEqual(['prime', 'network']);

    // The crossing is halfway, so each part is half — not "all prime" because
    // it started there, and not "all network" because it ended there.
    const total = haversineKm(from, to);
    expect(parts[0]?.distanceKm).toBeCloseTo(total / 2, 9);
    expect(parts[1]?.distanceKm).toBeCloseTo(total / 2, 9);
    expect(parts.reduce((sum, part) => sum + part.distanceKm, 0)).toBeCloseTo(total, 12);
  });

  it('records a re-entry as three parts, not as a majority', () => {
    // West across the Prime box and out the far side is prime → network only,
    // so cross the gap between the two boxes instead: Prime, the unzoned strip
    // between 12.98 and 12.99, then Secondary.
    const parts = splitSegmentByZone({ lat: 12.975, lng: 77.595 }, { lat: 13.0, lng: 77.595 }, zones);

    expect(parts.map((part) => part.zone)).toEqual(['network', 'secondary']);
  });

  it('splits a journey that leaves Prime and comes back into it', () => {
    // North out of the Prime box, across the gap, and into Secondary — then
    // the reverse leg back, which must be classified independently.
    const out = splitSegmentByZone({ lat: 12.975, lng: 77.61 }, { lat: 12.985, lng: 77.61 }, zones);
    expect(out.map((part) => part.zone)).toEqual(['prime', 'network']);

    const back = splitSegmentByZone({ lat: 12.985, lng: 77.61 }, { lat: 12.975, lng: 77.61 }, zones);
    expect(back.map((part) => part.zone)).toEqual(['network', 'prime']);
  });

  it('gives the overlap to Prime along the whole crossing, not only at the ends', () => {
    const overlapping = { prime: { path: PRIME }, secondary: { path: PRIME } };
    const parts = splitSegmentByZone({ lat: 12.972, lng: 77.605 }, { lat: 12.978, lng: 77.615 }, overlapping);

    expect(parts).toHaveLength(1);
    expect(parts[0]?.zone).toBe('prime');
  });

  it('produces nothing for a vehicle standing still, rather than a zero-length part', () => {
    expect(splitSegmentByZone({ lat: 12.975, lng: 77.61 }, { lat: 12.975, lng: 77.61 }, zones)).toEqual([]);
  });

  it('calls everything Network when the campaign has drawn no outlines', () => {
    const parts = splitSegmentByZone({ lat: 12.975, lng: 77.61 }, { lat: 12.965, lng: 77.61 }, {});

    expect(parts).toHaveLength(1);
    expect(parts[0]?.zone).toBe('network');
  });
});
