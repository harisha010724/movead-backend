import { Op, QueryTypes, type Transaction } from 'sequelize';

import { sequelize } from '../../db/sequelize';
import { money, sum, toLedger, toPayable, type Money } from '../../pricing/money';
import { config } from '../../shared/config';
import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors';
import type { LatLng, Zone, ZonePolygons } from '../../shared/geo';
import { IST, istDate, istMonth } from '../../shared/time';
import { Campaign } from '../campaigns/campaigns.model';
import { Driver, Vehicle } from '../drivers/drivers.model';
import { eligibility } from '../installations/eligibility';
import { CampaignVehicle, LIVE_ASSIGNMENT } from '../installations/installations.model';

import {
  GpsPoint,
  TrackingSession,
  TripSegment,
  type SegmentState,
  type SegmentZone,
} from './tracking.model';
import { buildSegments, qualityOf, type PipelineFix } from './tracking.pipeline';

/**
 * Tracking: the driver's session, the fixes it produces, and the totals read
 * back off them.
 *
 * The shape of this module follows from AC-00. There is no `verified_km`
 * column and no running balance anywhere — every figure below is a `SUM` over
 * `trip_segments`, so a total can never drift from the segments that justify
 * it, and any number on any screen can be opened up into the GPS behind it.
 */

const MAX_POINTS_PER_BATCH = 500;

/** How far back a phone may date a session it started with no signal. */
const MAX_BACKDATE_MS = 24 * 60 * 60 * 1000;

export interface SessionView {
  id: string;
  campaignId: string;
  campaignName: string;
  vehicleRegistration: string;
  startedAt: string;
  status: 'ACTIVE' | 'ENDED';
  verifiedKm: number;
  pendingKm: number;
  estimatedEarnings: Money;
  route: LatLng[];
}

// --- Reading totals ------------------------------------------------------

interface Totals {
  billableKm: string;
  pendingKm: string;
  earnings: Money;
  charge: Money;
  /**
   * What review is holding, valued at what it would pay if released.
   *
   * Held segments carry zero money by schema (AC-11.4, AC-18.2), so this is
   * reconstructed from the distance and the rate stamped on them — which is
   * why the rate is stamped on a segment that earns nothing yet.
   */
  pendingEarnings: Money;
}

/**
 * One pass over the segments matching `where`, split by whether they earn.
 *
 * Deliberately a single grouped query rather than several counts: the driver's
 * dashboard, the campaign's spend and the payout run all ask this question,
 * and asking it three ways is how two screens end up disagreeing about the
 * same kilometre.
 */
async function totalsFor(
  where: string,
  replacements: Record<string, unknown>,
  // Ingestion reads its own totals back before committing. Without the
  // transaction the read happens outside it and reports the batch before this
  // one — so the phone was shown a figure one upload behind reality.
  transaction?: Transaction,
): Promise<Totals> {
  const rows = (await sequelize.query(
    `SELECT state,
            COALESCE(SUM(distance_km), 0)                 AS km,
            COALESCE(SUM(driver_earning), 0)              AS earnings,
            COALESCE(SUM(advertiser_charge), 0)           AS charge,
            COALESCE(SUM(distance_km * driver_rate), 0)   AS would_earn
       FROM trip_segments
      WHERE ${where}
      GROUP BY state`,
    { replacements, type: 'SELECT', ...(transaction ? { transaction } : {}) },
  )) as { state: string; km: string; earnings: string; charge: string; would_earn: string }[];

  const of = (state: string) => rows.find((row) => row.state === state);
  const billable = of('BILLABLE');
  const pending = of('PENDING_REVIEW');

  return {
    billableKm: billable?.km ?? '0',
    pendingKm: pending?.km ?? '0',
    earnings: billable?.earnings ?? '0.0000',
    charge: billable?.charge ?? '0.0000',
    pendingEarnings: pending?.would_earn ?? '0.0000',
  };
}

/** Kilometres are shown to one decimal; the stored value keeps six. */
const asKm = (value: string): number => Number(money(value).toFixed(1));

// --- Sessions ------------------------------------------------------------

async function liveAssignment(driverId: string): Promise<CampaignVehicle> {
  const assignment = await CampaignVehicle.findOne({
    where: { driverId, status: { [Op.in]: LIVE_ASSIGNMENT } },
    include: [
      { model: Campaign, as: 'campaign', required: true },
      { model: Vehicle, as: 'vehicle', required: true },
    ],
  });

  if (!assignment) throw new ConflictError('No campaign is assigned to your vehicle.');
  return assignment;
}

/**
 * Open a session (AC-08).
 *
 * The five AC-07 conditions are checked here and refused with the same list
 * the app already draws, so a driver who somehow gets past a disabled button —
 * a stale screen, a replayed request, a rebuilt client — is stopped by the
 * server rather than by the interface.
 */
export async function startSession(input: {
  driverId: string;
  startedAt?: string | null;
}): Promise<SessionView> {
  const gate = await eligibility(input.driverId);
  if (!gate.eligible) {
    const unmet = gate.checks.filter((check) => !check.passed).map((check) => check.label);
    throw new ConflictError(`Tracking cannot start yet: ${unmet.join(', ')}.`);
  }

  const assignment = await liveAssignment(input.driverId);

  const existing = await TrackingSession.findOne({
    where: { driverId: input.driverId, status: 'ACTIVE' },
  });
  // AC-08.6 says a driver cannot hold two sessions. Returning the one they
  // already have is the useful reading of a second start: a phone that lost
  // the response and retried should find its session, not a 409 it cannot act
  // on. The unique index is still what makes two impossible.
  if (existing) return toView(existing, assignment);

  const startedAt = boundaryFrom(input.startedAt);

  const session = await TrackingSession.create({
    driverId: input.driverId,
    vehicleId: assignment.vehicleId,
    campaignId: assignment.campaignId,
    campaignVehicleId: assignment.id,
    startedAt,
    status: 'ACTIVE',
  });

  return toView(session, assignment);
}

