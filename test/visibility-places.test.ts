import { describe, expect, it } from 'vitest';

import { lookupOsm } from '../src/visibility/osm';
import {
  applyFeatures,
  clusterDwells,
  totalsByKind,
  type DwellSample,
} from '../src/visibility/places';

/**
 * Places are a second read of the same GPS, not a second price.
 *
 * Nearby crawls become one junction; a mapped mall may rename it. A fly-by
 * never arrives here — callers only send high and medium samples. Tiny
 * jitter is dropped so a depot gate cannot mint a place.
 */

function sample(partial: Partial<DwellSample> & Pick<DwellSample, 'lat' | 'lng'>): DwellSample {
  return {
    km: 0.2,
    seconds: 60,
    band: 'high',
    ...partial,
  };
}

describe('clustering readable dwells', () => {
  it('merges crawls that sit inside the same 80 m', () => {
    const places = clusterDwells([
      sample({ lat: 12.9716, lng: 77.5946 }),
      sample({ lat: 12.9718, lng: 77.5947, km: 0.15 }),
    ]);

    expect(places).toHaveLength(1);
    expect(places[0]?.kind).toBe('junction');
    expect(places[0]?.source).toBe('gps');
    expect(places[0]?.visits).toBe(2);
    expect(places[0]?.km).toBeCloseTo(0.35, 2);
  });

  it('keeps two places when the crawls are a block apart', () => {
    const places = clusterDwells([
      sample({ lat: 12.9716, lng: 77.5946 }),
      sample({ lat: 12.975, lng: 77.6 }),
    ]);

    expect(places).toHaveLength(2);
  });

  it('drops GPS jitter that never accumulated a dwell', () => {
    expect(
      clusterDwells([sample({ lat: 12.9716, lng: 77.5946, km: 0.01, seconds: 5 })]),
    ).toEqual([]);
  });
});

describe('naming a cluster from the map', () => {
  it('renames a junction as a mall when one sits inside 80 m', () => {
    const [junction] = clusterDwells([sample({ lat: 12.9342, lng: 77.6111 })]);
    expect(junction).toBeDefined();

    const named = applyFeatures([junction!], [
      { kind: 'signal', name: 'Silk Board', lat: 12.9342, lng: 77.6111 },
      { kind: 'mall', name: 'Forum Mall', lat: 12.93425, lng: 77.61115 },
    ]);

    expect(named[0]).toMatchObject({
      kind: 'mall',
      name: 'Forum Mall',
      source: 'osm',
    });
  });

  it('leaves the GPS name when Overpass knew nothing nearby', () => {
    const [junction] = clusterDwells([sample({ lat: 12.9716, lng: 77.5946 })]);
    const named = applyFeatures([junction!], [
      { kind: 'mall', name: 'Far Away', lat: 13.0, lng: 77.7 },
    ]);

    expect(named[0]).toMatchObject({ kind: 'junction', name: 'Junction', source: 'gps' });
  });

  it('rolls kinds up mall-first', () => {
    expect(
      totalsByKind([
        {
          kind: 'junction',
          name: 'Junction',
          lat: 0,
          lng: 0,
          km: 1.2,
          seconds: 40,
          visits: 1,
          source: 'gps',
        },
        {
          kind: 'mall',
          name: 'Forum Mall',
          lat: 0,
          lng: 0,
          km: 3.4,
          seconds: 80,
          visits: 2,
          source: 'osm',
        },
      ]),
    ).toEqual([
      { kind: 'mall', km: 3.4, count: 1 },
      { kind: 'junction', km: 1.2, count: 1 },
    ]);
  });
});

describe('OpenStreetMap is optional', () => {
  it('does not call Overpass from tests', async () => {
    await expect(lookupOsm([{ lat: 12.97, lng: 77.59 }])).resolves.toEqual([]);
  });
});
