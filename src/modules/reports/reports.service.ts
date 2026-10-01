import { randomUUID } from 'node:crypto';

import { QueryTypes } from 'sequelize';

import { Advertiser } from '../advertisers/advertisers.model';
import { Campaign } from '../campaigns/campaigns.model';
import { cpmOf, computeMissing, forCampaignDay } from '../impressions/impressions.service';
import { objectStore } from '../storage';
import { money, toLedger, type Money } from '../../pricing/money';
import { sequelize } from '../../db/sequelize';
import { BadRequestError, NotFoundError, UnprocessableError } from '../../shared/errors';
import { IST, istDate } from '../../shared/time';
import { CURRENT_MODEL_VERSION } from '../../impressions/coefficients';
import {
  bandOf,
  CURRENT_VISIBILITY_VERSION,
  cutoffsFor,
  publishedBands,
  type VisibilityBand,
} from '../../visibility/bands';
import {
  CURRENT_DAYPART_VERSION,
  daypartOf,
  publishedDayparts,
  type Daypart,
} from '../../visibility/dayparts';

import { anonymisePlate, fileNameFor, payableOf, sha256, toCsv } from './reports.format';
import { proofPackHtml } from './reports.proof';
import { ReportExport, type ReportFormat, type ReportType } from './reports.model';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;
const MAX_DETAIL_ROWS = 50_000;
const SAMPLE_DAYS = 3;
const ZONE_ORDER = ['prime', 'secondary', 'network'] as const;

const API_ZONE = { PRIME: 'prime', SECONDARY: 'secondary', NETWORK: 'network' } as const;

export interface DateRange {
  from: string;
  to: string;
}

export interface ReportExportView {
  id: string;
  type: ReportType;
  format: ReportFormat;
  campaignId: string;
  campaignName: string;
  from: string;
  to: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  checksum: string;
  generatedAt: string;
  expiresAt: string;
  status: 'ready';
}

