import { describe, expect, it } from 'vitest';

import { anonymisePlate, csvEscape, toCsv } from '../src/modules/reports/reports.format';
import { proofPackHtml, type ProofPackInput } from '../src/modules/reports/reports.proof';

describe('report formatting', () => {
  it('anonymises a plate to the last four characters', () => {
    expect(anonymisePlate('KA01AB1234')).toBe('••••1234');
    expect(anonymisePlate('KA 01 AB 1234')).toBe('••••1234');
  });

  it('quotes CSV fields that contain a comma', () => {
    expect(csvEscape('Summer Sale, Bengaluru')).toBe('"Summer Sale, Bengaluru"');
  });

  it('writes a trailing newline so a spreadsheet opens the last row', () => {
    expect(toCsv(['zone', 'km'], [['prime', 12.5]])).toBe('zone,km\r\nprime,12.5\r\n');
  });
});

describe('the proof pack', () => {
  const input: ProofPackInput = {
    generatedAt: '2026-10-01T07:30:00.000Z',
    campaign: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Summer Sale',
      brandName: 'Zephyr',
      city: 'Bengaluru',
      vehicleType: 'CAB',
      status: 'ACTIVE',
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      budget: '50000.0000',
      spent: '1284.5000',
    },
    advertiser: { legalName: 'Zephyr Beverages Private Limited', brandName: 'Zephyr' },
    period: { from: '2026-09-01', to: '2026-09-30' },
    cover: {
      verifiedKm: 214.5,
      charged: '1284.5000',
      vehicles: 3,
      firstDriven: '2026-09-02',
      lastDriven: '2026-09-29',
    },
    zones: [
      { zone: 'prime', verifiedKm: 40.0, charge: '200.0000', impressions: 12000 },
      { zone: 'secondary', verifiedKm: 174.5, charge: '1084.5000', impressions: 18000 },
    ],
    visibility: {
      version: 'v1.0.0',
      highKm: 80,
      mediumKm: 90,
      lowKm: 44.5,
      classifiedKm: 214.5,
      highShare: 0.373,
      bands: { high: '<15 km/h', medium: '15–35 km/h', low: '>35 km/h' },
      when: {
        morningKm: 40,
        middayKm: 50,
        eveningKm: 60,
        nightKm: 20,
        peakShare: 0.5882,
        windows: {
          morning: '07:00–11:00',
          midday: '11:00–17:00',
          evening: '17:00–21:00',
          night: '21:00–07:00',
        },
      },
    },
    impressions: {
      modelVersion: 'v1.0.0',
      impressions: 30000,
      cpm: '42.82',
      charge: '1284.5000',
      baselineMix: { cellHour: 0.7, cell: 0.2, zoneDefault: 0.1 },
    },
    sampleDays: [
      {
        date: '2026-09-12',
        verifiedKm: 32.1,
        impressions: 4100,
        charge: '180.0000',
        jamDensity: 150,
        occupantsPerVehicle: 1.5,
        lineOfSightShare: 0.35,
        wrapQuality: 0.85,
        medianObservedKmh: 14.2,
        medianBaselineKmh: 34,
      },
    ],
  };

  it('names the campaign and says impressions are not the invoice', () => {
    const html = proofPackHtml(input);

    expect(html).toContain('Summer Sale');
    expect(html).toContain('Zephyr Beverages Private Limited');
    expect(html).toContain('they do not change the charge');
    expect(html).toContain('v1.0.0');
    expect(html).toMatch(/Figures checksum \(SHA-256\): <code>[a-f0-9]{64}<\/code>/);
  });
});
