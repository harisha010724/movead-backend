import { QueryTypes } from 'sequelize';

import { sequelize } from '../../db/sequelize';
import { money, toLedger, ZERO, type Money } from '../../pricing/money';
import { ADVERTISER_RATE, DRIVER_RATE } from '../../pricing/rates';
import { NotFoundError } from '../../shared/errors';

/**
 * The two landing screens: operations' view of the whole platform, and an
 * advertiser's view of one campaign.
 *
 * Every figure here is summed from `trip_segments` at read time. Nothing is
 * cached and nothing is stored, for the reason AC-00 gives and that
 * `campaigns.spent_amount` demonstrates — it is a total that was written once,
 * never updated, and spent a release disagreeing with the kilometres behind
 * it. A dashboard is the worst place for that to happen, because it is the
 * screen people quote figures from.
 *
 * The date range is inclusive of both ends and read in Asia/Kolkata, which is
 * the day boundary an operator in Bengaluru means by "today". Postgres does the
 * conversion, so the boundary does not move with the server's own timezone.
 */

const IST = 'Asia/Kolkata';

export interface DateRange {
  from: string;
  to: string;
}

/**
 * A vehicle's live state, as the fleet panels label it.
 *
 * Derived rather than stored: a state column would need writing on a timer,
 * and a vehicle that stops reporting is exactly the case where no write
 * arrives. Reading it from the last fix means silence resolves to `OFFLINE` on
 * its own.
 */
export type LiveVehicleState = 'RUNNING' | 'IDLE' | 'OFFLINE' | 'GPS_PAUSED';

/**
 * How stale the last fix may be before a tracking vehicle counts as paused.
 *
 * The app uploads in batches, so a gap of a few minutes is ordinary traffic
 * rather than a fault. Ten minutes is long enough not to flag a red light and
 * short enough that an operator sees a stalled upload within one refresh.
 */
const GPS_SILENCE_MINUTES = 10;

/**
 * The live fleet, one row per assigned vehicle, with its last known fix.
 *
 * `OFFLINE` vehicles keep their last position rather than being dropped: where
 * a vehicle stopped reporting is the first thing anyone asks, and a row that
 * vanishes from the map cannot answer it.
 */
const LIVE_VEHICLES = `
  WITH live AS (
    SELECT v.id,
           v.registration_number,
           cv.campaign_id,
           p.lat,
           p.lon,
           p.recorded_at,
           CASE
             WHEN s.id IS NULL                                   THEN 'IDLE'
             WHEN p.recorded_at IS NULL                          THEN 'OFFLINE'
             WHEN p.recorded_at < now() - (:silence || ' minutes')::interval
                                                                 THEN 'GPS_PAUSED'
             ELSE 'RUNNING'
           END AS state
      FROM campaign_vehicles cv
      JOIN vehicles v ON v.id = cv.vehicle_id
      LEFT JOIN tracking_sessions s
             ON s.campaign_vehicle_id = cv.id AND s.status = 'ACTIVE'
      LEFT JOIN LATERAL (
             SELECT g.lat, g.lon, g.recorded_at
               FROM gps_points g
              WHERE g.session_id = s.id
              ORDER BY g.recorded_at DESC
              LIMIT 1
           ) p ON TRUE
     WHERE cv.status IN ('ACCEPTED', 'INSTALLING', 'ACTIVE')
  )`;

interface ZoneKm {
  prime: number;
  secondary: number;
  network: number;
}

export interface KmSummary extends ZoneKm {
  total: number;
  rejected: number;
  pending: number;
}

export interface SeriesPoint {
  label: string;
  value: number;
}

// --- Operations -----------------------------------------------------------

