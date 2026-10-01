import { describe, expect, it } from 'vitest';

import {
  bandOf,
  classifies,
  CURRENT_VISIBILITY_VERSION,
  cutoffsFor,
  knownVisibilityVersions,
  observedKmh,
  publishedBands,
  visibilityOf,
} from '../src/visibility/bands';

/**
 * The visibility bands.
 *
 * What is tested here is the rule, not the SQL that sums it. A crawl is high,
 * city traffic is medium, a fly-by is low, and a parked vehicle is none of
 * those — the last one is the failure this file exists to catch, because
 * treating a night in a depot as "high visibility" would be the easy bug.
 */

const V1 = cutoffsFor(CURRENT_VISIBILITY_VERSION);

describe('the published cutoffs', () => {
  it('names the version new work is classified under', () => {
    expect(CURRENT_VISIBILITY_VERSION).toBe('v1.0.0');
    expect(knownVisibilityVersions()).toEqual(['v1.0.0']);
  });

  it('writes the 15 / 35 bands out so a screen can show them', () => {
    expect(publishedBands(V1)).toEqual({
      high: '<15 km/h',
      medium: '15–35 km/h',
      low: '>35 km/h',
    });
  });

  it('refuses a version it does not know rather than quietly using today\'s', () => {
    expect(() => cutoffsFor('v9.9.9')).toThrow(/unknown visibility version/i);
  });
});

describe('banding a speed', () => {
  it('treats a crawl as high visibility', () => {
    expect(visibilityOf(0, V1)).toBe('high');
    expect(visibilityOf(14.9, V1)).toBe('high');
  });

  it('treats ordinary city traffic as medium', () => {
    expect(visibilityOf(15, V1)).toBe('medium');
    expect(visibilityOf(34.9, V1)).toBe('medium');
  });

  it('treats a fly-by as low visibility', () => {
    expect(visibilityOf(35, V1)).toBe('low');
    expect(visibilityOf(80, V1)).toBe('low');
  });
});

describe('what is not a drive', () => {
  it('derives speed from distance and duration, never from a claimed speed', () => {
    // 167 m in 30 s is 20 km/h — the same pair the impression tests use.
    expect(observedKmh(0.167, 30)).toBeCloseTo(20.04, 1);
  });

  it('drops a pair that did not move', () => {
    expect(classifies(0, 30, V1)).toBe(false);
    expect(bandOf(0, 30, V1)).toBeNull();
  });

  it('drops a night in a depot rather than calling it high visibility', () => {
    expect(classifies(0.0004, 8 * 3600, V1)).toBe(false);
    expect(bandOf(0.0004, 8 * 3600, V1)).toBeNull();
  });

  it('still bands a genuine crawl of a few hundred metres', () => {
    expect(bandOf(0.2, 90, V1)).toBe('high');
  });
});
