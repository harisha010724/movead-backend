import type { Coefficients, ImpressionZone } from './coefficients';

/**
 * A kilometre of driving, expressed as an audience.
 *
 * Pure, for the same reason `tracking.pipeline` is pure: a number an
 * advertiser is invoiced alongside has to be reproducible from the segment
 * behind it, months later, without a database or a clock in the way. Every
 * input arrives as an argument and every intermediate value comes back out, so
 * a disputed figure can be taken apart rather than recomputed and compared.
 *
 * The model is deliberately not a black box with a good number in it. It is a
 * chain of multipliers, each of which someone can disagree with individually —
 * which is the only form of a modelled figure that survives being audited.
 */

export interface ImpressionInput {
  distanceKm: number;
  /** Derived from the segment's own distance and duration, never the handset. */
  observedKmh: number;
  /** Free-flow reference for this cell and hour, from `traffic.service`. */
  baselineKmh: number;
  /** Hour of day in IST, 0–23. */
  hourOfDay: number;
  zone: ImpressionZone;
}

export interface ImpressionBreakdown {
  impressions: number;

  vehiclesPerLaneKm: number;
  vehiclesPerKm: number;
  inVehiclePersonsPerKm: number;
  pedestrianDensity: number;
  personsPresentPerKm: number;

  lineOfSightShare: number;
  wrapQuality: number;
  daypartFactor: number;

  /** Effective impressions per kilometre, before distance is applied. */
  perKm: number;
}

/**
 * How much of the audience is awake to a wrap at this hour.
 *
 * Three bands rather than a curve. A smooth function would imply a precision
 * the underlying claim does not have, and would need twenty-four numbers
 * nobody could defend individually instead of three that can be argued about
 * as a group.
 */
export function daypartFactorFor(hourOfDay: number, coefficients: Coefficients): number {
  const { daypart } = coefficients;

  if (hourOfDay >= daypart.daylightFromHour && hourOfDay <= daypart.daylightToHour) {
    return daypart.daylightFactor;
  }

  if (hourOfDay > daypart.daylightToHour && hourOfDay <= daypart.duskToHour) {
    return daypart.duskFactor;
  }

  return daypart.nightFactor;
}

/**
 * Vehicles sharing this stretch of road, from how far below free-flow it was
 * being driven.
 *
 * Greenshields' relation: speed falls linearly as density rises, so density is
 * recoverable from speed given the free-flow reference and the jam density.
 * It is the crudest of the standard speed-density models — Greenberg and
 * Underwood fit observed data better at the extremes — and it is the right one
 * here, because its single parameter is one that can be defended from a
 * photograph and the others are fitted.
 *
 * Note what this makes of congestion: it is not a correction applied to a
 * separate density figure, it *is* the density measurement. Treating the two
 * as independent factors and multiplying them, as an earlier draft of the
 * strategy did, counts the same physical fact twice.
 */
export function vehiclesPerLaneKm(
  observedKmh: number,
  baselineKmh: number,
  jamDensity: number,
): number {
  // A missing or nonsensical baseline means no measurement, not empty roads;
  // the caller's fallback ladder is what stops this being reached in practice.
  if (baselineKmh <= 0) return 0;

  // Above the baseline is an empty road, not negative traffic.
  const congestion = Math.max(0, 1 - observedKmh / baselineKmh);

  return jamDensity * congestion;
}

export function impressionsFor(
  input: ImpressionInput,
  coefficients: Coefficients,
): ImpressionBreakdown {
  const zone = coefficients.zones[input.zone];

  const perLaneKm = vehiclesPerLaneKm(
    input.observedKmh,
    input.baselineKmh,
    coefficients.jamDensity,
  );

  const vehicles = perLaneKm * zone.lanes;
  const inVehicle = vehicles * coefficients.occupantsPerVehicle;

  // Pedestrians are added, not multiplied: they are on the road whether or not
  // it is jammed, and a free-flowing street is not an empty pavement.
  const present = inVehicle + zone.pedestrianDensity;

  const daypartFactor = daypartFactorFor(input.hourOfDay, coefficients);
  const perKm = present * coefficients.lineOfSightShare * coefficients.wrapQuality * daypartFactor;

  return {
    impressions: perKm * Math.max(0, input.distanceKm),
    vehiclesPerLaneKm: perLaneKm,
    vehiclesPerKm: vehicles,
    inVehiclePersonsPerKm: inVehicle,
    pedestrianDensity: zone.pedestrianDensity,
    personsPresentPerKm: present,
    lineOfSightShare: coefficients.lineOfSightShare,
    wrapQuality: coefficients.wrapQuality,
    daypartFactor,
    perKm,
  };
}