export interface AdminDashboard {
  supply: {
    registeredDrivers: number;
    approvedDrivers: number;
    activeCampaigns: number;
    currentlyTracking: number;
  };
  inventoryToday: KmSummary;
  moneyToday: {
    advertiserRevenue: Money;
    driverLiability: Money;
    grossSpread: Money;
  };
  queues: {
    documentsPending: number;
    installationsPending: number;
    kmFlagged: number;
    payoutsAwaitingRelease: number;
  };
  revenueDaily: SeriesPoint[];
  vehicleStatus: { state: LiveVehicleState; count: number }[];
}

export async function adminDashboard(range: DateRange): Promise<AdminDashboard> {
  const [supply, inventory, revenue, queues, revenueDaily, vehicleStatus] = await Promise.all([
    supplyCounts(),
    kmSummary('', {}, range),
    revenueTotals(range),
    queueDepths(),
    dailyRevenue(range),
    vehicleStates(),
  ]);

  return {
    supply,
    inventoryToday: inventory,
    moneyToday: revenue,
    queues,
    revenueDaily,
    vehicleStatus,
  };
}

async function supplyCounts(): Promise<AdminDashboard['supply']> {
  const [row] = await sequelize.query<{
    registered: string;
    approved: string;
    campaigns: string;
    tracking: string;
  }>(
    `SELECT (SELECT count(*) FROM drivers WHERE deleted_at IS NULL)          AS registered,
            (SELECT count(*) FROM drivers
              WHERE deleted_at IS NULL AND status = 'APPROVED')              AS approved,
            (SELECT count(*) FROM campaigns WHERE status = 'ACTIVE')         AS campaigns,
            (SELECT count(*) FROM tracking_sessions WHERE status = 'ACTIVE') AS tracking`,
    { type: QueryTypes.SELECT },
  );

  return {
    registeredDrivers: Number(row?.registered ?? 0),
    approvedDrivers: Number(row?.approved ?? 0),
    activeCampaigns: Number(row?.campaigns ?? 0),
    currentlyTracking: Number(row?.tracking ?? 0),
  };
}

/**
 * Kilometres in the range, split by zone and by whether they earn.
 *
 * The zone figures cover billable distance only. A rejected kilometre still
 * happened in a zone, but reporting it there would put distance nobody is
 * charged for into a column the advertiser reads as inventory they bought.
 */
async function kmSummary(
  scope: string,
  replacements: Record<string, unknown>,
  range: DateRange,
): Promise<KmSummary> {
  const rows = await sequelize.query<{ state: string; zone: string; km: string }>(
    `SELECT state, zone, COALESCE(SUM(distance_km), 0) AS km
       FROM trip_segments
      WHERE ${inRange(scope)}
      GROUP BY state, zone`,
    { replacements: { ...replacements, ...rangeBinds(range) }, type: QueryTypes.SELECT },
  );

  const sumOf = (predicate: (row: { state: string; zone: string }) => boolean) =>
    rows.filter(predicate).reduce((total, row) => total + Number(row.km), 0);

  const billableIn = (zone: string) =>
    round(sumOf((row) => row.state === 'BILLABLE' && row.zone === zone));

  return {
    total: round(sumOf(() => true)),
    prime: billableIn('PRIME'),
    secondary: billableIn('SECONDARY'),
    network: billableIn('NETWORK'),
    rejected: round(sumOf((row) => row.state === 'NON_BILLABLE')),
    pending: round(sumOf((row) => row.state === 'PENDING_REVIEW')),
  };
}

async function revenueTotals(range: DateRange): Promise<AdminDashboard['moneyToday']> {
  const [row] = await sequelize.query<{ revenue: string; liability: string }>(
    `SELECT COALESCE(SUM(advertiser_charge), 0) AS revenue,
            COALESCE(SUM(driver_earning), 0)    AS liability
       FROM trip_segments
      WHERE ${inRange('')} AND state = 'BILLABLE'`,
    { replacements: rangeBinds(range), type: QueryTypes.SELECT },
  );

  const revenue = money(row?.revenue ?? 0);
  const liability = money(row?.liability ?? 0);

  return {
    advertiserRevenue: toLedger(revenue),
    driverLiability: toLedger(liability),
    grossSpread: toLedger(revenue.minus(liability)),
  };
}

