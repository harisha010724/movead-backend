export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Ray-casting point-in-polygon. The last vertex does not need to repeat the
 * first. A point on an edge is treated as inside so a pin dropped on a zone
 * boundary still matches that zone.
 */
export function pointInPolygon(point: LatLng, path: LatLng[]): boolean {
  if (path.length < 3) return false;

  let inside = false;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const a = path[i];
    const b = path[j];
    if (!a || !b) continue;

    const crosses =
      a.lat > point.lat !== b.lat > point.lat &&
      point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng;

    if (crosses) inside = !inside;
  }

  return inside;
}

export type ZoneMatch = 'prime' | 'secondary' | null;

/** Prime wins when the point sits in both outlines. */
export function zoneForPoint(
  point: LatLng,
  polygons: Partial<Record<'prime' | 'secondary', { path: LatLng[] }>>,
): ZoneMatch {
  if (polygons.prime && pointInPolygon(point, polygons.prime.path)) return 'prime';
  if (polygons.secondary && pointInPolygon(point, polygons.secondary.path)) return 'secondary';
  return null;
}

const EARTH_RADIUS_KM = 6371.0088;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in kilometres.
 *
 * AC-10.4 — this, and never the figure the handset reports, is what a
 * kilometre means. A phone's own odometer is a number the person holding it
 * can influence.
 */
export function haversineKm(from: LatLng, to: LatLng): number {
  const dLat = toRadians(to.lat - from.lat);
  const dLng = toRadians(to.lng - from.lng);
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);

  const a =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export type Zone = 'prime' | 'secondary' | 'network';

export interface ZonedPart {
  zone: Zone;
  distanceKm: number;
}

export type ZonePolygons = Partial<Record<'prime' | 'secondary', { path: LatLng[] }>>;

/**
 * Where along `from → to` the straight path crosses the edge `a → b`.
 *
 * Returned as the fraction of the way along the travel segment, or null when
 * they do not cross within both spans. Longitude is x and latitude is y: over
 * the few hundred metres between two GPS fixes the difference between that and
 * a proper geodesic is far below the accuracy of the fixes themselves, and
 * distance is still measured with haversine.
 */
function crossingFraction(from: LatLng, to: LatLng, a: LatLng, b: LatLng): number | null {
  const rx = to.lng - from.lng;
  const ry = to.lat - from.lat;
  const sx = b.lng - a.lng;
  const sy = b.lat - a.lat;

  const denominator = rx * sy - ry * sx;
  if (denominator === 0) return null; // Parallel, or both degenerate.

  const t = ((a.lng - from.lng) * sy - (a.lat - from.lat) * sx) / denominator;
  const u = ((a.lng - from.lng) * ry - (a.lat - from.lat) * rx) / denominator;

  if (t <= 0 || t >= 1 || u < 0 || u > 1) return null;
  return t;
}

function edgeCrossings(from: LatLng, to: LatLng, path: LatLng[], into: number[]): void {
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const a = path[i];
    const b = path[j];
    if (!a || !b) continue;

    const t = crossingFraction(from, to, a, b);
    if (t !== null) into.push(t);
  }
}

const at = (from: LatLng, to: LatLng, t: number): LatLng => ({
  lat: from.lat + (to.lat - from.lat) * t,
  lng: from.lng + (to.lng - from.lng) * t,
});

/**
 * Split the travel between two fixes at every zone boundary it crosses, and
 * price each part in its own zone (AC-21).
 *
 * This is the criterion the spec says is most likely to be got wrong, and the
 * tempting wrong answers are all cheaper than this one: classify the whole
 * journey by where it started, or by where most of it happened, or snap the
 * boundary to the nearest fix. AC-21.7 names the first two as defects and
 * AC-21.4 the third — the cut has to be geometric, against the polygon edge,
 * because a vehicle that leaves Prime halfway between two fixes has left it
 * halfway, and at ₹5 against ₹1 the difference is most of the bill.
 *
 * Parts come back in travel order and their distances sum to the whole
 * (AC-21.5), because each is a fraction of one haversine measurement rather
 * than a separate one: measuring each part independently would let rounding
 * lose or invent metres at every boundary. Consecutive parts in the same zone
 * are merged, so a path that never leaves Prime is one part and prime →
 * secondary → prime is three.
 */
export function splitSegmentByZone(
  from: LatLng,
  to: LatLng,
  polygons: ZonePolygons,
): ZonedPart[] {
  const distanceKm = haversineKm(from, to);
  const zoneAt = (point: LatLng): Zone => zoneForPoint(point, polygons) ?? 'network';

  if (distanceKm === 0) return [];

  const cuts: number[] = [];
  if (polygons.prime) edgeCrossings(from, to, polygons.prime.path, cuts);
  if (polygons.secondary) edgeCrossings(from, to, polygons.secondary.path, cuts);

  // Boundaries touched twice — a corner, or the shared edge of two outlines —
  // would otherwise produce zero-length parts.
  const bounds = [0, ...new Set(cuts)].sort((x, y) => x - y);
  bounds.push(1);

  const parts: ZonedPart[] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const start = bounds[i] as number;
    const end = bounds[i + 1] as number;
    if (end <= start) continue;

    // Classified by the middle of the part rather than by either edge, so a
    // fix sitting exactly on a boundary does not decide the zone of travel
    // that is wholly on one side of it.
    const zone = zoneAt(at(from, to, (start + end) / 2));
    const last = parts[parts.length - 1];

    if (last && last.zone === zone) last.distanceKm += distanceKm * (end - start);
    else parts.push({ zone, distanceKm: distanceKm * (end - start) });
  }

  return parts;
}
