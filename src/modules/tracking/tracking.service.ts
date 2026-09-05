import { Op, type Transaction } from 'sequelize';

import { sequelize } from '../../db/sequelize';
import { money, toLedger, toPayable, type Money } from '../../pricing/money';
import { config } from '../../shared/config';
import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors';
import type { LatLng, ZonePolygons } from '../../shared/geo';
import { Campaign } from '../campaigns/campaigns.model';
import { Vehicle } from '../drivers/drivers.model';
import { eligibility } from '../installations/eligibility';
import { CampaignVehicle, LIVE_ASSIGNMENT } from '../installations/installations.model';

import { GpsPoint, TrackingSession, TripSegment } from './tracking.model';
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
    totalsFor("driver_id = :driverId AND started_at >= date_trunc('day', now())", { driverId }),
    totalsFor("driver_id = :driverId AND started_at >= date_trunc('month', now())", { driverId }),
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

async function dailyHistory(
  driverId: string,
): Promise<{ date: string; verifiedKm: number; earnings: Money }[]> {
  const rows = (await sequelize.query(
    `SELECT to_char(date_trunc('day', started_at), 'YYYY-MM-DD') AS date,
            COALESCE(SUM(distance_km), 0)    AS km,
            COALESCE(SUM(driver_earning), 0) AS earnings
       FROM trip_segments
      WHERE driver_id = :driverId AND state = 'BILLABLE'
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 30`,
    { replacements: { driverId }, type: 'SELECT' },
  )) as { date: string; km: string; earnings: string }[];

  return rows.map((row) => ({
    date: row.date,
    verifiedKm: asKm(row.km),
    earnings: toPayable(money(row.earnings)),
  }));
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