/**
 * What is waiting for a person.
 *
 * `payoutsAwaitingRelease` is zero and stays zero until payout runs exist.
 * Reported rather than omitted because the queue list is fixed and a missing
 * tile reads as a loading failure; zero reads as nothing to do, which is true.
 */
async function queueDepths(): Promise<AdminDashboard['queues']> {
  const [row] = await sequelize.query<{
    documents: string;
    installations: string;
    flagged: string;
  }>(
    `SELECT (SELECT count(*) FROM documents WHERE status = 'UPLOADED')      AS documents,
            (SELECT count(*) FROM installations WHERE status = 'SUBMITTED') AS installations,
            (SELECT count(*) FROM trip_segments
              WHERE state = 'PENDING_REVIEW')                               AS flagged`,
    { type: QueryTypes.SELECT },
  );

  return {
    documentsPending: Number(row?.documents ?? 0),
    installationsPending: Number(row?.installations ?? 0),
    kmFlagged: Number(row?.flagged ?? 0),
    payoutsAwaitingRelease: 0,
  };
}

/**
 * One point per day in the range, including days nothing was driven.
 *
 * `generate_series` rather than grouping what exists: a chart that omits empty
 * days draws a straight line across the gap, which reads as steady trade
 * through a day the fleet did not move.
 */
async function dailyRevenue(range: DateRange): Promise<SeriesPoint[]> {
  const rows = await sequelize.query<{ label: string; value: string }>(
    `SELECT to_char(day, 'DD Mon')               AS label,
            COALESCE(SUM(s.advertiser_charge), 0) AS value
       FROM generate_series(:from::date, :to::date, interval '1 day') AS day
       LEFT JOIN trip_segments s
              ON s.state = 'BILLABLE'
             AND (s.started_at AT TIME ZONE :zone)::date = day::date
      GROUP BY day
      ORDER BY day`,
    { replacements: rangeBinds(range), type: QueryTypes.SELECT },
  );

  return rows.map((row) => ({ label: row.label, value: Number(row.value) }));
}

/**
 * Every vehicle currently carrying a campaign, bucketed by what its fixes say.
 *
 * A vehicle with no live assignment is not counted at all. It is not offline —
 * it is not working, which is a different thing, and folding the two together
 * would move the panel's total every time a campaign ended.
 */
async function vehicleStates(
  campaignId: string | null = null,
): Promise<{ state: LiveVehicleState; count: number }[]> {
  const rows = await sequelize.query<{ state: LiveVehicleState; count: string }>(
    `${LIVE_VEHICLES}
     SELECT state, count(*) AS count
       FROM live
      WHERE (:campaignId::uuid IS NULL OR campaign_id = :campaignId::uuid)
      GROUP BY state`,
    { replacements: { silence: GPS_SILENCE_MINUTES, campaignId }, type: QueryTypes.SELECT },
  );

  return rows.map((row) => ({ state: row.state, count: Number(row.count) }));
}

// --- Live map -------------------------------------------------------------

export interface LivePosition {
  vehicleRef: string;
  lat: number;
  lon: number;
  state: LiveVehicleState;
  updatedAt: string;
}

export async function livePositions(
  campaignId: string | null,
): Promise<{ items: LivePosition[]; updatedAt: string }> {
  const rows = await sequelize.query<{
    registration_number: string;
    lat: string | null;
    lon: string | null;
    state: LiveVehicleState;
    recorded_at: Date | null;
  }>(
    `${LIVE_VEHICLES}
     SELECT registration_number, lat, lon, state, recorded_at
       FROM live
      WHERE (:campaignId::uuid IS NULL OR campaign_id = :campaignId::uuid)
        AND lat IS NOT NULL
      ORDER BY recorded_at DESC NULLS LAST`,
    { replacements: { silence: GPS_SILENCE_MINUTES, campaignId }, type: QueryTypes.SELECT },
  );

  return {
    items: rows.map((row) => ({
      vehicleRef: row.registration_number,
      lat: Number(row.lat),
      lon: Number(row.lon),
      state: row.state,
      updatedAt: (row.recorded_at ?? new Date()).toISOString(),
    })),
    // The batch's own timestamp, not the newest fix in it. The panel shows this
    // as "updated N seconds ago", which is a statement about the age of the
    // answer rather than about the freshest vehicle in it.
    updatedAt: new Date().toISOString(),
  };
}

