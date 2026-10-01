/**
 * How readable a wrap was, read from the vehicle's own GPS.
 *
 * The companion to `src/impressions/coefficients.ts`: one table, platform-fixed,
 * not advertiser-editable, and stamped onto every figure it produces. The
 * difference is that impressions model an audience; this only bands the speed
 * the fleet already measured. Neither is a billing input — verified kilometres
 * stay the unit the contract is written in.
 *
 * A version is never edited in place. Tightening 15 / 35 later is a new
 * entry, so a campaign already shown to an advertiser is not re-banded
 * silently.
 */

export type VisibilityBand = 'high' | 'medium' | 'low';

export interface VisibilityCutoffs {
  /** Inclusive upper bound for a crawl / jam / signal. Below this is high. */
  highBelowKmh: number;
  /** Inclusive upper bound for ordinary city traffic. Below this is medium. */
  mediumBelowKmh: number;
  /**
   * A stretch slower than this for longer than `parkedMinSeconds` is treated
   * as parked, not as high visibility. Sitting still all night must not inflate
   * the readable share.
   */
  parkedBelowKmh: number;
  parkedMinSeconds: number;
  /** Shorter than this is noise, not a drive. */
  minDistanceKm: number;
}

const V1: VisibilityCutoffs = {
  highBelowKmh: 15,
  mediumBelowKmh: 35,
  parkedBelowKmh: 1,
  parkedMinSeconds: 180,
  minDistanceKm: 0.001,
};

/** What new work is classified under. Reading is always by explicit version. */
export const CURRENT_VISIBILITY_VERSION = 'v1.0.0';

const VERSIONS: Readonly<Record<string, VisibilityCutoffs>> = {
  'v1.0.0': V1,
};

/**
 * Throws on an unknown version rather than falling back to the current one.
 *
 * The same reason impressions refuse a missing model: quietly re-banding a
 * campaign against newer cutoffs is the one thing the versioning exists to
 * prevent.
 */
export function cutoffsFor(version: string): VisibilityCutoffs {
  const found = VERSIONS[version];
  if (!found) throw new Error(`Unknown visibility version: ${version}`);
  return found;
}

export function knownVisibilityVersions(): string[] {
  return Object.keys(VERSIONS);
}

/** Speed the impressions model already uses: distance over duration, never the handset's claim. */
export function observedKmh(distanceKm: number, seconds: number): number | null {
  if (!(seconds > 0) || !Number.isFinite(distanceKm) || !Number.isFinite(seconds)) return null;
  return distanceKm / (seconds / 3600);
}

export function visibilityOf(kmh: number, cutoffs: VisibilityCutoffs = V1): VisibilityBand {
  if (kmh < cutoffs.highBelowKmh) return 'high';
  if (kmh < cutoffs.mediumBelowKmh) return 'medium';
  return 'low';
}

/**
 * Whether this stretch is a drive someone could have read, rather than a
 * parked vehicle or a pair too short to trust.
 *
 * Applied before banding so a night in a depot cannot become "high visibility".
 */
export function classifies(
  distanceKm: number,
  seconds: number,
  cutoffs: VisibilityCutoffs = V1,
): boolean {
  if (distanceKm < cutoffs.minDistanceKm) return false;
  const kmh = observedKmh(distanceKm, seconds);
  if (kmh === null) return false;
  if (kmh < cutoffs.parkedBelowKmh && seconds > cutoffs.parkedMinSeconds) return false;
  return true;
}

export function bandOf(
  distanceKm: number,
  seconds: number,
  cutoffs: VisibilityCutoffs = V1,
): VisibilityBand | null {
  if (!classifies(distanceKm, seconds, cutoffs)) return null;
  const kmh = observedKmh(distanceKm, seconds);
  if (kmh === null) return null;
  return visibilityOf(kmh, cutoffs);
}

export function publishedBands(cutoffs: VisibilityCutoffs = V1): {
  high: string;
  medium: string;
  low: string;
} {
  return {
    high: `<${String(cutoffs.highBelowKmh)} km/h`,
    medium: `${String(cutoffs.highBelowKmh)}–${String(cutoffs.mediumBelowKmh)} km/h`,
    low: `>${String(cutoffs.mediumBelowKmh)} km/h`,
  };
}