/**
 * AC-08.5 and AC-08.7 — the start timestamp is the billing boundary, and a
 * session begun with no signal keeps the local time it was begun at.
 *
 * Which means the phone gets to name it, and the phone's clock is the driver's
 * to change. Bounded on both sides: never in the future, never more than a day
 * ago. Outside those it is not a clock skew, it is a claim about yesterday.
 */
function boundaryFrom(claimed: string | null | undefined): Date {
  const now = Date.now();
  if (!claimed) return new Date(now);

  const at = new Date(claimed);
  if (Number.isNaN(at.getTime())) throw new BadRequestError('startedAt is not a timestamp.');

  const ms = at.getTime();
  if (ms > now) return new Date(now);
  if (ms < now - MAX_BACKDATE_MS) {
    throw new BadRequestError('A session cannot be backdated more than a day.');
  }
  return at;
}

export async function stopSession(input: {
  driverId: string;
  reason?: string | null;
}): Promise<SessionView> {
  const session = await TrackingSession.findOne({
    where: { driverId: input.driverId, status: 'ACTIVE' },
  });
  if (!session) throw new NotFoundError('Tracking session');

  await session.update({
    status: 'ENDED',
    endedAt: new Date(),
    endReason: input.reason ?? 'The driver stopped tracking.',
  });

  return toView(session, null);
}

export async function currentSession(driverId: string): Promise<SessionView | null> {
  const session = await TrackingSession.findOne({
    where: { driverId, status: 'ACTIVE' },
  });
  return session ? toView(session, null) : null;
}

async function toView(
  session: TrackingSession,
  assignment: CampaignVehicle | null,
): Promise<SessionView> {
  const [campaign, vehicle, totals, route] = await Promise.all([
    assignment?.campaign ?? Campaign.findByPk(session.campaignId),
    assignment?.vehicle ?? Vehicle.findByPk(session.vehicleId),
    totalsFor('session_id = :id', { id: session.id }),
    routeFor(session.id),
  ]);

  return {
    id: session.id,
    campaignId: session.campaignId,
    campaignName: campaign?.name ?? '',
    vehicleRegistration: vehicle?.registrationNumber ?? '',
    startedAt: session.startedAt.toISOString(),
    status: session.status,
    verifiedKm: asKm(totals.billableKm),
    pendingKm: asKm(totals.pendingKm),
    estimatedEarnings: toPayable(money(totals.earnings)),
    route,
  };
}

/**
 * The line the app draws.
 *
 * Thinned to a ceiling rather than returned whole: a nine-hour shift at a fix
 * every three seconds is ten thousand points, and a phone asked to redraw that
 * every few seconds will drop frames long before the driver learns anything
 * from the extra detail.
 */
const ROUTE_POINTS = 200;

async function routeFor(sessionId: string): Promise<LatLng[]> {
  const rows = (await sequelize.query(
    `SELECT lat, lon FROM (
       SELECT lat, lon, recorded_at,
              row_number() OVER (ORDER BY recorded_at) AS n,
              count(*)     OVER ()                     AS total
         FROM gps_points
        WHERE session_id = :sessionId AND quality <> 'REJECTED'
     ) ranked
      WHERE n % GREATEST(1, (total / :ceiling)::int) = 0
      ORDER BY recorded_at`,
    { replacements: { sessionId, ceiling: ROUTE_POINTS }, type: 'SELECT' },
  )) as { lat: string; lon: string }[];

  return rows.map((row) => ({ lat: Number(row.lat), lng: Number(row.lon) }));
}

// --- Ingestion -----------------------------------------------------------

export interface IncomingPoint {
  clientPointId: string;
  recordedAt: string;
  lat: number;
  lon: number;
  accuracyM: number;
  speedMps?: number | null;
  headingDeg?: number | null;
  isMock?: boolean;
  deviceDistanceM?: number | null;
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
  verifiedKm: number;
  pendingKm: number;
}

/**
 * Take a batch of fixes from a phone and price what they describe (AC-19).
 *
 * Idempotent by construction, and it has to be: the phone deletes its local
 * buffer only once it has seen a 2xx, so every response that gets lost on the
 * way back produces a re-send of a batch already stored. `ON CONFLICT DO
 * NOTHING` on the phone's own id makes the second copy a no-op, and the unique
 * key on the segment's endpoints means even a re-drive of the pipeline cannot
 * mint a second kilometre from the same pair (AC-16.10).
 *
 * The whole batch lands in one transaction. A half-ingested batch would leave
 * a hole the retry cannot fill, because the phone re-sends all of it or none.
 */
