import { amountFor, type Money } from '../../pricing/money';
import { ADVERTISER_RATE, DRIVER_RATE, type PricingZone } from '../../pricing/rates';
import { config } from '../../shared/config';
import { haversineKm, splitSegmentByZone, type ZonePolygons } from '../../shared/geo';

import type { GpsQuality, SegmentState, SegmentZone } from './tracking.model';

/**
 * Raw fixes in, priced segments out.
 *
 * Everything here is a pure function of its arguments. That is the point:
 * AC-12.6 requires the same GPS to produce the same distance every time, and
 * AC-00 requires every rupee to be explainable from the points behind it — so
 * a reviewer looking at a disputed kilometre a month later has to be able to
 * re-run this over the stored fixes and get the identical answer, without a
 * database, a clock, or a queue in the way.
 */

/**
 * AC-11.1 — how good a fix has to be before it can carry money.
 *
 * Three outcomes rather than two, because "not good enough to bill" and "good
 * enough to throw away" are different claims. A 60-metre fix in a street of
 * tall buildings is probably a real vehicle in roughly the right place; it
 * should not be paid automatically and it should not be silently discarded
 * either, so it is held for a person to look at (AC-11.4).
 */
export function qualityOf(accuracyM: number): GpsQuality {
  if (accuracyM <= config.tracking.eligibleAccuracyM) return 'ELIGIBLE';
  if (accuracyM <= config.tracking.rejectAccuracyM) return 'QUESTIONABLE';
  return 'REJECTED';
}

export interface PipelineFix {
  id: string;
  recordedAt: Date;
  lat: number;
  lon: number;
  accuracyM: number;
  isMock: boolean;
  quality: GpsQuality;
}

export interface BuiltSegment {
  fromPointId: string;
  toPointId: string;
  partIndex: number;
  startedAt: Date;
  endedAt: Date;
  distanceKm: string;
  zone: SegmentZone;
  state: SegmentState;
  advertiserRate: Money;
  driverRate: Money;
  advertiserCharge: Money;
  driverEarning: Money;
  bridged: boolean;
  flagReason: string | null;
}

const ZONE_NAME: Record<PricingZone, SegmentZone> = {
  prime: 'PRIME',
  secondary: 'SECONDARY',
  network: 'NETWORK',
};

/**
 * Why this pair of fixes cannot be paid automatically, or null if it can.
 *
 * These are the AC-18 signals that fall out of the trace itself. Anything
 * needing a second session, a second device or a sensor the phone did not send
 * is not decidable here and belongs to a job that can see across sessions.
 */
function heldBecause(
  from: PipelineFix,
  to: PipelineFix,
  distanceKm: number,
  seconds: number,
): string | null {
  if (from.isMock || to.isMock) {
    return 'The handset reported a mock location for part of this movement.';
  }

  if (from.quality === 'QUESTIONABLE' || to.quality === 'QUESTIONABLE') {
    const worst = Math.max(from.accuracyM, to.accuracyM);
    return `GPS accuracy reached ${Math.round(worst)} m, outside the ${config.tracking.eligibleAccuracyM} m needed to bill without review.`;
  }

  // AC-18: displacement that no road vehicle could have covered. Measured from
  // the trace rather than from the speed the handset claims, because the claim
  // is as forgeable as the position.
  if (seconds > 0) {
    const impliedKmh = (distanceKm / seconds) * 3600;
    if (impliedKmh > config.tracking.maxPlausibleKmh) {
      return `Implied speed of ${Math.round(impliedKmh)} km/h over ${Math.round(seconds)} s is not plausible for a road vehicle.`;
    }
  }

  return null;
}

export interface BuildInput {
  /** In recorded order. Rejected fixes are expected to be present. */
  fixes: PipelineFix[];
  polygons: ZonePolygons;
  /**
   * AC-07.3 — whether the eligibility conditions held for this stretch of
   * driving.
   *
   * Re-evaluated per batch rather than trusted from session start, because a
   * campaign can be paused or a wrap reported damaged mid-shift and AC-07.4
   * stops the meter from that moment.
   */
  billable: boolean;
  /** Why not, when `billable` is false. Recorded, never releasable. */
  notBillableReason: string | null;
}

