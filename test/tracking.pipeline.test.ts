import { describe, expect, it } from 'vitest';

import { driverRatesFrom } from '../src/pricing/rateCards';
import { buildSegments, type PipelineFix } from '../src/modules/tracking/tracking.pipeline';

function fix(id: string, at: string, lat: number, lon: number): PipelineFix {
  return {
    id,
    recordedAt: new Date(at),
    lat,
    lon,
    accuracyM: 8,
    isMock: false,
    quality: 'ELIGIBLE',
  };
}

describe('buildSegments rates', () => {
  it('prices leftover geography at the campaign snapshot, not the platform default', () => {
    const advertiser = { prime: '4.0000', secondary: '1.5000', network: '0.8000' };
    const segments = buildSegments({
      fixes: [
        fix('a', '2026-09-01T08:00:00Z', 12.97, 77.6),
        fix('b', '2026-09-01T08:00:20Z', 12.971, 77.6),
      ],
      polygons: {},
      billable: true,
      notBillableReason: null,
      rates: { advertiser, driver: driverRatesFrom(advertiser) },
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]?.zone).toBe('NETWORK');
    expect(segments[0]?.advertiserRate).toBe('0.8000');
    expect(segments[0]?.driverRate).toBe('0.4800');
  });
});
