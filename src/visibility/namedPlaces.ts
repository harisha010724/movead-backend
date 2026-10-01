import { lookupOsm } from './osm';
import { applyFeatures, clusterDwells, type DwellSample, type VisibilityPlace } from './places';

/** Cluster first, then ask the map — Overpass sees centroids, not every fix. */
export async function namedPlaces(samples: DwellSample[]): Promise<VisibilityPlace[]> {
  const clustered = clusterDwells(samples);
  if (clustered.length === 0) return [];
  return applyFeatures(clustered, await lookupOsm(clustered));
}