export interface StoredReport {
  bytes: Buffer;
  contentType: string;
  fileName: string;
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00+05:30`);
  const end = Date.parse(`${to}T00:00:00+05:30`);
  return Math.round((end - start) / 86_400_000) + 1;
}

function assertRange(range: DateRange): void {
  if (range.from > range.to) {
    throw new BadRequestError('The period must end on or after the day it starts.');
  }
  if (daysBetween(range.from, range.to) > MAX_RANGE_DAYS) {
    throw new BadRequestError(`Choose a period of ${String(MAX_RANGE_DAYS)} days or fewer.`);
  }
}

async function loadOwned(advertiserId: string, campaignId: string): Promise<{
  campaign: Campaign;
  advertiser: Advertiser;
}> {
  const campaign = await Campaign.findOne({
    where: { id: campaignId, advertiserId },
    include: [{ model: Advertiser, as: 'advertiser' }],
  });
  if (!campaign) throw new NotFoundError('Campaign');
  const advertiser = campaign.advertiser;
  if (!advertiser) {
    const found = await Advertiser.findByPk(advertiserId);
    if (!found) throw new NotFoundError('Campaign');
    return { campaign, advertiser: found };
  }
  return { campaign, advertiser };
}

function toView(row: ReportExport, campaignName: string): ReportExportView {
  return {
    id: row.id,
    type: row.type,
    format: row.format,
    campaignId: row.campaignId,
    campaignName,
    from: String(row.fromDate).slice(0, 10),
    to: String(row.toDate).slice(0, 10),
    fileName: row.fileName,
    contentType: row.contentType,
    byteSize: row.byteSize,
    checksum: row.checksum,
    generatedAt: row.generatedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status: 'ready',
  };
}

const RANGE = `${istDate('s.started_at')} BETWEEN :from::date AND :to::date`;

interface ZoneRow {
  zone: 'PRIME' | 'SECONDARY' | 'NETWORK';
  km: string;
  charge: string;
  impressions: string;
}

interface MixRow {
  baseline_source: 'CELL_HOUR' | 'CELL' | 'ZONE_DEFAULT';
  impressions: string;
}

interface DayRow {
  day: string;
  km: string;
  charge: string;
  impressions: string;
}

interface CoverRow {
  km: string;
  charge: string;
  vehicles: string;
  first_driven: string | null;
  last_driven: string | null;
}

interface VehicleRow {
  registration_number: string;
  km: string;
  prime: string | null;
  secondary: string | null;
  network: string | null;
  charge: string;
  impressions: string;
}

interface DetailRow {
  started_at: Date | string;
  ended_at: Date | string;
  day: string;
  registration_number: string;
  zone: 'PRIME' | 'SECONDARY' | 'NETWORK';
  distance_km: string;
  advertiser_rate: string;
  advertiser_charge: string;
  impressions: string | null;
  baseline_source: string | null;
}

interface PairRow {
  from_point_id: string;
  pair_km: string;
  seconds: string;
  hour_ist: string;
}

interface PartRow {
  from_point_id: string;
  distance_km: string;
}

const round1 = (value: number): number => Number(value.toFixed(1));

async function coverOf(campaignId: string, range: DateRange): Promise<{
  verifiedKm: number;
  charged: Money;
  vehicles: number;
  firstDriven: string | null;
  lastDriven: string | null;
}> {
  const [row] = await sequelize.query<CoverRow>(
    `SELECT COALESCE(SUM(s.distance_km), 0) AS km,
            COALESCE(SUM(s.advertiser_charge), 0) AS charge,
            COUNT(DISTINCT s.vehicle_id)::text AS vehicles,
            MIN(${istDate('s.started_at')})::text AS first_driven,
            MAX(${istDate('s.started_at')})::text AS last_driven
       FROM trip_segments s
      WHERE s.campaign_id = :campaignId
        AND s.state = 'BILLABLE'
        AND ${RANGE}`,
    { replacements: { campaignId, from: range.from, to: range.to, zone: IST }, type: QueryTypes.SELECT },
  );

  return {
    verifiedKm: round1(Number(row?.km ?? 0)),
    charged: toLedger(money(row?.charge ?? 0)),
    vehicles: Number(row?.vehicles ?? 0),
    firstDriven: row?.first_driven ?? null,
    lastDriven: row?.last_driven ?? null,
  };
}

async function zonesOf(campaignId: string, range: DateRange, version: string): Promise<{
  rows: { zone: (typeof ZONE_ORDER)[number]; verifiedKm: number; charge: Money; impressions: number }[];
  mix: { cellHour: number; cell: number; zoneDefault: number };
  impressions: number;
  charge: Money;
  byDay: { date: string; verifiedKm: number; impressions: number; charge: Money }[];
}> {
  const [zones, mixRows, days] = await Promise.all([
    sequelize.query<ZoneRow>(
      `SELECT s.zone,
              COALESCE(SUM(s.distance_km), 0) AS km,
              COALESCE(SUM(s.advertiser_charge), 0) AS charge,
              COALESCE(SUM(si.impressions), 0) AS impressions
         FROM trip_segments s
         LEFT JOIN segment_impressions si
           ON si.segment_id = s.id AND si.model_version = :version
        WHERE s.campaign_id = :campaignId
          AND s.state = 'BILLABLE'
          AND ${RANGE}
        GROUP BY s.zone`,
      {
        replacements: { campaignId, from: range.from, to: range.to, zone: IST, version },
        type: QueryTypes.SELECT,
      },
    ),
    sequelize.query<MixRow>(
      `SELECT si.baseline_source, COALESCE(SUM(si.impressions), 0) AS impressions
         FROM trip_segments s
         JOIN segment_impressions si
           ON si.segment_id = s.id AND si.model_version = :version
        WHERE s.campaign_id = :campaignId
          AND s.state = 'BILLABLE'
          AND ${RANGE}
        GROUP BY si.baseline_source`,
      {
        replacements: { campaignId, from: range.from, to: range.to, zone: IST, version },
        type: QueryTypes.SELECT,
      },
    ),
    sequelize.query<DayRow>(
      `SELECT ${istDate('s.started_at')}::text AS day,
              COALESCE(SUM(s.distance_km), 0) AS km,
              COALESCE(SUM(s.advertiser_charge), 0) AS charge,
              COALESCE(SUM(si.impressions), 0) AS impressions
         FROM trip_segments s
         LEFT JOIN segment_impressions si
           ON si.segment_id = s.id AND si.model_version = :version
        WHERE s.campaign_id = :campaignId
          AND s.state = 'BILLABLE'
          AND ${RANGE}
        GROUP BY day
        ORDER BY day`,
      {
        replacements: { campaignId, from: range.from, to: range.to, zone: IST, version },
        type: QueryTypes.SELECT,
      },
    ),
  ]);

  const found = new Map(zones.map((row) => [API_ZONE[row.zone], row]));
  const rows = ZONE_ORDER.filter((zone) => found.has(zone)).map((zone) => {
    const row = found.get(zone) as ZoneRow;
    return {
      zone,
      verifiedKm: round1(Number(row.km)),
      charge: toLedger(money(row.charge)),
      impressions: Math.round(Number(row.impressions)),
    };
  });

  const totalImpressions = mixRows.reduce((sum, row) => sum + Number(row.impressions), 0);
  const share = (source: MixRow['baseline_source']): number => {
    const found = Number(mixRows.find((row) => row.baseline_source === source)?.impressions ?? 0);
    return totalImpressions > 0 ? Number((found / totalImpressions).toFixed(4)) : 0;
  };

  const charge = rows.reduce((sum, row) => sum.plus(money(row.charge)), money(0));

  return {
    rows,
    mix: {
      cellHour: Number(share('CELL_HOUR').toFixed(4)),
      cell: Number(share('CELL').toFixed(4)),
      zoneDefault: Number(share('ZONE_DEFAULT').toFixed(4)),
    },
    impressions: Math.round(totalImpressions || rows.reduce((sum, row) => sum + row.impressions, 0)),
    charge: toLedger(charge),
    byDay: days.map((row) => ({
      date: row.day,
      verifiedKm: round1(Number(row.km)),
      impressions: Math.round(Number(row.impressions)),
      charge: toLedger(money(row.charge)),
    })),
  };
}

async function visibilityOf(
  campaignId: string,
  range: DateRange,
  version: string = CURRENT_VISIBILITY_VERSION,
) {
  const cutoffs = cutoffsFor(version);
  const [pairs, parts] = await Promise.all([
    sequelize.query<PairRow>(
      `SELECT s.from_point_id,
              SUM(s.distance_km)::float8 AS pair_km,
              EXTRACT(EPOCH FROM (MAX(s.ended_at) - MIN(s.started_at)))::float8 AS seconds,
              EXTRACT(HOUR FROM MIN(s.started_at) AT TIME ZONE :zone)::int AS hour_ist
         FROM trip_segments s
        WHERE s.campaign_id = :campaignId
          AND s.state = 'BILLABLE'
          AND ${RANGE}
        GROUP BY s.from_point_id`,
      {
        replacements: { campaignId, from: range.from, to: range.to, zone: IST },
        type: QueryTypes.SELECT,
      },
    ),
    sequelize.query<PartRow>(
      `SELECT s.from_point_id, s.distance_km::float8 AS distance_km
         FROM trip_segments s
        WHERE s.campaign_id = :campaignId
          AND s.state = 'BILLABLE'
          AND ${RANGE}`,
      {
        replacements: { campaignId, from: range.from, to: range.to, zone: IST },
        type: QueryTypes.SELECT,
      },
    ),
  ]);

  const pairBand = new Map<string, VisibilityBand | null>();
  const pairDaypart = new Map<string, Daypart>();
  for (const pair of pairs) {
    pairBand.set(pair.from_point_id, bandOf(Number(pair.pair_km), Number(pair.seconds), cutoffs));
    pairDaypart.set(pair.from_point_id, daypartOf(Number(pair.hour_ist)));
  }

  const km: Record<VisibilityBand, number> = { high: 0, medium: 0, low: 0 };
  const whenKm: Record<Daypart, number> = { morning: 0, midday: 0, evening: 0, night: 0 };
  for (const part of parts) {
    const band = pairBand.get(part.from_point_id);
    if (!band) continue;
    km[band] += Number(part.distance_km);
    if (band === 'high' || band === 'medium') {
      const partOfDay = pairDaypart.get(part.from_point_id);
      if (partOfDay) whenKm[partOfDay] += Number(part.distance_km);
    }
  }

  const classifiedKm = km.high + km.medium + km.low;
  const readableKm = km.high + km.medium;
  const peakKm = whenKm.morning + whenKm.evening;

  return {
    version,
    highKm: round1(km.high),
    mediumKm: round1(km.medium),
    lowKm: round1(km.low),
    classifiedKm: round1(classifiedKm),
    highShare: classifiedKm > 0 ? Number((km.high / classifiedKm).toFixed(4)) : 0,
    bands: publishedBands(cutoffs),
    when: {
      version: CURRENT_DAYPART_VERSION,
      morningKm: round1(whenKm.morning),
      middayKm: round1(whenKm.midday),
      eveningKm: round1(whenKm.evening),
      nightKm: round1(whenKm.night),
      readableKm: round1(readableKm),
      peakShare: readableKm > 0 ? Number((peakKm / readableKm).toFixed(4)) : 0,
      windows: publishedDayparts(),
    },
  };
}

async function vehiclesOf(campaignId: string, range: DateRange, version: string): Promise<
  {
    vehicle: string;
    verifiedKm: number;
    primeKm: number;
    secondaryKm: number;
    networkKm: number;
    charge: Money;
    impressions: number;
  }[]
> {
  const rows = await sequelize.query<VehicleRow>(
    `SELECT v.registration_number,
            COALESCE(SUM(s.distance_km), 0) AS km,
            SUM(s.distance_km) FILTER (WHERE s.zone = 'PRIME') AS prime,
            SUM(s.distance_km) FILTER (WHERE s.zone = 'SECONDARY') AS secondary,
            SUM(s.distance_km) FILTER (WHERE s.zone = 'NETWORK') AS network,
            COALESCE(SUM(s.advertiser_charge), 0) AS charge,
            COALESCE(SUM(si.impressions), 0) AS impressions
       FROM trip_segments s
       JOIN vehicles v ON v.id = s.vehicle_id
       LEFT JOIN segment_impressions si
         ON si.segment_id = s.id AND si.model_version = :version
      WHERE s.campaign_id = :campaignId
        AND s.state = 'BILLABLE'
        AND ${RANGE}
      GROUP BY v.registration_number
      ORDER BY km DESC`,
    {
      replacements: { campaignId, from: range.from, to: range.to, zone: IST, version },
      type: QueryTypes.SELECT,
    },
  );

  return rows.map((row) => ({
    vehicle: anonymisePlate(row.registration_number),
    verifiedKm: round1(Number(row.km)),
    primeKm: round1(Number(row.prime ?? 0)),
    secondaryKm: round1(Number(row.secondary ?? 0)),
    networkKm: round1(Number(row.network ?? 0)),
    charge: toLedger(money(row.charge)),
    impressions: Math.round(Number(row.impressions)),
  }));
}

async function detailOf(campaignId: string, range: DateRange, version: string): Promise<DetailRow[]> {
  const [count] = await sequelize.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM trip_segments s
      WHERE s.campaign_id = :campaignId
        AND s.state = 'BILLABLE'
        AND ${RANGE}`,
    {
      replacements: { campaignId, from: range.from, to: range.to, zone: IST },
      type: QueryTypes.SELECT,
    },
  );

  if (Number(count?.n ?? 0) > MAX_DETAIL_ROWS) {
    throw new UnprocessableError(
      'report_too_large',
      'This period has too many billed segments for a kilometre-detail export. Narrow the dates or use the zone or vehicle summary.',
    );
  }

  return sequelize.query<DetailRow>(
    `SELECT s.started_at,
            s.ended_at,
            ${istDate('s.started_at')}::text AS day,
            v.registration_number,
            s.zone,
            s.distance_km,
            s.advertiser_rate,
            s.advertiser_charge,
            si.impressions,
            si.baseline_source
       FROM trip_segments s
       JOIN vehicles v ON v.id = s.vehicle_id
       LEFT JOIN segment_impressions si
         ON si.segment_id = s.id AND si.model_version = :version
      WHERE s.campaign_id = :campaignId
        AND s.state = 'BILLABLE'
        AND ${RANGE}
      ORDER BY s.started_at, s.part_index`,
    {
      replacements: { campaignId, from: range.from, to: range.to, zone: IST, version },
      type: QueryTypes.SELECT,
    },
  );
}