// --- Advertiser -----------------------------------------------------------

/**
 * Impressions are not counted anywhere, and this is not an oversight.
 *
 * No acceptance criterion defines what one is — how many people see a wrapped
 * vehicle over a kilometre is a research question, not a measurement the
 * platform makes. `campaigns.service.ts` already reports `impressions: 0` for
 * the same reason, and the two must agree: a campaign row and the dashboard
 * above it citing different reach would be worse than citing none.
 *
 * The series are still returned, with real labels and zero values, so the
 * charts render axes rather than an error. Nothing in the pricing path may read
 * any of this until an AC says what it means.
 */
const IMPRESSIONS_UNDEFINED = 0;

export interface SpendBreakdown {
  prime: Money;
  secondary: Money;
  network: Money;
  total: Money;
}

export interface TopVehicleRow {
  vehicleNumber: string;
  driverName: string;
  area: string;
  km: number;
  zoneKm: ZoneKm;
  impressions: number;
  spend: Money;
  state: LiveVehicleState;
}

export interface AdvertiserDashboard {
  campaignId: string;
  km: KmSummary;
  spend: SpendBreakdown;
  budget: Money;
  remaining: Money;
  activeVehicles: number;
  costPerKm: Money;
  impressions: number;
  costPerThousandImpressions: Money;
  comparison: {
    impressions: number;
    verifiedKm: number;
    spend: number;
    activeVehicles: number;
    costPerThousandImpressions: number;
  };
  rates: {
    advertiser: Record<'PRIME' | 'SECONDARY' | 'NETWORK', Money>;
    driver: Record<'PRIME' | 'SECONDARY' | 'NETWORK', Money>;
    effectiveFrom: string;
  };
  impressionsDaily: SeriesPoint[];
  impressionsHourly: SeriesPoint[];
  impressionsByArea: SeriesPoint[];
  impressionsByVehicleType: SeriesPoint[];
  vehicleStatus: { state: LiveVehicleState; count: number }[];
  topVehicles: TopVehicleRow[];
  alerts: {
    id: string;
    severity: 'info' | 'warning' | 'critical';
    message: string;
    occurredAt: string;
  }[];
}

/**
 * One campaign's performance over a range, against the preceding range of
 * equal length.
 *
 * The comparison window is derived rather than asked for: an advertiser
 * reading "up 16%" means against the period just before, and letting the
 * caller choose both windows is how two people compare different things and
 * both call it growth.
 */
