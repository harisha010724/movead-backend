import {
  formatCount,
  formatInr,
  formatIstDate,
  formatIstDateTime,
  formatKm,
  formatShare,
  htmlEscape,
  sha256,
} from './reports.format';

import type { Money } from '../../pricing/money';

export interface ProofZone {
  zone: string;
  verifiedKm: number;
  charge: Money;
  impressions: number;
}

export interface ProofDayWorking {
  date: string;
  verifiedKm: number;
  impressions: number;
  charge: Money;
  jamDensity: number;
  occupantsPerVehicle: number;
  lineOfSightShare: number;
  wrapQuality: number;
  medianObservedKmh: number | null;
  medianBaselineKmh: number | null;
}

export interface ProofPackInput {
  generatedAt: string;
  campaign: {
    id: string;
    name: string;
    brandName: string;
    city: string;
    vehicleType: string;
    status: string;
    startDate: string;
    endDate: string;
    budget: Money;
    spent: Money;
  };
  advertiser: { legalName: string; brandName: string };
  period: { from: string; to: string };
  cover: {
    verifiedKm: number;
    charged: Money;
    vehicles: number;
    firstDriven: string | null;
    lastDriven: string | null;
  };
  zones: ProofZone[];
  visibility: {
    version: string;
    highKm: number;
    mediumKm: number;
    lowKm: number;
    classifiedKm: number;
    highShare: number;
    bands: { high: string; medium: string; low: string };
    when: {
      morningKm: number;
      middayKm: number;
      eveningKm: number;
      nightKm: number;
      peakShare: number;
      windows: { morning: string; midday: string; evening: string; night: string };
    };
  };
  impressions: {
    modelVersion: string;
    impressions: number;
    cpm: Money;
    charge: Money;
    baselineMix: { cellHour: number; cell: number; zoneDefault: number };
  };
  sampleDays: ProofDayWorking[];
}

function zoneLabel(zone: string): string {
  if (zone === 'prime') return 'Prime';
  if (zone === 'secondary') return 'Secondary';
  return 'Network';
}

function figuresHash(input: ProofPackInput): string {
  return sha256(
    JSON.stringify({
      campaignId: input.campaign.id,
      period: input.period,
      cover: input.cover,
      zones: input.zones,
      visibility: {
        version: input.visibility.version,
        highKm: input.visibility.highKm,
        mediumKm: input.visibility.mediumKm,
        lowKm: input.visibility.lowKm,
        highShare: input.visibility.highShare,
      },
      impressions: input.impressions,
    }),
  );
}

/**
 * A dated, print-ready proof pack. Open in a browser and print to PDF.
 *
 * HTML rather than a generated PDF so the numbers stay inspectable — view
 * source is the working — and so we do not depend on a renderer that would
 * have to be kept in step with every copy change.
 */
