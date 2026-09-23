import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';
import {
  FALLBACK_FREE_FLOW_KMH,
  MIN_SAMPLES,
  resolveBaseline,
  type BaselineRow,
} from '../src/modules/traffic/traffic.service';
import { gridKeyFor, gridKeySql, type LatLng } from '../src/shared/geo';

/**
 * The speed baseline: the fleet reading the road it is driving on.
 *
 * Two things here are worth a test rather than a comment. One is that the grid
 * key means the same thing in Node and in Postgres, because it is computed in
 * both and a disagreement would file observations in a neighbouring cell
 * without anything failing. The other is the order of the fallback ladder,
 * which decides whether a thin measurement or a broad one describes a road.
 */

describe('the cell a fix falls in', () => {
  it('files a fix by hundredths of a degree', () => {
    expect(gridKeyFor({ lat: 12.9756, lng: 77.6069 })).toBe('1297:7760');
  });

  /**
   * `77.1 * 100` is `7709.999999999999` in binary floating point. A bare
   * `Math.floor` files this fix in the cell to the west; Postgres, working in
   * exact decimal, does not. That disagreement is the whole reason
   * `gridKeyFor` rounds before it floors, and the band it happens in is the
   * one Delhi sits in — so this is a live coordinate, not a contrived one.
   */
  it('does not lose a cell to floating point', () => {
    expect(Math.floor(77.1 * 100)).toBe(7709);
    expect(gridKeyFor({ lat: 28.61, lng: 77.1 })).toBe('2861:7710');
  });

  it('gives a coordinate on a boundary to the cell it opens', () => {
    expect(gridKeyFor({ lat: 12.97, lng: 77.6 })).toBe('1297:7760');
  });

  it('separates coordinates on either side of a boundary', () => {
    expect(gridKeyFor({ lat: 12.9799, lng: 77.61 })).not.toBe(
      gridKeyFor({ lat: 12.9801, lng: 77.61 }),
    );
  });
});

describe('the fallback ladder', () => {
  const thick = (freeFlowKmh: number): BaselineRow => ({ freeFlowKmh, sampleCount: MIN_SAMPLES });
  const thin = (freeFlowKmh: number): BaselineRow => ({
    freeFlowKmh,
    sampleCount: MIN_SAMPLES - 1,
  });

  it('prefers the hour when the hour has been measured enough', () => {
    expect(resolveBaseline(thick(22), thick(40), 'PRIME')).toMatchObject({
      freeFlowKmh: 22,
      source: 'CELL_HOUR',
    });
  });

  /**
   * The substantive claim in the ladder: a thin reading loses to a broader
   * one rather than to nothing. Four observations of a Tuesday evening are
   * worse evidence about that road than four thousand across the week.
   */
  it('falls through a thinly-sampled hour to the whole week', () => {
    expect(resolveBaseline(thin(22), thick(40), 'PRIME')).toMatchObject({
      freeFlowKmh: 40,
      source: 'CELL',
    });
  });

  it('falls all the way to the zone when the cell is barely driven', () => {
    expect(resolveBaseline(thin(22), thin(40), 'PRIME')).toEqual({
      freeFlowKmh: FALLBACK_FREE_FLOW_KMH.PRIME,
      source: 'ZONE_DEFAULT',
      sampleCount: 0,
    });
  });

  it('falls to the zone when nothing has been measured at all', () => {
    expect(resolveBaseline(null, null, 'NETWORK')).toMatchObject({
      freeFlowKmh: FALLBACK_FREE_FLOW_KMH.NETWORK,
      source: 'ZONE_DEFAULT',
    });
  });

  it('treats exactly the minimum as enough', () => {
    expect(resolveBaseline(thick(22), null, 'PRIME').source).toBe('CELL_HOUR');
  });

  /**
   * Not arithmetic, but the assumption behind the defaults: the zones run from
   * the dense centre outwards, so their uncongested speeds have to as well. A
   * default that made Prime the fastest zone would quietly invert every
   * congestion reading that rested on it.
   */
  it('assumes the centre is slower than the edge', () => {
    expect(FALLBACK_FREE_FLOW_KMH.PRIME).toBeLessThan(FALLBACK_FREE_FLOW_KMH.SECONDARY);
    expect(FALLBACK_FREE_FLOW_KMH.SECONDARY).toBeLessThan(FALLBACK_FREE_FLOW_KMH.NETWORK);
  });
});

describe('the grid key in Postgres', () => {
  let reachable = false;

  beforeAll(async () => {
    reachable = await pingDatabase().then(
      () => true,
      () => false,
    );
    if (!reachable) {
      console.warn('\n  traffic SQL test skipped: no database reachable at DATABASE_URL\n');
    }
  });

  afterAll(async () => {
    if (reachable) await sequelize.close();
  });

  /**
   * The aggregation runs in SQL because millions of segments should not travel
   * through Node to be counted, which leaves two implementations of one key.
   * These coordinates include the floating-point trap above and both sides of
   * a cell boundary — the cases where the two would part company if they ever
   * did.
   */
  it('agrees with the one in Node', async (ctx: TestContext) => {
    if (!reachable) {
      ctx.skip();
      return;
    }

    const points: LatLng[] = [
      { lat: 12.9756, lng: 77.6069 },
      { lat: 28.61, lng: 77.1 }, // The floating-point case above.
      { lat: 28.61, lng: 77.24 }, // And another from the same band.
      { lat: 12.97, lng: 77.6 },
      { lat: 12.9799, lng: 77.6101 },
      { lat: 12.9801, lng: 77.6099 },
      { lat: 13.0, lng: 77.58 },
    ];

    const values = points
      .map((_, index) => `(${index}, :lat${index}::numeric, :lon${index}::numeric)`)
      .join(', ');

    const replacements = Object.fromEntries(
      points.flatMap((point, index) => [
        [`lat${index}`, point.lat],
        [`lon${index}`, point.lng],
      ]),
    );

    const rows = (await sequelize.query(
      `SELECT ${gridKeySql('v.lat', 'v.lon')} AS key
         FROM (VALUES ${values}) AS v(i, lat, lon)
        ORDER BY v.i`,
      { replacements, type: 'SELECT' },
    )) as { key: string }[];

    expect(rows.map((row) => row.key)).toEqual(points.map(gridKeyFor));
  });
});