export async function ingestPoints(input: {
  driverId: string;
  sessionId: string;
  points: IncomingPoint[];
}): Promise<IngestResult> {
  if (input.points.length === 0) throw new BadRequestError('The batch is empty.');
  if (input.points.length > MAX_POINTS_PER_BATCH) {
    throw new BadRequestError(`A batch holds at most ${MAX_POINTS_PER_BATCH} points.`);
  }

  const session = await TrackingSession.findOne({
    where: { id: input.sessionId, driverId: input.driverId },
  });
  if (!session) throw new NotFoundError('Tracking session');

  const campaign = await Campaign.findByPk(session.campaignId);
  if (!campaign) throw new NotFoundError('Campaign');

  // AC-07.3: evaluated now, for this stretch of driving, rather than trusted
  // from whenever the session opened.
  const gate = await eligibility(input.driverId);
  const notBillableReason = gate.eligible
    ? null
    : `Not billable: ${gate.checks
        .filter((check) => !check.passed)
        .map((check) => check.label)
        .join(', ')}.`;

  return sequelize.transaction(async (transaction) => {
    const rows = input.points.map((point) => ({
      sessionId: session.id,
      clientPointId: point.clientPointId,
      // AC-19.3: capture time, not arrival time. What the phone says happened
      // when is the only record of when it happened.
      recordedAt: new Date(point.recordedAt),
      lat: String(point.lat),
      lon: String(point.lon),
      accuracyM: String(point.accuracyM),
      speedMps: point.speedMps == null ? null : String(point.speedMps),
      headingDeg: point.headingDeg == null ? null : String(point.headingDeg),
      isMock: point.isMock ?? false,
      quality: qualityOf(point.accuracyM),
      deviceDistanceM: point.deviceDistanceM == null ? null : String(point.deviceDistanceM),
    }));

    // Counted before the insert rather than inferred from it: `ON CONFLICT DO
    // NOTHING` does not report what it skipped, and a phone that cannot tell a
    // re-send from a fresh batch has no way to notice its buffer is not
    // draining.
    const duplicates = await GpsPoint.count({
      where: {
        sessionId: session.id,
        clientPointId: { [Op.in]: rows.map((row) => row.clientPointId) },
      },
      transaction,
    });

    await GpsPoint.bulkCreate(rows, {
      transaction,
      ignoreDuplicates: true,
      returning: false,
    });

    /*
     * Re-read the window rather than segmenting only what just arrived.
     *
     * A batch begins where the last one ended, and the pair spanning that
     * join is a real kilometre that neither batch contains on its own.
     * Segmenting the arrival in isolation would drop one pair per upload —
     * invisible in testing, and roughly a percent of every driver's earnings
     * in a shift.
     */
    const earliest = rows.reduce(
      (oldest, row) => (row.recordedAt < oldest ? row.recordedAt : oldest),
      rows[0]?.recordedAt ?? new Date(),
    );
    const window = new Date(earliest.getTime() - config.tracking.maxBridgeSeconds * 1000);

    const fixes = await GpsPoint.findAll({
      where: { sessionId: session.id, recordedAt: { [Op.gte]: window } },
      order: [['recordedAt', 'ASC']],
      transaction,
    });

    const segments = buildSegments({
      fixes: fixes.map(toPipelineFix),
      polygons: polygonsOf(campaign),
      billable: gate.eligible,
      notBillableReason,
    });

    if (segments.length > 0) {
      await TripSegment.bulkCreate(
        segments.map((segment) => ({
          ...segment,
          sessionId: session.id,
          campaignId: session.campaignId,
          driverId: session.driverId,
          vehicleId: session.vehicleId,
        })),
        // The pair is already consumed when a batch overlaps the last one, or
        // when a lost response makes the phone send it again.
        { transaction, ignoreDuplicates: true, returning: false },
      );
    }

    const totals = await totalsFor('session_id = :id', { id: session.id }, transaction);

    return {
      accepted: rows.length - duplicates,
      duplicates,
      verifiedKm: asKm(totals.billableKm),
      pendingKm: asKm(totals.pendingKm),
    };
  });
}

function toPipelineFix(row: GpsPoint): PipelineFix {
  return {
    id: row.id,
    recordedAt: row.recordedAt,
    lat: Number(row.lat),
    lon: Number(row.lon),
    accuracyM: Number(row.accuracyM),
    isMock: row.isMock,
    quality: row.quality,
  };
}

function polygonsOf(campaign: Campaign): ZonePolygons {
  const drawn = campaign.zonePolygons as ZonePolygons | null;
  return drawn ?? {};
}

// --- Aggregates other modules read --------------------------------------

/** AC-23 — the driver's own figures, summed from their segments. */
export async function earningsFor(driverId: string): Promise<{
  availableBalance: Money;
  pendingBalance: Money;
  monthVerifiedKm: number;
  monthEarnings: Money;
  todayVerifiedKm: number;
  todayEarnings: Money;
  history: { date: string; verifiedKm: number; earnings: Money }[];
}> {
  const [today, month, lifetime, history] = await Promise.all([
    totalsFor(`driver_id = :driverId AND ${istDate('started_at')} = ${istDate('now()')}`, {
      driverId,
      zone: IST,
    }),
    totalsFor(`driver_id = :driverId AND ${istMonth('started_at')} = ${istMonth('now()')}`, {
      driverId,
      zone: IST,
    }),
    totalsFor('driver_id = :driverId', { driverId }),
    dailyHistory(driverId),
  ]);

  return {
    // Until payouts exist nothing has been paid, so everything earned is
    // available and the pending figure is what review is holding.
    availableBalance: toPayable(money(lifetime.earnings)),
    pendingBalance: toPayable(money(lifetime.pendingEarnings)),
    monthVerifiedKm: asKm(month.billableKm),
    monthEarnings: toPayable(money(month.earnings)),
    todayVerifiedKm: asKm(today.billableKm),
    todayEarnings: toPayable(money(today.earnings)),
    history,
  };
}

/**
 * The last 30 days a driver earned on, newest first.
 *
 * Bucketed on the segment's own IST date rather than the session's, so a shift
 * that runs through midnight is filed as the two days it was driven on. That
 * also makes each row here the exact total {@link dayDetail} returns for the
 * same date — a driver who taps a row must not find the trips inside it adding
 * up to something else.
 *
 * `to_char` rather than returning a `date`: `pg` parses a bare `date` into a
 * JS `Date` at the *server's* midnight, which would undo the conversion this
 * query just did.
 */
