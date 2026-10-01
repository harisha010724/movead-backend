import { loggerFor } from '../shared/logger';

import { type MapFeature, PLACE_RADIUS_KM } from './places';

/**
 * Optional names for dwell clusters, from OpenStreetMap.
 *
 * Places (Google) is already on the advertiser map for pins and search; it is
 * a poor source of traffic signals. Overpass is the other way around: signals,
 * crossings, malls, stations and apartment buildings are tagged, and a miss
 * is free. The lookup is best-effort — a timeout or a refused Overpass must
 * not fail the visibility read. Tests never call it.
 */

const log = loggerFor('visibility.osm');

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const TIMEOUT_MS = 4_000;

interface OverpassElement {
  type: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

export async function lookupOsm(points: { lat: number; lng: number }[]): Promise<MapFeature[]> {
  if (points.length === 0) return [];
  if (process.env.NODE_ENV === 'test') return [];

  const lats = points.map((point) => point.lat);
  const lngs = points.map((point) => point.lng);
  const pad = PLACE_RADIUS_KM / 111;
  const south = Math.min(...lats) - pad;
  const north = Math.max(...lats) + pad;
  const west = Math.min(...lngs) - pad;
  const east = Math.max(...lngs) + pad;
  const box = `${south.toFixed(5)},${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)}`;

  const query = `[out:json][timeout:3];(${[
    `node["highway"="traffic_signals"](${box})`,
    `node["highway"="crossing"](${box})`,
    `nwr["shop"="mall"](${box})`,
    `nwr["shop"="department_store"](${box})`,
    `nwr["amenity"="cinema"](${box})`,
    `nwr["railway"="station"](${box})`,
    `nwr["station"="subway"](${box})`,
    `nwr["public_transport"="station"](${box})`,
    `nwr["building"="apartments"](${box})`,
  ].join(';')};);out center 40;`;

  try {
    const response = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return [];

    const body = (await response.json()) as OverpassResponse;
    return (body.elements ?? []).flatMap((element) => {
      const feature = featureOf(element);
      return feature ? [feature] : [];
    });
  } catch (error) {
    log.warn({ err: error }, 'overpass lookup skipped');
    return [];
  }
}

function featureOf(element: OverpassElement): MapFeature | null {
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  if (lat === undefined || lng === undefined) return null;

  const tags = element.tags ?? {};
  const kind = kindOf(tags);
  if (!kind) return null;

  return { kind, name: tags.name ?? null, lat, lng };
}

function kindOf(tags: Record<string, string>): MapFeature['kind'] | null {
  if (tags.shop === 'mall' || tags.shop === 'department_store' || tags.amenity === 'cinema') {
    return 'mall';
  }
  if (tags.highway === 'traffic_signals' || tags.highway === 'crossing') return 'signal';
  if (
    tags.railway === 'station' ||
    tags.station === 'subway' ||
    tags.public_transport === 'station'
  ) {
    return 'transit';
  }
  if (tags.building === 'apartments') return 'residential';
  return null;
}