export async function advertiserDashboard(input: {
  campaignId: string;
  range: DateRange;
}): Promise<AdvertiserDashboard> {
  const scope = ' AND campaign_id = :campaignId';
  const binds = { campaignId: input.campaignId };
  const previous = precedingRange(input.range);

  const [km, spend, campaign, vehicles, priorKm, priorSpend, priorVehicles, top, states] =
    await Promise.all([
      kmSummary(scope, binds, input.range),
      zoneSpend(input.campaignId, input.range),
      campaignFacts(input.campaignId),
      activeVehicleCount(input.campaignId, input.range),
      kmSummary(scope, binds, previous),
      zoneSpend(input.campaignId, previous),
      activeVehicleCount(input.campaignId, previous),
      topVehicles(input.campaignId, input.range),
      vehicleStates(input.campaignId),
    ]);

  const verifiedKm = km.prime + km.secondary + km.network;
  const priorVerifiedKm = priorKm.prime + priorKm.secondary + priorKm.network;
  const spent = money(spend.total);

  return {
    campaignId: input.campaignId,
    km,
    spend,
    budget: campaign.budget,
    remaining: toLedger(money(campaign.budget).minus(spent)),
    activeVehicles: vehicles,
    costPerKm: verifiedKm > 0 ? toLedger(spent.dividedBy(verifiedKm)) : toLedger(ZERO),
    impressions: IMPRESSIONS_UNDEFINED,
    // Zero over zero impressions. Not a division that was skipped — there is no
    // numerator to divide, and a placeholder here would be a made-up price.
    costPerThousandImpressions: toLedger(ZERO),
    comparison: {
      impressions: 0,
      verifiedKm: changeRatio(verifiedKm, priorVerifiedKm),
      spend: changeRatio(Number(spend.total), Number(priorSpend.total)),
      activeVehicles: changeRatio(vehicles, priorVehicles),
      costPerThousandImpressions: 0,
    },
    rates: {
      advertiser: {
        PRIME: ADVERTISER_RATE.prime,
        SECONDARY: ADVERTISER_RATE.secondary,
        NETWORK: ADVERTISER_RATE.network,
      },
      driver: {
        PRIME: DRIVER_RATE.prime,
        SECONDARY: DRIVER_RATE.secondary,
        NETWORK: DRIVER_RATE.network,
      },
      // Rates are platform-fixed for the pilot (AC-02.3) and have never
      // changed, so the campaign's own start is when they took effect for this
      // advertiser. There is no rate history table to read a truer date from.
      effectiveFrom: campaign.startedAt,
    },
    impressionsDaily: await labelledDays(input.range),
    impressionsHourly: HOURS.map((label) => ({ label, value: 0 })),
    impressionsByArea: [],
    impressionsByVehicleType: [],
    vehicleStatus: states,
    topVehicles: top,
    // No alert model exists. An empty list renders "nothing to report", which
    // is honest; deriving alerts from thresholds nobody has agreed would put
    // words in operations' mouth.
    alerts: [],
  };
}

async function zoneSpend(campaignId: string, range: DateRange): Promise<SpendBreakdown> {
  const rows = await sequelize.query<{ zone: string; charge: string }>(
    `SELECT zone, COALESCE(SUM(advertiser_charge), 0) AS charge
       FROM trip_segments
      WHERE ${inRange(' AND campaign_id = :campaignId')} AND state = 'BILLABLE'
      GROUP BY zone`,
    { replacements: { campaignId, ...rangeBinds(range) }, type: QueryTypes.SELECT },
  );

  const of = (zone: string) => money(rows.find((row) => row.zone === zone)?.charge ?? 0);
  const prime = of('PRIME');
  const secondary = of('SECONDARY');
  const network = of('NETWORK');

  return {
    prime: toLedger(prime),
    secondary: toLedger(secondary),
    network: toLedger(network),
    total: toLedger(prime.plus(secondary).plus(network)),
  };
}

async function campaignFacts(campaignId: string): Promise<{ budget: Money; startedAt: string }> {
  const [row] = await sequelize.query<{ budget_amount: string; start_date: string | Date }>(
    'SELECT budget_amount, start_date FROM campaigns WHERE id = :campaignId',
    { replacements: { campaignId }, type: QueryTypes.SELECT },
  );

  if (!row) throw new NotFoundError('That campaign does not exist.');

  const start = typeof row.start_date === 'string' ? new Date(row.start_date) : row.start_date;

  return { budget: toLedger(money(row.budget_amount)), startedAt: start.toISOString() };
}

/** Vehicles that actually drove a billable kilometre in the range. */
async function activeVehicleCount(campaignId: string, range: DateRange): Promise<number> {
  const [row] = await sequelize.query<{ count: string }>(
    `SELECT count(DISTINCT vehicle_id) AS count
       FROM trip_segments
      WHERE ${inRange(' AND campaign_id = :campaignId')} AND state = 'BILLABLE'`,
    { replacements: { campaignId, ...rangeBinds(range) }, type: QueryTypes.SELECT },
  );

  return Number(row?.count ?? 0);
}