async function dailyHistory(
  driverId: string,
): Promise<{ date: string; verifiedKm: number; earnings: Money }[]> {
  const rows = (await sequelize.query(
    `SELECT to_char(${istDate('started_at')}, 'YYYY-MM-DD') AS date,
            COALESCE(SUM(distance_km), 0)    AS km,
            COALESCE(SUM(driver_earning), 0) AS earnings
       FROM trip_segments
      WHERE driver_id = :driverId AND state = 'BILLABLE'
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 30`,
    { replacements: { driverId, zone: IST }, type: 'SELECT' },
  )) as { date: string; km: string; earnings: string }[];

  return rows.map((row) => ({
    date: row.date,
    verifiedKm: asKm(row.km),
    earnings: toPayable(money(row.earnings)),
  }));
}

// --- One day of trips ----------------------------------------------------

export type TripStatus = 'verified' | 'pending_review' | 'rejected';

export interface TripZoneTotal {
  zone: Zone;
  km: number;
  earnings: Money;
}

export interface TripView {
  /** The drive's first segment — see `drivesFrom` for why not an index. */
  id: string;
  /** Position within the day, counting from 1 — what the app labels the row. */
  sequence: number;
  startedAt: string;
  endedAt: string;
  verifiedKm: number;
  earnings: Money;
  status: TripStatus;
  /**
   * How long the vehicle stood still before this drive began, or null when it
   * is the first of its shift and there was nothing to wait through.
   */
  idleSecondsBefore: number | null;
  /** Null when nothing on this trip was billable, so there is nothing to split. */
  zoneBreakdown: TripZoneTotal[] | null;
}

export interface DayDetailView {
  date: string;
  totalVerifiedKm: number;
  totalEarnings: Money;
  trips: TripView[];
}

/** The same day with the advertiser side of it, which only operations may see. */
export interface AuditDayView extends DayDetailView {
  totalCharge: Money;
}

interface TripRow {
  /** The drive's first segment, which is what names the trip. See `drivesFrom`. */
  trip_id: string;
  session_id: string;
  started_at: Date;
  ended_at: Date;
  km: string;
  earnings: string;
  billable: string;
  pending: string;
  /** Seconds the vehicle stood still since the previous drive of this shift. */
  idle_seconds: number | null;
}

/**
 * A trip is a drive, not a shift.
 *
 * It used to be a tracking session: one press of Start to one press of Stop.
 * That is the unit the driver *operated*, but it is not the unit they
 * remember — a shift with an hour's break in the middle of it arrived as a
 * single row spanning both halves and the hour between, which answers none of
 * "when did I finish the morning run" or "how long was I waiting".
 *
 * The evidence for the split is already in the table and costs nothing to
 * read. A parked vehicle records no points, and `buildSegments` refuses to
 * bridge a pair more than `maxBridgeSeconds` apart rather than draw a straight
 * line through it (AC-20.8) — so no segment ever spans a stop, and the holes
 * between runs of segments are exactly the stops. All this does is decide
 * which holes were big enough to have been a destination.
 *
 * Nothing about money moves. The segments, their zones, their states and their
 * rupees are untouched; only the grouping over them changes, so a day total
 * cannot disagree with the trips that justify it however they are cut.
 *
 * Emits `anchored`: every in-scope segment carrying the `trip_id` of the drive
 * it belongs to. The scope is interpolated and must never be anything but a
 * literal from this module.
 *
 * `trip_id` is the drive's first segment rather than a synthesised index,
 * because an index only means anything within the query that produced it: the
 * day view filters to one civil day and would number a drive that began before
 * midnight differently from the feed, which does not filter at all. A segment
 * id survives both, and `driveOf` resolves it back without being told which
 * list it came from.
 *
 * It is carried on every row rather than aggregated per group so that callers
 * can filter by state *after* the split. Windowing over billable rows alone
 * would let a long held stretch in the middle of a drive open a gap that is
 * not there, and cut a journey the main list kept whole.
 */
function drivesFrom(scope: string): string {
  return `
    WITH marked AS (
      SELECT s.*,
             CASE
               WHEN lag(s.ended_at) OVER w IS NULL THEN 1
               WHEN s.started_at - lag(s.ended_at) OVER w
                    > make_interval(secs => :tripGapSeconds) THEN 1
               ELSE 0
             END AS breaks
        FROM trip_segments s
       WHERE ${scope}
      WINDOW w AS (PARTITION BY s.session_id ORDER BY s.started_at, s.part_index)
    ),
    numbered AS (
      SELECT m.*,
             SUM(m.breaks) OVER (PARTITION BY m.session_id
                                 ORDER BY m.started_at, m.part_index
                                 ROWS UNBOUNDED PRECEDING) AS drive
        FROM marked m
    ),
    anchored AS (
      SELECT n.*,
             first_value(n.id) OVER (PARTITION BY n.session_id, n.drive
                                     ORDER BY n.started_at, n.part_index) AS trip_id
        FROM numbered n
    )`;
}

/** The columns every trip list needs, one row per drive. */
const DRIVE_COLUMNS = `
  a.trip_id,
  a.session_id,
  min(a.started_at) AS started_at,
  max(a.ended_at)   AS ended_at,
  COALESCE(SUM(a.distance_km)    FILTER (WHERE a.state = 'BILLABLE'), 0) AS km,
  COALESCE(SUM(a.driver_earning) FILTER (WHERE a.state = 'BILLABLE'), 0) AS earnings,
  count(*) FILTER (WHERE a.state = 'BILLABLE')       AS billable,
  count(*) FILTER (WHERE a.state = 'PENDING_REVIEW') AS pending`;

