/**
 * What the impression model assumes about the world.
 *
 * The companion to `src/pricing/rates.ts`, and deliberately shaped like it:
 * one table, platform-fixed, not advertiser-editable, and stamped onto every
 * figure it produces. The difference is that rates are a commercial decision
 * and these are an empirical claim — which is why they carry a version and the
 * rates do not.
 *
 * A version is never edited in place. Improving the model means adding a new
 * entry below and recomputing into it, leaving every number already shown to
 * an advertiser exactly as it was shown. Money must never be restated and is
 * not restated; a modelled figure may be, but only visibly, and only as a
 * number someone chose to move to.
 *
 * The values themselves are not yet calibrated. `docs/impressions-and-audience.md`
 * sets out where each comes from and what it would take to earn it — the two
 * that most need a real measurement behind them are `lineOfSightShare` and the
 * per-zone `pedestrianDensity`.
 */

/** Structurally the same union as `SegmentZone`, kept here so this stays a leaf. */
export type ImpressionZone = 'PRIME' | 'SECONDARY' | 'NETWORK';

export interface ZoneAssumptions {
  /**
   * Lanes of traffic within viewing range of a vehicle in this zone, counting
   * both directions.
   *
   * A per-zone constant standing in for a per-cell figure. OpenStreetMap knows
   * the real lane count for most Indian arterials and importing it is the
   * obvious next improvement; until then a zone is the only thing the platform
   * knows about where a vehicle was.
   */
  lanes: number;

  /**
   * People on foot per kilometre of road.
   *
   * The one input with no principled derivation and no way to get one from a
   * fleet of cars, so it is an operations assumption and is labelled as such
   * wherever it surfaces. It is also the smallest term in the sum, which is
   * the right place for the least defensible number to sit.
   */
  pedestrianDensity: number;
}

export interface DaypartAssumptions {
  /** Inclusive hour-of-day bounds in IST. Anything outside both is night. */
  daylightFromHour: number;
  daylightToHour: number;
  duskToHour: number;

  daylightFactor: number;
  duskFactor: number;
  nightFactor: number;
}

export interface Coefficients {
  /**
   * Vehicles in a kilometre of one lane, bumper to bumper.
   *
   * Near enough a physical constant: it is a function of how long vehicles are
   * and how little space they leave. Higher here than a Western figure would
   * be, because two-wheelers fill the gaps.
   */
  jamDensity: number;

  /** Mean occupants per vehicle across the traffic mix, not per cab. */
  occupantsPerVehicle: number;

  /**
   * The share of people present who could see the wrap at all.
   *
   * Geometry, not wrap quality: traffic ahead of the vehicle and lanes facing
   * away from it see nothing however good the print is. Held apart from
   * `wrapQuality` because collapsing the two produces a single number around
   * 0.25 that nobody can derive, defend, or argue with — and being argued with
   * is the point of publishing the method.
   */
  lineOfSightShare: number;

  /**
   * How legible the wrap is, for those who can see it.
   *
   * A property of the vehicle and the coverage it carries — a full wrap
   * against a door decal. A platform-wide constant only because
   * `installations` does not record wrap coverage yet; when it does, this
   * becomes a per-installation lookup and this constant becomes its default.
   */
  wrapQuality: number;

  daypart: DaypartAssumptions;
  zones: Record<ImpressionZone, ZoneAssumptions>;
}

const V1: Coefficients = {
  jamDensity: 150,
  occupantsPerVehicle: 1.5,
  lineOfSightShare: 0.3,
  wrapQuality: 0.85,

  daypart: {
    daylightFromHour: 6,
    daylightToHour: 17,
    duskToHour: 19,
    daylightFactor: 1,
    duskFactor: 0.75,
    // Not zero: Indian arterials are lit, and a wrapped vehicle under street
    // lighting is still seen. Less than half as well, though.
    nightFactor: 0.45,
  },

  zones: {
    PRIME: { lanes: 4, pedestrianDensity: 120 },
    SECONDARY: { lanes: 3, pedestrianDensity: 50 },
    NETWORK: { lanes: 2, pedestrianDensity: 15 },
  },
};

/** What new work is computed under. Reading is always by explicit version. */
export const CURRENT_MODEL_VERSION = 'v1.0.0';

const VERSIONS: Readonly<Record<string, Coefficients>> = {
  'v1.0.0': V1,
};

/**
 * Throws on an unknown version rather than falling back to the current one.
 *
 * A campaign pins the version it was sold on. If that version has gone
 * missing, the honest outcome is a loud failure — quietly re-pricing the
 * campaign's audience against a newer model is the one thing the versioning
 * exists to prevent.
 */
export function coefficientsFor(version: string): Coefficients {
  const found = VERSIONS[version];
  if (!found) throw new Error(`Unknown impression model version: ${version}`);
  return found;
}

export function knownModelVersions(): string[] {
  return Object.keys(VERSIONS);
}