async function topVehicles(campaignId: string, range: DateRange): Promise<TopVehicleRow[]> {
  const rows = await sequelize.query<{
    registration_number: string;
    name: string;
    area: string | null;
    km: string;
    prime: string | null;
    secondary: string | null;
    network: string | null;
    spend: string;
    state: LiveVehicleState | null;
  }>(
    `${LIVE_VEHICLES}
     SELECT v.registration_number,
            d.name,
            COALESCE(d.base_label, d.address_city, d.city)         AS area,
            SUM(s.distance_km)                                     AS km,
            SUM(s.distance_km) FILTER (WHERE s.zone = 'PRIME')     AS prime,
            SUM(s.distance_km) FILTER (WHERE s.zone = 'SECONDARY') AS secondary,
            SUM(s.distance_km) FILTER (WHERE s.zone = 'NETWORK')   AS network,
            SUM(s.advertiser_charge)                               AS spend,
            max(live.state)                                        AS state
       FROM trip_segments s
       JOIN vehicles v ON v.id = s.vehicle_id
       JOIN drivers  d ON d.id = s.driver_id
       LEFT JOIN live ON live.id = s.vehicle_id
      WHERE ${inRange(' AND s.campaign_id = :campaignId', 's.')}
        AND s.state = 'BILLABLE'
      GROUP BY v.registration_number, d.name, area
      ORDER BY km DESC
      LIMIT 10`,
    {
      replacements: { campaignId, silence: GPS_SILENCE_MINUTES, ...rangeBinds(range) },
      type: QueryTypes.SELECT,
    },
  );

  return rows.map((row) => ({
    vehicleNumber: row.registration_number,
    driverName: row.name,
    area: row.area ?? '—',
    km: round(Number(row.km)),
    zoneKm: {
      prime: round(Number(row.prime ?? 0)),
      secondary: round(Number(row.secondary ?? 0)),
      network: round(Number(row.network ?? 0)),
    },
    impressions: IMPRESSIONS_UNDEFINED,
    spend: toLedger(money(row.spend)),
    // A vehicle that has since left the campaign has no live row to read.
    state: row.state ?? 'OFFLINE',
  }));
}

// --- Fleet listing --------------------------------------------------------

export interface VehicleListing {
  id: string;
  vehicleRef: string;
  vehicleType: 'AUTO' | 'CAB';
  primaryArea: string;
  avgKmPerDay: number;
  zoneMix: ZoneKm;
  status: string;
}

/**
 * The fleet with how it actually performs, for operations' vehicle report.
 *
 * Distinct from `/v1/vehicles/available`, which answers "what can I book" for
 * an advertiser and deliberately withholds the plate and the driver. This is
 * the operator's list and carries both.
 *
 * `avgKmPerDay` and `zoneMix` are read over the last 30 days rather than all
 * time: a vehicle that worked hard in June and has been idle since is not a
 * 90 km/day vehicle today, and an average saying so would send it to the top
 * of a list of who to assign next.
 */