/**
 * How long the vehicle stood still before each drive.
 *
 * Partitioned by session on purpose: the gap between the last drive of one
 * shift and the first of the next is not idle time, it is the driver being off
 * duty, and presenting fourteen hours asleep as waiting would be absurd. The
 * first drive of a shift therefore has no idle figure at all rather than a
 * zero, which would read as "started instantly".
 */
const IDLE_SECONDS = `
  EXTRACT(EPOCH FROM (
    g.started_at - lag(g.ended_at) OVER (PARTITION BY g.session_id ORDER BY g.started_at)
  ))::int AS idle_seconds`;

interface ZoneRow {
  trip_id: string;
  zone: SegmentZone;
  km: string;
  earnings: string;
}

/**
 * One civil day of one party's segments.
 *
 * The column is chosen from a closed set rather than passed through, because
 * it is interpolated into SQL: a driver asking about their own day and an
 * operator asking about a vehicle's are the same question of different
 * subjects, and nothing else may ever be substituted here.
 */
function dayScope(subject: 'driver_id' | 'vehicle_id'): string {
  return `${subject} = :subject AND ${istDate('started_at')} = :date::date`;
}

/**
 * Every trip a driver made on one civil day, and what each one earned.
 *
 * A trip is a drive: the ground covered between two stops, which is what a
 * driver recognises as one journey. It is not the session — a driver who works
 * all morning presses Start once — and it is not a segment either, of which
 * there are hundreds in an afternoon and none is an event anyone would name.
 * `drivesFrom` makes the cut; nothing about the money depends on it.
 *
 * A drive that runs through midnight appears on both days, carrying only the
 * segments driven on each, and its times are the first and last of those. The
 * alternative — filing the whole shift under the day it began — would make the
 * day total disagree with the money, which is bucketed by segment (AC-08.7).
 *
 * The three queries are the same scan under three groupings rather than one
 * result folded in Node: it keeps every rupee a `SUM` in Postgres, so the day
 * total cannot drift from the trips that justify it.
 */
export async function dayDetail(driverId: string, date: string): Promise<DayDetailView> {
  const day = await dayOf('driver_id', driverId, date);

  // Rebuilt field by field rather than spread: `AuditDayView` carries what the
  // advertiser is charged, and a driver must never be handed the platform's
  // margin because a future field was added to the wider type.
  return {
    date: day.date,
    totalVerifiedKm: day.totalVerifiedKm,
    totalEarnings: day.totalEarnings,
    trips: day.trips,
  };
}

/** The same day for a vehicle, whoever was driving it. */
export function vehicleDay(vehicleId: string, date: string): Promise<AuditDayView> {
  return dayOf('vehicle_id', vehicleId, date);
}

async function dayOf(
  subject: 'driver_id' | 'vehicle_id',
  id: string,
  date: string,
): Promise<AuditDayView> {
  const scope = dayScope(subject);
  const binds = {
    subject: id,
    date,
    zone: IST,
    tripGapSeconds: config.tracking.tripGapSeconds,
  };

  const [totals, trips, zones] = await Promise.all([
    totalsFor(scope, binds),

    sequelize.query<TripRow>(
      `${drivesFrom(scope)},
       grouped AS (
         SELECT ${DRIVE_COLUMNS}
           FROM anchored a
          GROUP BY a.trip_id, a.session_id
       )
       SELECT g.*, ${IDLE_SECONDS}
         FROM grouped g
        ORDER BY g.started_at`,
      { replacements: binds, type: QueryTypes.SELECT },
    ),

    // Only zones that actually earned: a row reading "Prime 0.0 km ₹0.00" is
    // not a breakdown, it is a distraction from the ones that paid.
    sequelize.query<ZoneRow>(
      `${drivesFrom(scope)}
       SELECT a.trip_id,
              a.zone,
              SUM(a.distance_km)    AS km,
              SUM(a.driver_earning) AS earnings
         FROM anchored a
        WHERE a.state = 'BILLABLE'
        GROUP BY a.trip_id, a.zone
       HAVING SUM(a.distance_km) > 0
        ORDER BY SUM(a.distance_km) DESC`,
      { replacements: binds, type: QueryTypes.SELECT },
    ),
  ]);

  const breakdowns = new Map<string, TripZoneTotal[]>();
  for (const row of zones) {
    const forTrip = breakdowns.get(row.trip_id) ?? [];
    forTrip.push({
      zone: row.zone.toLowerCase() as Zone,
      km: asKm(row.km),
      earnings: toPayable(money(row.earnings)),
    });
    breakdowns.set(row.trip_id, forTrip);
  }

  return {
    date,
    totalVerifiedKm: asKm(totals.billableKm),
    totalEarnings: toPayable(money(totals.earnings)),
    totalCharge: toLedger(money(totals.charge)),
    trips: trips.map((row, index) => ({
      id: row.trip_id,
      sequence: index + 1,
      startedAt: row.started_at.toISOString(),
      endedAt: row.ended_at.toISOString(),
      verifiedKm: asKm(row.km),
      earnings: toPayable(money(row.earnings)),
      status: statusOf(row),
      idleSecondsBefore: row.idle_seconds,
      zoneBreakdown: breakdowns.get(row.trip_id) ?? null,
    })),
  };
}

// --- The driver's own trip feed ------------------------------------------

export interface RecentTripView {
  id: string;
  /** The campaign the livery was carrying, which is what names the trip. */
  campaignName: string;
  startedAt: string;
  endedAt: string;
  verifiedKm: number;
  earnings: Money;
  status: TripStatus;
  /**
   * How long the vehicle stood still before this drive began, or null when it
   * is the first of its shift and there was nothing to wait through.
   */
  idleSecondsBefore: number | null;
}