/**
 * Pair up the fixes and price what happened between them.
 *
 * Rejected fixes (AC-11.3) contribute no distance of their own but do not
 * break the chain: the pair spanning one is measured end to end and marked
 * `bridged`, which is the choice AC-12.3 requires to be made once and recorded
 * on the segment rather than decided case by case.
 *
 * That bridging stops at `maxBridgeSeconds`. Beyond it the gap is a hole in
 * the trace rather than a moment of poor reception, and joining its ends would
 * be inventing a straight line through however many turns the vehicle actually
 * made — the back-filling AC-20.8 forbids. The distance is dropped instead:
 * the driver is not paid for it, and nothing pretends to know what it was.
 */
export function buildSegments(input: BuildInput): BuiltSegment[] {
  const usable = input.fixes
    .filter((fix) => fix.quality !== 'REJECTED')
    .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());

  const segments: BuiltSegment[] = [];

  for (let i = 0; i < usable.length - 1; i += 1) {
    const from = usable[i] as PipelineFix;
    const to = usable[i + 1] as PipelineFix;

    const seconds = (to.recordedAt.getTime() - from.recordedAt.getTime()) / 1000;
    if (seconds <= 0 || seconds > config.tracking.maxBridgeSeconds) continue;

    const distanceKm = haversineKm(
      { lat: from.lat, lng: from.lon },
      { lat: to.lat, lng: to.lon },
    );
    if (distanceKm === 0) continue;

    // A fix was thrown away between these two, so this pair spans it.
    const bridged = input.fixes.some(
      (fix) =>
        fix.quality === 'REJECTED' &&
        fix.recordedAt > from.recordedAt &&
        fix.recordedAt < to.recordedAt,
    );

    const held = heldBecause(from, to, distanceKm, seconds);

    /*
     * Ineligibility outranks a review flag, and does so deliberately.
     *
     * A held kilometre is one a reviewer may release. A kilometre driven while
     * the campaign was paused or the wrap was off is one that AC-07.7 says no
     * override may ever make billable — so it must not be filed as something
     * awaiting a decision, or the review queue becomes a way of granting what
     * the rule refuses.
     */
    const state: SegmentState = !input.billable
      ? 'NON_BILLABLE'
      : held
        ? 'PENDING_REVIEW'
        : 'BILLABLE';

    const reason = !input.billable ? input.notBillableReason : held;

    const parts = splitSegmentByZone(
      { lat: from.lat, lng: from.lon },
      { lat: to.lat, lng: to.lon },
      input.polygons,
    );

    // Time is apportioned by distance so each part carries the stretch of the
    // clock it was actually driven in, and the parts still meet end to end.
    let elapsed = 0;
    parts.forEach((part, index) => {
      const share = part.distanceKm / distanceKm;
      const startedAt = new Date(from.recordedAt.getTime() + elapsed * seconds * 1000);
      elapsed += share;
      const endedAt =
        index === parts.length - 1
          ? to.recordedAt
          : new Date(from.recordedAt.getTime() + elapsed * seconds * 1000);

      const zone = part.zone;
      const km = part.distanceKm.toFixed(6);
      const advertiserRate = ADVERTISER_RATE[zone];
      const driverRate = DRIVER_RATE[zone];
      const earns = state === 'BILLABLE';

      segments.push({
        fromPointId: from.id,
        toPointId: to.id,
        partIndex: index,
        startedAt,
        endedAt,
        distanceKm: km,
        zone: ZONE_NAME[zone],
        state,
        // The rate is stamped on even when nothing is owed, so a released
        // kilometre is priced at what it was worth when it was driven rather
        // than at whatever the rate has become by review time (AC-14.4).
        advertiserRate,
        driverRate,
        advertiserCharge: earns ? amountFor(km, advertiserRate) : '0.0000',
        driverEarning: earns ? amountFor(km, driverRate) : '0.0000',
        bridged,
        flagReason: state === 'BILLABLE' ? null : reason,
      });
    });
  }

  return segments;
}
