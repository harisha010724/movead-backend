import { describe, expect, it } from 'vitest';

import {
  CURRENT_DAYPART_VERSION,
  daypartCutoffsFor,
  daypartOf,
  knownDaypartVersions,
  publishedDayparts,
} from '../src/visibility/dayparts';

/**
 * Clock bands on kilometres that were already slow enough to read.
 *
 * Night does not mean "no one saw it" and morning does not mean impressions.
 * What is tested here is the window, so a crawl at 21:00 cannot quietly
 * become evening when the hours move.
 */

describe('the published dayparts', () => {
  it('names the version new work is classified under', () => {
    expect(CURRENT_DAYPART_VERSION).toBe('v1.0.0');
    expect(knownDaypartVersions()).toEqual(['v1.0.0']);
  });

  it('writes the IST windows out so a screen can show them', () => {
    expect(publishedDayparts()).toEqual({
      morning: '07:00–11:00 IST',
      midday: '11:00–17:00 IST',
      evening: '17:00–21:00 IST',
      night: '21:00–07:00 IST',
    });
  });

  it('refuses a version it does not know rather than quietly using today\'s', () => {
    expect(() => daypartCutoffsFor('v9.9.9')).toThrow(/unknown daypart version/i);
  });
});

describe('banding an IST hour', () => {
  it('treats the morning commute as morning', () => {
    expect(daypartOf(7)).toBe('morning');
    expect(daypartOf(10)).toBe('morning');
  });

  it('treats the open city as midday', () => {
    expect(daypartOf(11)).toBe('midday');
    expect(daypartOf(16)).toBe('midday');
  });

  it('treats the evening peak as evening', () => {
    expect(daypartOf(17)).toBe('evening');
    expect(daypartOf(20)).toBe('evening');
  });

  it('treats late evening and the small hours as night', () => {
    expect(daypartOf(21)).toBe('night');
    expect(daypartOf(23)).toBe('night');
    expect(daypartOf(0)).toBe('night');
    expect(daypartOf(6)).toBe('night');
  });
});