export interface RecentTripsView {
  trips: RecentTripView[];
  /**
   * Cursor for the next page, or null at the end. The start time of the oldest
   * trip returned, so the next request asks for everything before it.
   */
  nextBefore: string | null;
}

interface RecentTripRow extends TripRow {
  campaign_name: string;
}

/** Enough for a long scroll, bounded so one request cannot ask for a year. */
const MAX_TRIP_PAGE = 50;

/**
 * Recent trips across days, newest first.
 *
 * The day-bucketed history answers "what did I earn on Tuesday"; this answers
 * "what have I been doing", which is the question a driver opening the app
 * actually has. Both are sums over the same segments, so they cannot disagree.
 *
 * Unlike the earnings history, a trip that earned nothing is included. A shift
 * that was refused, or is still being reviewed, is a thing the driver did and
 * has a reason attached to it; leaving it out of the list is how a driver
 * comes to believe the app lost a morning's work.
 *
 * Paged on the trip's own start time rather than an offset, because the feed
 * grows at the top while it is being read and an offset would show the same
 * trip twice.
 */
export async function recentTrips(
  driverId: string,
  options: { limit?: number; before?: string | null } = {},
): Promise<RecentTripsView> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), MAX_TRIP_PAGE);
  const before = options.before ?? null;

  /*
   * The idle figure is computed before the page is cut, not after.
   *
   * It is the gap to the drive before this one, and at a page boundary that
   * drive is on the next page — so filtering first would leave the top row of
   * every page but the first claiming it had no wait, purely because of where
   * the page happened to end.
   */
  const rows = await sequelize.query<RecentTripRow>(
    `${drivesFrom('s.driver_id = :driverId')},
     grouped AS (
       SELECT ${DRIVE_COLUMNS}, a.campaign_id
         FROM anchored a
        GROUP BY a.trip_id, a.session_id, a.campaign_id
     ),
     paged AS (
       SELECT g.*, c.name AS campaign_name, ${IDLE_SECONDS}
         FROM grouped g
         JOIN campaigns c ON c.id = g.campaign_id
     )
     SELECT * FROM paged
      WHERE :before::timestamptz IS NULL OR started_at < :before::timestamptz
      ORDER BY started_at DESC
      LIMIT :limit`,
    {
      replacements: {
        driverId,
        before,
        limit,
        tripGapSeconds: config.tracking.tripGapSeconds,
      },
      type: QueryTypes.SELECT,
    },
  );

  const trips = rows.map((row) => ({
    id: row.trip_id,
    campaignName: row.campaign_name,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at.toISOString(),
    verifiedKm: asKm(row.km),
    earnings: toPayable(money(row.earnings)),
    status: statusOf(row),
    idleSecondsBefore: row.idle_seconds,
  }));

  // Only when the page was filled. A short page is the end of the feed, and
  // offering a cursor there costs the phone a round trip to learn nothing.
  const last = trips.length === limit ? trips.at(-1) : undefined;

  return { trips, nextBefore: last?.startedAt ?? null };
}

/**
 * A trip holding anything in review reads as in review, even where most of it
 * cleared. The badge answers "is this figure final?", and for a mixed trip the
 * honest answer is no — the earnings shown are only the part that settled.
 */
function statusOf(counts: { billable: string; pending: string }): TripStatus {
  if (Number(counts.pending) > 0) return 'pending_review';
  return Number(counts.billable) > 0 ? 'verified' : 'rejected';
}

// --- One trip, opened up (AC-25, AC-21.8) --------------------------------

export interface TripLeg {
  zone: Zone;
  state: SegmentState;
  /** Why this run earns nothing yet. Null unless it is held. */
  flagReason: string | null;
  startedAt: string;
  endedAt: string;
  distanceKm: number;
  advertiserRate: Money;
  driverRate: Money;
  advertiserCharge: Money;
  driverEarning: Money;
  /** How many priced segments were merged into this run. */
  segments: number;
  /** The line to draw, in order. */
  path: LatLng[];
}

export interface TripDetailView {
  id: string;
  vehicleRegistration: string;
  campaignName: string;
  driverName: string;
  startedAt: string;
  endedAt: string | null;
  distanceKm: number;
  advertiserCharge: Money;
  driverEarning: Money;
  legs: TripLeg[];
}

interface SegmentRow {
  id: string;
  zone: SegmentZone;
  state: SegmentState;
  flag_reason: string | null;
  started_at: Date;
  ended_at: Date;
  distance_km: string;
  advertiser_rate: Money;
  driver_rate: Money;
  advertiser_charge: Money;
  driver_earning: Money;
  from_point_id: string;
  from_lat: string;
  from_lon: string;
  to_lat: string;
  to_lon: string;
}

/**
 * One trip with the priced ground underneath it — the screen AC-25 asks for,
 * and the only way AC-21.8's zone splits become inspectable.
 *
 * Returned as *runs* rather than raw segments. A segment is one pair of GPS
 * fixes, three seconds apart; an afternoon is thousands of them, and a table
 * of thousands of identical rows answers no question anyone has. Consecutive
 * segments agreeing on zone, state and reason are the same fact about the
 * journey, so they are merged and counted.
 */
export async function tripDetail(tripId: string): Promise<TripDetailView> {
  const anchor = await TripSegment.findByPk(tripId);
  if (!anchor) throw new NotFoundError('Trip');

  const [campaign, vehicle, driver, rows] = await Promise.all([
    Campaign.findByPk(anchor.campaignId),
    Vehicle.findByPk(anchor.vehicleId),
    Driver.findByPk(anchor.driverId),
    segmentsOf(anchor.sessionId),
  ]);

  const drive = driveOf(rows, tripId);
  if (!drive) throw new NotFoundError('Trip');

  const totals = totalsOf(drive);

  return {
    id: totals.id,
    vehicleRegistration: vehicle?.registrationNumber ?? '',
    campaignName: campaign?.name ?? '',
    driverName: driver?.name ?? '',
    startedAt: totals.startedAt,
    endedAt: totals.endedAt,
    distanceKm: totals.verifiedKm,
    advertiserCharge: toLedger(sum(totals.billable.map((row) => row.advertiser_charge))),
    driverEarning: totals.earnings,
    legs: intoLegs(drive),
  };
}

