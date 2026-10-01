import { haversineKm } from '../shared/geo';

import { type VisibilityBand } from './bands';

/**
 * Where readable driving actually sat still.
 *
 * Speed mix answers "could someone read the wrap". This answers "read it
 * where?" — first from the GPS itself (a repeated crawl is a junction), then
 * optionally from a map lookup that can rename the cluster as a signal, a
 * mall, transit or residential. Neither is a billing input.
 */

export type VisibilityPlaceKind = 'signal' | 'mall' | 'transit' | 'residential' | 'junction';

export interface DwellSample {
  lat: number;
  lng: number;
  km: number;
  seconds: number;
  band: Exclude<VisibilityBand, 'low'>;
}

export interface VisibilityPlace {
  kind: VisibilityPlaceKind;
  name: string;
  lat: number;
  lng: number;
  km: number;
  seconds: number;
  visits: number;
  source: 'gps' | 'osm';
}

export interface VisibilityKindTotal {
  kind: VisibilityPlaceKind;
  km: number;
  count: number;
}

/** How close two crawls must be to be the same place. About one junction. */
export const PLACE_RADIUS_KM = 0.08;

const MIN_CLUSTER_KM = 0.03;
const MIN_CLUSTER_SECONDS = 20;
const MAX_PLACES = 12;

export const PLACE_KIND_ORDER: VisibilityPlaceKind[] = [
  'mall',
  'signal',
  'transit',
  'residential',
  'junction',
];

export const PLACE_KIND_LABEL: Record<VisibilityPlaceKind, string> = {
  signal: 'Traffic signal',
  mall: 'Mall / retail',
  transit: 'Transit',
  residential: 'Residential',
  junction: 'Junction',
};

export function labelFor(kind: VisibilityPlaceKind, name?: string | null): string {
  const trimmed = name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : PLACE_KIND_LABEL[kind];
}

/**
 * Merge nearby high/medium samples into places.
 *
 * Low-visibility fly-bys are excluded: passing a mall at 50 km/h is not the
 * same claim as crawling at its exit. Tiny clusters are dropped so GPS jitter
 * at a depot gate cannot mint a "place".
 */
export function clusterDwells(samples: DwellSample[]): VisibilityPlace[] {
  const clusters: {
    lat: number;
    lng: number;
    km: number;
    seconds: number;
    visits: number;
    weight: number;
  }[] = [];

  for (const sample of samples) {
    let nearest = -1;
    let nearestKm = PLACE_RADIUS_KM;

    for (let i = 0; i < clusters.length; i += 1) {
      const cluster = clusters[i];
      if (!cluster) continue;
      const distance = haversineKm(
        { lat: sample.lat, lng: sample.lng },
        { lat: cluster.lat, lng: cluster.lng },
      );
      if (distance < nearestKm) {
        nearest = i;
        nearestKm = distance;
      }
    }

    if (nearest < 0) {
      clusters.push({
        lat: sample.lat,
        lng: sample.lng,
        km: sample.km,
        seconds: sample.seconds,
        visits: 1,
        weight: sample.km,
      });
      continue;
    }

    const cluster = clusters[nearest];
    if (!cluster) continue;
    const nextWeight = cluster.weight + sample.km;
    cluster.lat = (cluster.lat * cluster.weight + sample.lat * sample.km) / nextWeight;
    cluster.lng = (cluster.lng * cluster.weight + sample.lng * sample.km) / nextWeight;
    cluster.weight = nextWeight;
    cluster.km += sample.km;
    cluster.seconds += sample.seconds;
    cluster.visits += 1;
  }

  return clusters
    .filter((cluster) => cluster.km >= MIN_CLUSTER_KM || cluster.seconds >= MIN_CLUSTER_SECONDS)
    .sort((left, right) => right.km - left.km || right.seconds - left.seconds)
    .slice(0, MAX_PLACES)
    .map((cluster) => ({
      kind: 'junction' as const,
      name: PLACE_KIND_LABEL.junction,
      lat: Number(cluster.lat.toFixed(6)),
      lng: Number(cluster.lng.toFixed(6)),
      km: Number(cluster.km.toFixed(3)),
      seconds: Math.round(cluster.seconds),
      visits: cluster.visits,
      source: 'gps' as const,
    }));
}

export interface MapFeature {
  kind: Exclude<VisibilityPlaceKind, 'junction'>;
  name: string | null;
  lat: number;
  lng: number;
}

/**
 * Rename a GPS cluster when a mapped feature sits inside the same 80 m.
 *
 * Priority is mall → signal → transit → residential. A mall next to a signal
 * is the mall: that is the place an advertiser can name. Junction remains the
 * fallback when the map knows nothing.
 */
export function applyFeatures(places: VisibilityPlace[], features: MapFeature[]): VisibilityPlace[] {
  return places.map((place) => {
    const point = { lat: place.lat, lng: place.lng };
    let best: MapFeature | null = null;
    let bestRank = PLACE_KIND_ORDER.length;

    for (const feature of features) {
      if (haversineKm(point, { lat: feature.lat, lng: feature.lng }) > PLACE_RADIUS_KM) continue;
      const rank = PLACE_KIND_ORDER.indexOf(feature.kind);
      if (rank < bestRank) {
        best = feature;
        bestRank = rank;
      }
    }

    if (!best) return place;

    return {
      ...place,
      kind: best.kind,
      name: labelFor(best.kind, best.name),
      source: 'osm',
    };
  });
}

export function totalsByKind(places: VisibilityPlace[]): VisibilityKindTotal[] {
  const totals = new Map<VisibilityPlaceKind, VisibilityKindTotal>();

  for (const place of places) {
    const running = totals.get(place.kind) ?? { kind: place.kind, km: 0, count: 0 };
    running.km += place.km;
    running.count += 1;
    totals.set(place.kind, running);
  }

  return PLACE_KIND_ORDER.filter((kind) => totals.has(kind)).map((kind) => {
    const found = totals.get(kind) as VisibilityKindTotal;
    return { kind, km: Number(found.km.toFixed(1)), count: found.count };
  });
}