export function proofPackHtml(input: ProofPackInput): string {
  const hash = figuresHash(input);
  const e = htmlEscape;
  const period = `${formatIstDate(input.period.from)} – ${formatIstDate(input.period.to)}`;
  const driven =
    input.cover.firstDriven && input.cover.lastDriven
      ? `${formatIstDate(input.cover.firstDriven)} – ${formatIstDate(input.cover.lastDriven)}`
      : 'No billable driving in this period';

  const zoneRows = input.zones
    .map(
      (row) => `<tr>
        <td>${e(zoneLabel(row.zone))}</td>
        <td class="num">${e(formatKm(row.verifiedKm))}</td>
        <td class="num">${e(formatInr(row.charge))}</td>
        <td class="num">${e(formatCount(row.impressions))}</td>
      </tr>`,
    )
    .join('');

  const sample = input.sampleDays
    .map((day) => {
      const gap =
        day.medianObservedKmh != null && day.medianBaselineKmh != null
          ? `${day.medianBaselineKmh.toFixed(1)} − ${day.medianObservedKmh.toFixed(1)} km/h`
          : '—';
      return `<section class="card">
        <h3>${e(formatIstDate(day.date))}</h3>
        <dl>
          <div><dt>Verified distance</dt><dd>${e(formatKm(day.verifiedKm))}</dd></div>
          <div><dt>Charged</dt><dd>${e(formatInr(day.charge))}</dd></div>
          <div><dt>Modelled impressions</dt><dd>${e(formatCount(day.impressions))}</dd></div>
          <div><dt>Median observed</dt><dd>${day.medianObservedKmh == null ? '—' : `${day.medianObservedKmh.toFixed(1)} km/h`}</dd></div>
          <div><dt>Median baseline</dt><dd>${day.medianBaselineKmh == null ? '—' : `${day.medianBaselineKmh.toFixed(1)} km/h`}</dd></div>
          <div><dt>Congestion gap</dt><dd>${e(gap)}</dd></div>
        </dl>
        <p class="note">Coefficients on this day: jam density ${day.jamDensity}, occupants ${day.occupantsPerVehicle}, line of sight ${day.lineOfSightShare}, wrap quality ${day.wrapQuality}. Density is read from observed versus baseline speed. These do not change the charge.</p>
      </section>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>MoveAd campaign proof pack — ${e(input.campaign.name)}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 13px/1.5 "Segoe UI", system-ui, sans-serif; color: #0f172a; background: #f8fafc; }
    main { max-width: 840px; margin: 0 auto; padding: 32px 24px 64px; }
    header.cover { background: #0f172a; color: #fff; padding: 32px; border-radius: 16px; }
    header.cover p { margin: 0 0 6px; color: #94a3b8; letter-spacing: 0.08em; text-transform: uppercase; font-size: 11px; }
    header.cover h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.2; }
    header.cover .brand { font-size: 16px; color: #e2e8f0; }
    .kpis { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 24px; }
    .kpi { background: rgba(255,255,255,0.06); border-radius: 10px; padding: 12px 14px; }
    .kpi span { display: block; color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
    .kpi strong { display: block; margin-top: 4px; font-size: 20px; }
    h2 { margin: 36px 0 10px; font-size: 18px; }
    p.lede { color: #475569; margin: 0 0 16px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; background: #f1f5f9; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    .card { background: #fff; border-radius: 12px; padding: 16px 18px; margin: 12px 0; border: 1px solid #e2e8f0; }
    .card h3 { margin: 0 0 10px; }
    dl { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 0; }
    dt { color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
    dd { margin: 2px 0 0; font-weight: 600; }
    .note { color: #64748b; font-size: 12px; }
    footer { margin-top: 36px; padding-top: 16px; border-top: 1px solid #cbd5e1; color: #64748b; font-size: 12px; }
    footer code { font-size: 11px; word-break: break-all; }
    @media print {
      body { background: #fff; }
      main { padding: 0; }
      header.cover { break-after: avoid; }
      .card, table { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <main>
    <header class="cover">
      <p>MoveAd campaign proof pack</p>
      <h1>${e(input.campaign.name)}</h1>
      <div class="brand">${e(input.advertiser.legalName)} · ${e(input.campaign.brandName)} · ${e(input.campaign.city)}</div>
      <div class="kpis">
        <div class="kpi"><span>Period</span><strong>${e(period)}</strong></div>
        <div class="kpi"><span>Verified distance</span><strong>${e(formatKm(input.cover.verifiedKm))}</strong></div>
        <div class="kpi"><span>Charged</span><strong>${e(formatInr(input.cover.charged))}</strong></div>
        <div class="kpi"><span>Vehicles that drove</span><strong>${e(formatCount(input.cover.vehicles))}</strong></div>
      </div>
    </header>

    <h2>What this document is</h2>
    <p class="lede">
      A dated record of one campaign for one period. Verified kilometres are GPS-provable
      and are what you were billed on. Modelled impressions are the media translation of
      that driving — they do not change the charge. Wallet top-ups are not part of this pack.
    </p>
    <section class="card">
      <dl>
        <div><dt>Campaign dates</dt><dd>${e(formatIstDate(input.campaign.startDate))} – ${e(formatIstDate(input.campaign.endDate))}</dd></div>
        <div><dt>Status</dt><dd>${e(input.campaign.status)}</dd></div>
        <div><dt>Vehicle type</dt><dd>${e(input.campaign.vehicleType)}</dd></div>
        <div><dt>Budget</dt><dd>${e(formatInr(input.campaign.budget))}</dd></div>
        <div><dt>Lifetime charged</dt><dd>${e(formatInr(input.campaign.spent))}</dd></div>
        <div><dt>Days driven in period</dt><dd>${e(driven)}</dd></div>
      </dl>
    </section>

    <h2>Zone mix</h2>
    <p class="lede">Billable kilometres at the rate in force when they were driven.</p>
    <table>
      <thead><tr><th>Zone</th><th class="num">Verified km</th><th class="num">Charged</th><th class="num">Modelled impressions</th></tr></thead>
      <tbody>${zoneRows || '<tr><td colspan="4">No billable kilometres in this period.</td></tr>'}</tbody>
    </table>

    <h2>Readability and visibility</h2>
    <p class="lede">
      Speed of the same GPS that billed the kilometres. High is slower than ${e(input.visibility.bands.high.replace('<', ''))}.
      Parked stretches are omitted. Version ${e(input.visibility.version)}.
    </p>
    <section class="card">
      <dl>
        <div><dt>Readable while moving</dt><dd>${e(formatShare(input.visibility.highShare))}</dd></div>
        <div><dt>High ${e(input.visibility.bands.high)}</dt><dd>${e(formatKm(input.visibility.highKm))}</dd></div>
        <div><dt>Medium ${e(input.visibility.bands.medium)}</dt><dd>${e(formatKm(input.visibility.mediumKm))}</dd></div>
        <div><dt>Low ${e(input.visibility.bands.low)}</dt><dd>${e(formatKm(input.visibility.lowKm))}</dd></div>
        <div><dt>Morning ${e(input.visibility.when.windows.morning)}</dt><dd>${e(formatKm(input.visibility.when.morningKm))}</dd></div>
        <div><dt>Midday ${e(input.visibility.when.windows.midday)}</dt><dd>${e(formatKm(input.visibility.when.middayKm))}</dd></div>
        <div><dt>Evening ${e(input.visibility.when.windows.evening)}</dt><dd>${e(formatKm(input.visibility.when.eveningKm))}</dd></div>
        <div><dt>Night ${e(input.visibility.when.windows.night)}</dt><dd>${e(formatKm(input.visibility.when.nightKm))}</dd></div>
      </dl>
      <p class="note">Peak (morning + evening) is ${e(formatShare(input.visibility.when.peakShare))} of readable kilometres.</p>
    </section>

    <h2>Modelled impressions</h2>
    <p class="lede">
      Appendix — not an invoice line. Model ${e(input.impressions.modelVersion)}.
      Cost per thousand is charged ÷ impressions × 1,000.
    </p>
    <section class="card">
      <dl>
        <div><dt>Impressions</dt><dd>${e(formatCount(input.impressions.impressions))}</dd></div>
        <div><dt>Charged (same km)</dt><dd>${e(formatInr(input.impressions.charge))}</dd></div>
        <div><dt>Cost per 1,000</dt><dd>${e(formatInr(input.impressions.cpm))}</dd></div>
        <div><dt>Cell + hour</dt><dd>${e(formatShare(input.impressions.baselineMix.cellHour))}</dd></div>
        <div><dt>Cell</dt><dd>${e(formatShare(input.impressions.baselineMix.cell))}</dd></div>
        <div><dt>Zone default</dt><dd>${e(formatShare(input.impressions.baselineMix.zoneDefault))}</dd></div>
      </dl>
      <p class="note">Baseline mix is how much of the audience rests on the fleet measuring these roads, versus a flat zone assumption.</p>
    </section>

    <h2>Sample-day workings</h2>
    <p class="lede">The busiest days in the period, with the coefficients the model multiplied. Empty when nothing was billed.</p>
    ${sample || '<section class="card"><p class="note">No sample days — nothing billable was driven in this period.</p></section>'}

    <footer>
      <p>Generated ${e(formatIstDateTime(input.generatedAt))} (Asia/Kolkata). Campaign ${e(input.campaign.id)}.</p>
      <p>Figures checksum (SHA-256): <code>${e(hash)}</code></p>
      <p>Print this page to save a PDF. The checksum covers the figures, not the styling. Re-generating the same period from the same billed kilometres produces the same hash.</p>
    </footer>
  </main>
</body>
</html>`;
}