/**
 * One drive's own figures, summed over its segments rather than its session.
 *
 * The list queries do this in Postgres, deliberately, so a day total cannot
 * drift from the rows under it. There is no such invariant to protect here —
 * a detail answers only for itself — and `toLeg` already sums the same columns
 * the same way a few lines below, so doing it twice over would be the drift.
 */
function totalsOf(drive: SegmentRow[]) {
  // Non-null: `driveOf` never returns an empty drive.
  const first = drive[0] as SegmentRow;
  const last = drive.at(-1) as SegmentRow;
  const billable = drive.filter((row) => row.state === 'BILLABLE');

  return {
    id: first.id,
    startedAt: first.started_at.toISOString(),
    endedAt: last.ended_at.toISOString(),
    billable,
    verifiedKm: asKm(toLedger(sum(billable.map((row) => row.distance_km)))),
    earnings: toPayable(sum(billable.map((row) => row.driver_earning))),
    status: statusOf({
      billable: String(billable.length),
      pending: String(drive.filter((row) => row.state === 'PENDING_REVIEW').length),
    }),
  };
}

/** Every priced part of one session, in the order it was driven. */
function segmentsOf(sessionId: string): Promise<SegmentRow[]> {
  return sequelize.query<SegmentRow>(
    `SELECT s.id, s.zone, s.state, s.flag_reason, s.started_at, s.ended_at, s.distance_km,
            s.advertiser_rate, s.driver_rate, s.advertiser_charge, s.driver_earning,
            s.from_point_id,
            f.lat AS from_lat, f.lon AS from_lon,
            t.lat AS to_lat,   t.lon AS to_lon
       FROM trip_segments s
       JOIN gps_points f ON f.id = s.from_point_id
       JOIN gps_points t ON t.id = s.to_point_id
      WHERE s.session_id = :sessionId
      ORDER BY s.started_at, s.part_index`,
    { replacements: { sessionId }, type: QueryTypes.SELECT },
  );
}

interface PlacedSegment extends SegmentRow {
  from: LatLng;
  to: LatLng;
}

/**
 * The one drive a trip id names, out of the shift it was part of.
 *
 * The same cut `drivesFrom` makes in SQL, made again here over a session's
 * segments, because a trip id has to resolve to the same drive whichever list
 * it was tapped in — and the day list cuts its rows at midnight while the feed
 * does not. Resolving over the whole session rather than the list's slice is
 * what makes the two agree, and it matches what a session detail has always
 * done: the list shows the day's portion, the detail shows the drive.
 *
 * Returns null when the id is not a segment of this session, which is the same
 * answer as "no such trip".
 */
function driveOf(rows: SegmentRow[], tripId: string): SegmentRow[] | null {
  const gapMs = config.tracking.tripGapSeconds * 1000;
  const drives: SegmentRow[][] = [];

  for (const segment of rows) {
    const current = drives.at(-1);
    const previous = current?.at(-1);
    const parked =
      previous && segment.started_at.getTime() - previous.ended_at.getTime() > gapMs;

    if (!current || parked) drives.push([segment]);
    else current.push(segment);
  }

  return drives.find((drive) => drive.some((segment) => segment.id === tripId)) ?? null;
}

/**
 * Where each priced part actually ran.
 *
 * The clipped coordinates are not in the database: a pair of fixes crossing a
 * boundary is stored as several parts sharing that one pair, each carrying
 * only its own distance. The crossing is recovered by walking the straight
 * line between the two fixes by cumulative distance, which is exact — that
 * straight line is what the pipeline clipped in the first place (AC-21).
 *
 * This has to happen before the parts are grouped into runs. A part's offset
 * is a fraction of the pair it was cut from, and a pair that crosses a
 * boundary is split across two runs by definition, so a run on its own no
 * longer knows what it is a fraction of.
 */
function place(rows: SegmentRow[]): PlacedSegment[] {
  const placed: PlacedSegment[] = [];

  for (const [, parts] of groupConsecutive(rows, (part) => part.from_point_id)) {
    // Non-null: `groupConsecutive` never emits an empty group.
    const head = parts[0] as SegmentRow;
    const from = { lat: Number(head.from_lat), lng: Number(head.from_lon) };
    const to = { lat: Number(head.to_lat), lng: Number(head.to_lon) };
    const total = parts.reduce((metres, part) => metres + Number(part.distance_km), 0);

    let travelled = 0;
    for (const part of parts) {
      const start = total > 0 ? along(from, to, travelled / total) : from;
      travelled += Number(part.distance_km);
      const end = total > 0 ? along(from, to, travelled / total) : to;
      placed.push({ ...part, from: start, to: end });
    }
  }

  return placed;
}

/** Consecutive segments that say the same thing about the journey. */
function sameRun(a: SegmentRow, b: SegmentRow): boolean {
  return a.zone === b.zone && a.state === b.state && a.flag_reason === b.flag_reason;
}

function intoLegs(rows: SegmentRow[]): TripLeg[] {
  const legs: TripLeg[] = [];
  let run: PlacedSegment[] = [];

  const flush = () => {
    if (run.length > 0) legs.push(toLeg(run));
    run = [];
  };

  for (const segment of place(rows)) {
    const previous = run.at(-1);
    if (previous && !sameRun(previous, segment)) flush();
    run.push(segment);
  }
  flush();

  return legs;
}