export async function vehicleListing(input: {
  page: number;
  pageSize: number;
  status?: string;
}): Promise<{ items: VehicleListing[]; page: number; pageSize: number; total: number }> {
  const filter = input.status ? 'WHERE v.status = :status::vehicle_status' : '';
  const replacements = {
    status: input.status ?? null,
    limit: input.pageSize,
    offset: (input.page - 1) * input.pageSize,
  };

  const [count] = await sequelize.query<{ total: string }>(
    `SELECT count(*) AS total FROM vehicles v ${filter}`,
    { replacements, type: QueryTypes.SELECT },
  );

  const rows = await sequelize.query<{
    id: string;
    registration_number: string;
    category: 'AUTO' | 'CAB';
    area: string | null;
    status: string;
    km: string | null;
    prime: string | null;
    secondary: string | null;
    network: string | null;
  }>(
    `SELECT v.id,
            v.registration_number,
            v.category,
            v.status,
            COALESCE(d.base_label, d.address_city, d.city) AS area,
            s.km, s.prime, s.secondary, s.network
       FROM vehicles v
       JOIN drivers d ON d.id = v.driver_id
       LEFT JOIN LATERAL (
              SELECT SUM(distance_km)                                   AS km,
                     SUM(distance_km) FILTER (WHERE zone = 'PRIME')     AS prime,
                     SUM(distance_km) FILTER (WHERE zone = 'SECONDARY') AS secondary,
                     SUM(distance_km) FILTER (WHERE zone = 'NETWORK')   AS network
                FROM trip_segments t
               WHERE t.vehicle_id = v.id
                 AND t.state = 'BILLABLE'
                 AND t.started_at >= now() - interval '30 days'
            ) s ON TRUE
       ${filter}
      ORDER BY v.registration_number
      LIMIT :limit OFFSET :offset`,
    { replacements, type: QueryTypes.SELECT },
  );

  return {
    items: rows.map((row) => {
      const km = Number(row.km ?? 0);
      const share = (value: string | null) =>
        km > 0 ? Number((Number(value ?? 0) / km).toFixed(4)) : 0;

      return {
        id: row.id,
        vehicleRef: row.registration_number,
        vehicleType: row.category,
        primaryArea: row.area ?? '—',
        avgKmPerDay: round(km / 30),
        zoneMix: {
          prime: share(row.prime),
          secondary: share(row.secondary),
          network: share(row.network),
        },
        status: row.status,
      };
    }),
    page: input.page,
    pageSize: input.pageSize,
    total: Number(count?.total ?? 0),
  };
}

// --- Shared fragments -----------------------------------------------------

/**
 * Segments fall in the day they were driven, not the day they were uploaded.
 *
 * A driver who finishes at 23:50 and syncs at 00:05 earned on the day they
 * drove, and AC-08.7 already makes that the billing boundary.
 */
function inRange(scope: string, alias = ''): string {
  return `(${alias}started_at AT TIME ZONE :zone)::date BETWEEN :from::date AND :to::date${scope}`;
}

function rangeBinds(range: DateRange): Record<string, unknown> {
  return { from: range.from, to: range.to, zone: IST };
}

/** Kilometres are reported to one decimal, as everywhere else in the API. */
function round(value: number): number {
  return Number(value.toFixed(1));
}

/**
 * The range immediately before this one, of the same length, ending the day
 * before it starts.
 */
export function precedingRange(range: DateRange): DateRange {
  const from = new Date(`${range.from}T00:00:00Z`);
  const to = new Date(`${range.to}T00:00:00Z`);
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;

  const priorTo = new Date(from.getTime() - 86_400_000);
  const priorFrom = new Date(priorTo.getTime() - (days - 1) * 86_400_000);
  const asDate = (value: Date) => value.toISOString().slice(0, 10);

  return { from: asDate(priorFrom), to: asDate(priorTo) };
}

/**
 * Growth against the previous period, as a ratio.
 *
 * Growth from nothing is not a percentage. Zero says "no comparison
 * available", which is the truth; infinity would put a meaningless figure next
 * to a real one.
 */
export function changeRatio(current: number, previous: number): number {
  if (previous === 0) return 0;
  return Number(((current - previous) / previous).toFixed(4));
}

const HOURS = Array.from({ length: 24 }, (_, hour) => {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(twelve)} ${suffix}`;
});

async function labelledDays(range: DateRange): Promise<SeriesPoint[]> {
  const rows = await sequelize.query<{ label: string }>(
    `SELECT to_char(day, 'DD Mon') AS label
       FROM generate_series(:from::date, :to::date, interval '1 day') AS day
      ORDER BY day`,
    { replacements: rangeBinds(range), type: QueryTypes.SELECT },
  );

  return rows.map((row) => ({ label: row.label, value: 0 }));
}