function instantOf(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

async function buildFile(input: {
  type: ReportType;
  campaign: Campaign;
  advertiser: Advertiser;
  range: DateRange;
}): Promise<{ bytes: Buffer; contentType: string; format: ReportFormat; fileName: string }> {
  const version = CURRENT_MODEL_VERSION;
  await computeMissing(version, { campaignId: input.campaign.id });

  const [cover, zones, visibility] = await Promise.all([
    coverOf(input.campaign.id, input.range),
    zonesOf(input.campaign.id, input.range, version),
    visibilityOf(input.campaign.id, input.range),
  ]);

  if (input.type === 'proof-pack') {
    const busiest = [...zones.byDay]
      .sort((a, b) => b.impressions - a.impressions || b.verifiedKm - a.verifiedKm)
      .slice(0, SAMPLE_DAYS)
      .sort((a, b) => a.date.localeCompare(b.date));

    const sampleDays = await Promise.all(
      busiest.map(async (day) => {
        const detail = await forCampaignDay(input.campaign.id, day.date, version);
        return {
          date: day.date,
          verifiedKm: detail.verifiedKm,
          impressions: detail.impressions,
          charge: detail.charge,
          jamDensity: detail.working.jamDensity,
          occupantsPerVehicle: detail.working.occupantsPerVehicle,
          lineOfSightShare: detail.working.lineOfSightShare,
          wrapQuality: detail.working.wrapQuality,
          medianObservedKmh: detail.working.medianObservedKmh,
          medianBaselineKmh: detail.working.medianBaselineKmh,
        };
      }),
    );

    const html = proofPackHtml({
      generatedAt: new Date().toISOString(),
      campaign: {
        id: input.campaign.id,
        name: input.campaign.name,
        brandName: input.campaign.brandName,
        city: input.campaign.city,
        vehicleType: input.campaign.vehicleType,
        status: input.campaign.status,
        startDate: String(input.campaign.startDate).slice(0, 10),
        endDate: String(input.campaign.endDate).slice(0, 10),
        budget: toLedger(money(input.campaign.budgetAmount)),
        spent: toLedger(money(input.campaign.spentAmount)),
      },
      advertiser: {
        legalName: input.advertiser.legalName,
        brandName: input.advertiser.brandName,
      },
      period: input.range,
      cover,
      zones: zones.rows,
      visibility,
      impressions: {
        modelVersion: version,
        impressions: zones.impressions,
        cpm: cpmOf(zones.charge, zones.impressions),
        charge: zones.charge,
        baselineMix: zones.mix,
      },
      sampleDays,
    });

    return {
      bytes: Buffer.from(html, 'utf8'),
      contentType: 'text/html; charset=utf-8',
      format: 'html',
      fileName: fileNameFor('proof-pack', input.campaign.name, input.range.from, input.range.to, 'html'),
    };
  }

  if (input.type === 'zone-summary') {
    const csv = toCsv(
      ['zone', 'verified_km', 'charged_inr', 'modelled_impressions'],
      zones.rows.map((row) => [row.zone, row.verifiedKm, payableOf(row.charge), row.impressions]),
    );
    return csvFile('zone-summary', input.campaign.name, input.range, csv);
  }

  if (input.type === 'vehicle-summary') {
    const vehicles = await vehiclesOf(input.campaign.id, input.range, version);
    const csv = toCsv(
      [
        'vehicle',
        'verified_km',
        'prime_km',
        'secondary_km',
        'network_km',
        'charged_inr',
        'modelled_impressions',
      ],
      vehicles.map((row) => [
        row.vehicle,
        row.verifiedKm,
        row.primeKm,
        row.secondaryKm,
        row.networkKm,
        payableOf(row.charge),
        row.impressions,
      ]),
    );
    return csvFile('vehicle-summary', input.campaign.name, input.range, csv);
  }

  if (input.type === 'billing-statement') {
    const remaining = toLedger(money(input.campaign.budgetAmount).minus(money(input.campaign.spentAmount)));
    const csv = toCsv(
      [
        'line',
        'campaign',
        'period_from',
        'period_to',
        'verified_km',
        'charged_this_period_inr',
        'campaign_budget_inr',
        'lifetime_charged_inr',
        'remaining_inr',
        'vehicles',
        'zone',
        'zone_km',
        'zone_charged_inr',
      ],
      zones.rows.length === 0
        ? [
            [
              'period',
              input.campaign.name,
              input.range.from,
              input.range.to,
              cover.verifiedKm,
              payableOf(cover.charged),
              payableOf(toLedger(money(input.campaign.budgetAmount))),
              payableOf(toLedger(money(input.campaign.spentAmount))),
              payableOf(remaining),
              cover.vehicles,
              '',
              '',
              '',
            ],
          ]
        : zones.rows.map((row, index) => [
            index === 0 ? 'period' : 'zone',
            input.campaign.name,
            input.range.from,
            input.range.to,
            index === 0 ? cover.verifiedKm : '',
            index === 0 ? payableOf(cover.charged) : '',
            index === 0 ? payableOf(toLedger(money(input.campaign.budgetAmount))) : '',
            index === 0 ? payableOf(toLedger(money(input.campaign.spentAmount))) : '',
            index === 0 ? payableOf(remaining) : '',
            index === 0 ? cover.vehicles : '',
            row.zone,
            row.verifiedKm,
            payableOf(row.charge),
          ]),
    );
    return csvFile('billing-statement', input.campaign.name, input.range, csv);
  }

  const detail = await detailOf(input.campaign.id, input.range, version);
  const csv = toCsv(
    [
      'date_ist',
      'started_at',
      'ended_at',
      'vehicle',
      'zone',
      'distance_km',
      'rate_inr',
      'charged_inr',
      'modelled_impressions',
      'baseline_source',
    ],
    detail.map((row) => [
      row.day,
      instantOf(row.started_at),
      instantOf(row.ended_at),
      anonymisePlate(row.registration_number),
      API_ZONE[row.zone],
      Number(Number(row.distance_km).toFixed(6)),
      payableOf(toLedger(money(row.advertiser_rate))),
      payableOf(toLedger(money(row.advertiser_charge))),
      row.impressions == null ? '' : Math.round(Number(row.impressions)),
      row.baseline_source ?? '',
    ]),
  );
  return csvFile('km-detail', input.campaign.name, input.range, csv);
}

function csvFile(
  type: Exclude<ReportType, 'proof-pack'>,
  campaignName: string,
  range: DateRange,
  csv: string,
): { bytes: Buffer; contentType: string; format: ReportFormat; fileName: string } {
  return {
    bytes: Buffer.from(csv, 'utf8'),
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    fileName: fileNameFor(type, campaignName, range.from, range.to, 'csv'),
  };
}

export async function exportForAdvertiser(input: {
  advertiserId: string;
  campaignId: string;
  type: ReportType;
  range: DateRange;
}): Promise<ReportExportView> {
  assertRange(input.range);
  const { campaign, advertiser } = await loadOwned(input.advertiserId, input.campaignId);
  const file = await buildFile({
    type: input.type,
    campaign,
    advertiser,
    range: input.range,
  });

  const id = randomUUID();
  const ext = file.format === 'html' ? 'html' : 'csv';
  const storageKey = `${input.advertiserId}/${id}.${ext}`;
  const checksum = sha256(file.bytes);
  const generatedAt = new Date();
  const expiresAt = new Date(generatedAt.getTime() + TTL_MS);

  await objectStore().put(storageKey, file.bytes, file.contentType);

  const row = await ReportExport.create({
    id,
    advertiserId: input.advertiserId,
    campaignId: campaign.id,
    type: input.type,
    format: file.format,
    fromDate: input.range.from,
    toDate: input.range.to,
    fileName: file.fileName,
    contentType: file.contentType,
    byteSize: file.bytes.length,
    storageKey,
    checksum,
    generatedAt,
    expiresAt,
    createdAt: generatedAt,
  });

  return toView(row, campaign.name);
}

export async function listForAdvertiser(advertiserId: string): Promise<{ items: ReportExportView[] }> {
  const rows = await ReportExport.findAll({
    where: { advertiserId },
    order: [
      ['generatedAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: 50,
  });

  const now = Date.now();
  const live = rows.filter((row) => row.expiresAt.getTime() > now);
  const names = new Map<string, string>();
  const missing = [...new Set(live.map((row) => row.campaignId))];
  if (missing.length > 0) {
    const campaigns = await Campaign.findAll({
      where: { id: missing, advertiserId },
      attributes: ['id', 'name'],
    });
    for (const campaign of campaigns) names.set(campaign.id, campaign.name);
  }

  return {
    items: live.map((row) => toView(row, names.get(row.campaignId) ?? 'Campaign')),
  };
}

export async function downloadForAdvertiser(
  advertiserId: string,
  id: string,
): Promise<StoredReport> {
  const row = await ReportExport.findOne({ where: { id, advertiserId } });
  if (!row) throw new NotFoundError('Export');
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new NotFoundError('Export', 'That export has expired.');
  }

  const stored = await objectStore().get(row.storageKey);
  if (!stored) throw new NotFoundError('Export', 'That export is no longer available.');

  return { bytes: stored.bytes, contentType: stored.contentType, fileName: row.fileName };
}