function toLeg(run: PlacedSegment[]): TripLeg {
  // Non-null: `intoLegs` never flushes an empty run.
  const first = run[0] as PlacedSegment;
  const last = run.at(-1) as PlacedSegment;

  return {
    zone: first.zone.toLowerCase() as Zone,
    state: first.state,
    flagReason: first.flag_reason,
    startedAt: first.started_at.toISOString(),
    endedAt: last.ended_at.toISOString(),
    distanceKm: asKm(toLedger(sum(run.map((part) => part.distance_km)))),
    advertiserRate: first.advertiser_rate,
    driverRate: first.driver_rate,
    advertiserCharge: toLedger(sum(run.map((part) => part.advertiser_charge))),
    driverEarning: toPayable(sum(run.map((part) => part.driver_earning))),
    segments: run.length,
    // Each part ends where the next begins, so the line is the run's start
    // followed by every end — no point repeated, no gap introduced.
    path: [first.from, ...run.map((part) => part.to)],
  };
}

function along(from: LatLng, to: LatLng, fraction: number): LatLng {
  return {
    lat: from.lat + (to.lat - from.lat) * fraction,
    lng: from.lng + (to.lng - from.lng) * fraction,
  };
}

// --- The same trip, for the driver who drove it -------------------------

export interface DriverTripLeg {
  zone: Zone;
  state: SegmentState;
  /** Why this stretch has not been paid. Null unless it is held or refused. */
  flagReason: string | null;
  startedAt: string;
  endedAt: string;
  distanceKm: number;
  earnings: Money;
  path: LatLng[];
}

export interface DriverTripView {
  id: string;
  campaignName: string;
  startedAt: string;
  endedAt: string | null;
  verifiedKm: number;
  earnings: Money;
  status: TripStatus;
  legs: DriverTripLeg[];
}

/**
 * Where one of the driver's own trips actually went (AC-21.8, AC-24).
 *
 * The same runs the audit screen shows an operator, with the advertiser's side
 * of every one of them removed. What the platform charges for a kilometre is
 * not the driver's business and is not merely omitted from the response — the
 * legs are rebuilt field by field, so a field added to `TripLeg` later cannot
 * arrive on a phone by inheritance.
 *
 * Refused and held stretches are included rather than filtered out. A driver
 * who can see 26 km on the map and 24 km on the total is owed the two
 * kilometres in between, and where they were.
 */
export async function driverTrip(driverId: string, tripId: string): Promise<DriverTripView> {
  const anchor = await TripSegment.findByPk(tripId);

  // One answer for "no such trip" and "not yours". Telling the two apart would
  // let any driver test whether a trip id exists.
  if (!anchor || anchor.driverId !== driverId) throw new NotFoundError('Trip');

  const [campaign, rows] = await Promise.all([
    Campaign.findByPk(anchor.campaignId),
    segmentsOf(anchor.sessionId),
  ]);

  const drive = driveOf(rows, tripId);
  if (!drive) throw new NotFoundError('Trip');

  const totals = totalsOf(drive);

  return {
    id: totals.id,
    campaignName: campaign?.name ?? '',
    startedAt: totals.startedAt,
    endedAt: totals.endedAt,
    verifiedKm: totals.verifiedKm,
    earnings: totals.earnings,
    status: totals.status,
    legs: intoLegs(drive).map((leg) => ({
      zone: leg.zone,
      state: leg.state,
      flagReason: leg.flagReason,
      startedAt: leg.startedAt,
      endedAt: leg.endedAt,
      distanceKm: leg.distanceKm,
      earnings: leg.driverEarning,
      path: leg.path,
    })),
  };
}

function groupConsecutive<T, K>(items: T[], key: (item: T) => K): [K, T[]][] {
  const groups: [K, T[]][] = [];

  for (const item of items) {
    const last = groups.at(-1);
    if (last && last[0] === key(item)) last[1].push(item);
    else groups.push([key(item), [item]]);
  }

  return groups;
}

/** What a campaign has actually had driven for it, and what that costs. */
export async function campaignTotals(
  campaignId: string,
): Promise<{ verifiedKm: number; spend: Money }> {
  const totals = await totalsFor('campaign_id = :campaignId', { campaignId });
  return { verifiedKm: asKm(totals.billableKm), spend: toLedger(money(totals.charge)) };
}

/** The same, for many campaigns at once, so a list is one query. */
export async function campaignTotalsFor(
  campaignIds: string[],
): Promise<Map<string, { verifiedKm: number; spend: Money }>> {
  const totals = new Map<string, { verifiedKm: number; spend: Money }>();
  if (campaignIds.length === 0) return totals;

  const rows = (await sequelize.query(
    `SELECT campaign_id,
            COALESCE(SUM(distance_km), 0)       AS km,
            COALESCE(SUM(advertiser_charge), 0) AS charge
       FROM trip_segments
      WHERE campaign_id IN (:campaignIds) AND state = 'BILLABLE'
      GROUP BY campaign_id`,
    { replacements: { campaignIds }, type: 'SELECT' },
  )) as { campaign_id: string; km: string; charge: string }[];

  for (const row of rows) {
    totals.set(row.campaign_id, {
      verifiedKm: asKm(row.km),
      spend: toLedger(money(row.charge)),
    });
  }
  return totals;
}

/** Verified kilometres a driver has run on one campaign, for their own screen. */
export async function achievedKmFor(input: {
  driverId: string;
  campaignId: string;
}): Promise<number> {
  const totals = await totalsFor('driver_id = :driverId AND campaign_id = :campaignId', input);
  return asKm(totals.billableKm);
}
