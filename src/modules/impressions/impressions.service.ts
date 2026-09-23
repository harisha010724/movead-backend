import { sequelize } from '../../db/sequelize';
import { CURRENT_MODEL_VERSION, coefficientsFor } from '../../impressions/coefficients';
import { impressionsFor } from '../../impressions/model';
import { money, toPayable, type Money } from '../../pricing/money';
import { gridKeySql } from '../../shared/geo';
import { loggerFor } from '../../shared/logger';
import { IST, istDate, istHourOfWeek } from '../../shared/time';
import { loadBaselines, type BaselineSource } from '../traffic/traffic.service';

import { SegmentImpression } from './impressions.model';

import type { SegmentZone } from '../tracking/tracking.model';

/**
 * Turning priced kilometres into a reportable audience.
 *
 * There is one code path and it is the backfill. A segment gets its
 * impressions because it does not have any yet, never because something
 * noticed it arriving — which means the live path and the "we shipped a new
 * model version" path are the same code, exercised constantly, rather than a
 * recompute script that is written once and has rotted by the time it is
 * needed.
 *
 * That also makes the job safe to run at any moment and safe to run twice,
 * both of which the queue requires. It computes what is missing; if nothing is
 * missing it does nothing.
 *
 * A figure is never revised in place, and that is a decision rather than an
 * omission. Baselines improve every night, so yesterday's segments could
 * always be re-expressed against a better measurement of the road — but an
 * advertiser who read a number on Monday and a different one on Tuesday, for
 * driving that finished on Sunday, has been given a reason to distrust both.
 * Each row records the baseline it used and which rung of the ladder that came
 * from, so a thin early figure can be recognised as one. Re-expressing history
 * against better data is a new model version: a deliberate, visible act that
 * leaves the old numbers standing beside the new ones.
 */

const log = loggerFor('impressions');

/**
 * Segments per round trip.
 *
 * Large enough that a day's driving is a handful of queries, small enough that
 * a first run over a long backlog does not pull the whole table into memory.
 */
const BATCH_SIZE = 2_000;

interface PendingSegment {
  id: string;
  zone: SegmentZone;
  distance_km: number;
  seconds: number;
  grid_key: string;
  hour_of_week: number;
  hour_of_day: number;
}

/**
 * Billable segments with no figure at this version yet.
 *
 * Only billable ones: an impression is a claim about an advertisement someone
 * was charged for, so a kilometre the platform declined to bill is not one it
 * should be reporting an audience for. Held and non-billable segments keep
 * their distance and their reason, and get no audience.
 */
const PENDING = `
  SELECT s.id,
         s.zone,
         s.distance_km::float8                                   AS distance_km,
         EXTRACT(EPOCH FROM (s.ended_at - s.started_at))::float8  AS seconds,
         ${gridKeySql('p.lat', 'p.lon')}                          AS grid_key,
         ${istHourOfWeek('s.started_at')}                         AS hour_of_week,
         EXTRACT(HOUR FROM s.started_at AT TIME ZONE :zone)::int  AS hour_of_day
    FROM trip_segments s
    JOIN gps_points p ON p.id = s.from_point_id
    LEFT JOIN segment_impressions si
           ON si.segment_id = s.id
          AND si.model_version = :version
   WHERE s.state = 'BILLABLE'
     AND s.distance_km > 0
     AND s.ended_at > s.started_at
     AND si.segment_id IS NULL
   ORDER BY s.started_at
   LIMIT :limit
`;

export interface ComputeResult {
  version: string;
  computed: number;
}

/**
 * Give every billable segment an audience under `version`.
 *
 * The speed the model reads is derived from the segment's own distance and
 * duration rather than from `speed_mps`, which is the same choice the pipeline
 * makes when it checks for implausible movement, and for the same reason: the
 * handset's claim about its speed is as forgeable as its claim about its
 * position. Two parts of the system reasoning about one second of driving have
 * to agree about how fast it was.
 */
export async function computeMissing(
  version: string = CURRENT_MODEL_VERSION,
): Promise<ComputeResult> {
  const coefficients = coefficientsFor(version);
  let computed = 0;

  for (;;) {
    const pending = (await sequelize.query(PENDING, {
      replacements: { zone: IST, version, limit: BATCH_SIZE },
      type: 'SELECT',
    })) as PendingSegment[];

    if (pending.length === 0) break;

    const baselines = await loadBaselines(pending.map((segment) => segment.grid_key));

    const rows = pending.map((segment) => {
      const observedKmh = segment.distance_km / (segment.seconds / 3600);
      const baseline = baselines.for(segment.grid_key, segment.hour_of_week, segment.zone);

      const breakdown = impressionsFor(
        {
          distanceKm: segment.distance_km,
          observedKmh,
          baselineKmh: baseline.freeFlowKmh,
          hourOfDay: segment.hour_of_day,
          zone: segment.zone,
        },
        coefficients,
      );

      return {
        segmentId: segment.id,
        modelVersion: version,
        impressions: breakdown.impressions.toFixed(4),
        vehiclesPerKm: breakdown.vehiclesPerKm.toFixed(2),
        inVehiclePersonsKm: breakdown.inVehiclePersonsPerKm.toFixed(2),
        pedestrianDensity: breakdown.pedestrianDensity.toFixed(2),
        personsPresentKm: breakdown.personsPresentPerKm.toFixed(2),
        lineOfSightShare: breakdown.lineOfSightShare.toFixed(4),
        wrapQuality: breakdown.wrapQuality.toFixed(4),
        daypartFactor: breakdown.daypartFactor.toFixed(4),
        observedKmh: observedKmh.toFixed(2),
        baselineKmh: baseline.freeFlowKmh.toFixed(2),
        baselineSource: baseline.source,
      };
    });

    // A concurrent run that got there first is not an error — the row it wrote
    // is the row this one would have written, because the model is a pure
    // function of the segment and the version.
    await SegmentImpression.bulkCreate(rows, { ignoreDuplicates: true });
    computed += rows.length;

    if (pending.length < BATCH_SIZE) break;
  }

  if (computed > 0) log.info({ version, computed }, 'impressions computed');
  return { version, computed };
}

// --- Reading it back, for the advertiser ---------------------------------

export type ApiZone = 'prime' | 'secondary' | 'network';

const API_ZONE: Record<SegmentZone, ApiZone> = {
  PRIME: 'prime',
  SECONDARY: 'secondary',
  NETWORK: 'network',
};

export interface ZoneImpressions {
  zone: ApiZone;
  verifiedKm: number;
  impressions: number;
  charge: Money;
}

export interface DayImpressions {
  date: string;
  verifiedKm: number;
  impressions: number;
}

/**
 * How much of a reported audience rests on measurement rather than on an
 * assumption, as shares of the impressions summing to one.
 *
 * Published rather than kept internal, because it is the difference between
 * this and every competitor's number. An advertiser told 2.4 million
 * impressions learns nothing about how much to trust it; one told that 78% of
 * them rest on the hour-by-hour measurement of those specific roads, and 6% on
 * a zone-wide default, can price the claim.
 */
export interface BaselineMix {
  cellHour: number;
  cell: number;
  zoneDefault: number;
}

interface RollupRow {
  zone: SegmentZone;
  day: string;
  baseline_source: BaselineSource;
  km: string;
  charge: string;
  impressions: string;
}

/**
 * One grouped pass, from which the totals, the zone split, the daily series
 * and the evidence mix are all derived.
 *
 * Grouped finely and folded in Node rather than asked four times, for the
 * reason `totalsFor` gives about the same choice in tracking: four queries is
 * how two panels on one screen end up disagreeing about the same day.
 */
const ROLLUP = `
  SELECT s.zone,
         ${istDate('s.started_at')}::text  AS day,
         si.baseline_source,
         SUM(s.distance_km)                AS km,
         SUM(s.advertiser_charge)          AS charge,
         SUM(si.impressions)               AS impressions
    FROM trip_segments s
    JOIN segment_impressions si
      ON si.segment_id = s.id
     AND si.model_version = :version
   WHERE s.campaign_id = :campaignId
     AND s.state = 'BILLABLE'
     AND (:date::date IS NULL OR ${istDate('s.started_at')} = :date::date)
   GROUP BY s.zone, day, si.baseline_source
   ORDER BY day
`;

/**
 * What a thousand of these impressions cost.
 *
 * The one figure a media buyer can carry to another channel and compare, and
 * therefore the one worth computing centrally rather than leaving each screen
 * to divide for itself. At payable scale because it is a rate someone quotes,
 * not an amount anyone is owed.
 */
export function cpmOf(charge: Money, impressions: number): Money {
  if (impressions <= 0) return toPayable(money(0));
  return toPayable(money(charge).div(money(impressions).div(1000)));
}

export interface ImpressionTotals {
  modelVersion: string;
  verifiedKm: number;
  impressions: number;
  charge: Money;
  cpm: Money;
  byZone: ZoneImpressions[];
  byDay: DayImpressions[];
  baselineMix: BaselineMix;
}

const round1 = (value: number): number => Number(value.toFixed(1));

/** Ordered as the rate card is, rather than by whichever zone happened to be driven. */
const ZONE_ORDER: ApiZone[] = ['prime', 'secondary', 'network'];

async function rollup(
  campaignId: string,
  date: string | null,
  version: string,
): Promise<ImpressionTotals> {
  const rows = (await sequelize.query(ROLLUP, {
    replacements: { zone: IST, campaignId, version, date },
    type: 'SELECT',
  })) as RollupRow[];

  const zones = new Map<ApiZone, { km: number; impressions: number; charge: Money }>();
  const days = new Map<string, { km: number; impressions: number }>();
  const sources = new Map<BaselineSource, number>();

  let totalKm = 0;
  let totalImpressions = 0;
  let totalCharge = money(0);

  for (const row of rows) {
    const km = Number(row.km);
    const impressions = Number(row.impressions);
    const zone = API_ZONE[row.zone];

    totalKm += km;
    totalImpressions += impressions;
    totalCharge = totalCharge.plus(money(row.charge));

    const inZone = zones.get(zone) ?? { km: 0, impressions: 0, charge: '0.0000' };
    zones.set(zone, {
      km: inZone.km + km,
      impressions: inZone.impressions + impressions,
      charge: money(inZone.charge).plus(money(row.charge)).toFixed(4),
    });

    const onDay = days.get(row.day) ?? { km: 0, impressions: 0 };
    days.set(row.day, { km: onDay.km + km, impressions: onDay.impressions + impressions });

    sources.set(row.baseline_source, (sources.get(row.baseline_source) ?? 0) + impressions);
  }

  const share = (source: BaselineSource): number =>
    totalImpressions > 0 ? Number(((sources.get(source) ?? 0) / totalImpressions).toFixed(4)) : 0;

  const charge = totalCharge.toFixed(4);

  return {
    modelVersion: version,
    verifiedKm: round1(totalKm),
    impressions: Math.round(totalImpressions),
    charge,
    cpm: cpmOf(charge, totalImpressions),
    byZone: ZONE_ORDER.filter((zone) => zones.has(zone)).map((zone) => {
      const found = zones.get(zone) as { km: number; impressions: number; charge: Money };
      return {
        zone,
        verifiedKm: round1(found.km),
        impressions: Math.round(found.impressions),
        charge: found.charge,
      };
    }),
    byDay: [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, found]) => ({
        date,
        verifiedKm: round1(found.km),
        impressions: Math.round(found.impressions),
      })),
    baselineMix: {
      cellHour: share('CELL_HOUR'),
      cell: share('CELL'),
      zoneDefault: share('ZONE_DEFAULT'),
    },
  };
}

export interface CampaignImpressions extends ImpressionTotals {
  campaignId: string;
  campaignName: string;
}

/**
 * A campaign's whole run, as an audience.
 *
 * Carries no driver identity and no driver earning — not by filtering them out
 * of a wider query, but by never selecting them. The admin audit view is
 * behind `trip.audit` precisely because it exposes both sides of the money,
 * and the advertiser-facing mirror of it has to be built so that the other
 * side cannot reappear through a later edit.
 */
export async function forCampaign(
  campaign: { id: string; name: string },
  version: string = CURRENT_MODEL_VERSION,
): Promise<CampaignImpressions> {
  coefficientsFor(version);

  return {
    campaignId: campaign.id,
    campaignName: campaign.name,
    ...(await rollup(campaign.id, null, version)),
  };
}

export interface ImpressionWorking {
  jamDensity: number;
  occupantsPerVehicle: number;
  lineOfSightShare: number;
  wrapQuality: number;
  zones: { zone: ApiZone; lanes: number; pedestrianDensity: number }[];
  medianObservedKmh: number | null;
  medianBaselineKmh: number | null;
}

export interface CampaignDayImpressions extends ImpressionTotals {
  campaignId: string;
  date: string;
  working: ImpressionWorking;
}

/**
 * One day, with the model's working shown.
 *
 * This is the "how was this calculated" panel: every coefficient that was
 * multiplied, and the two speeds the density was read from. An advertiser who
 * cannot see these has been handed a number; one who can has been handed an
 * argument they are able to check.
 */
export async function forCampaignDay(
  campaignId: string,
  date: string,
  version: string = CURRENT_MODEL_VERSION,
): Promise<CampaignDayImpressions> {
  const coefficients = coefficientsFor(version);
  const totals = await rollup(campaignId, date, version);

  const [speeds] = (await sequelize.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY si.observed_kmh) AS observed,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY si.baseline_kmh) AS baseline
       FROM trip_segments s
       JOIN segment_impressions si
         ON si.segment_id = s.id
        AND si.model_version = :version
      WHERE s.campaign_id = :campaignId
        AND s.state = 'BILLABLE'
        AND ${istDate('s.started_at')} = :date::date`,
    { replacements: { zone: IST, campaignId, version, date }, type: 'SELECT' },
  )) as { observed: string | null; baseline: string | null }[];

  return {
    campaignId,
    date,
    ...totals,
    working: {
      jamDensity: coefficients.jamDensity,
      occupantsPerVehicle: coefficients.occupantsPerVehicle,
      lineOfSightShare: coefficients.lineOfSightShare,
      wrapQuality: coefficients.wrapQuality,
      zones: ZONE_ORDER.map((zone) => {
        const assumptions =
          coefficients.zones[
            zone.toUpperCase() as keyof typeof coefficients.zones
          ];
        return {
          zone,
          lanes: assumptions.lanes,
          pedestrianDensity: assumptions.pedestrianDensity,
        };
      }),
      medianObservedKmh: speeds?.observed == null ? null : Number(speeds.observed),
      medianBaselineKmh: speeds?.baseline == null ? null : Number(speeds.baseline),
    },
  };
}
