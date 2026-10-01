import { QueryTypes } from 'sequelize';

import { sequelize } from '../../db/sequelize';
import { IST } from '../../shared/time';
import {
  bandOf,
  CURRENT_VISIBILITY_VERSION,
  cutoffsFor,
  publishedBands,
  type VisibilityBand,
} from '../../visibility/bands';
import {
  CURRENT_DAYPART_VERSION,
  daypartOf,
  publishedDayparts,
  type Daypart,
  type DaypartWindows,
} from '../../visibility/dayparts';
import { namedPlaces } from '../../visibility/namedPlaces';
import {
  totalsByKind,
  type DwellSample,
  type VisibilityKindTotal,
  type VisibilityPlace,
} from '../../visibility/places';

/**
 * A campaign's billable driving, banded by how readable the wrap was.
 *
 * Classified per GPS pair, then summed. A pair clipped at a zone boundary
 * shares one duration and one speed — attributing each part by its own
 * distance over that duration would make every crossing look slower than the
 * vehicle was, which is exactly the mistake this query exists to avoid.
 *
 * Only BILLABLE rows. Held and refused distance keep their reason and get no
 * band, because a kilometre the platform declined to bill is not one it should
 * be reporting as readable. Parked and near-zero pairs are dropped by
 * `bandOf`, so a night in a depot cannot become high visibility.
 */

interface PairRow {
  from_point_id: string;
  pair_km: string;
  seconds: string;
  lat: string;
  lng: string;
  hour_ist: string;
}

interface PartRow {
  from_point_id: string;
  distance_km: string;
}

const PAIRS = `
  SELECT s.from_point_id,
         SUM(s.distance_km)::float8                                  AS pair_km,
         EXTRACT(EPOCH FROM (MAX(s.ended_at) - MIN(s.started_at)))::float8 AS seconds,
         AVG(p.lat)::float8                                          AS lat,
         AVG(p.lon)::float8                                          AS lng,
         EXTRACT(HOUR FROM MIN(s.started_at) AT TIME ZONE :zone)::int AS hour_ist
    FROM trip_segments s
    JOIN gps_points p ON p.id = s.from_point_id
   WHERE s.campaign_id = :campaignId
     AND s.state = 'BILLABLE'
   GROUP BY s.from_point_id
`;

const PARTS = `
  SELECT s.from_point_id, s.distance_km::float8 AS distance_km
    FROM trip_segments s
   WHERE s.campaign_id = :campaignId
     AND s.state = 'BILLABLE'
`;

export interface CampaignVisibility {
  campaignId: string;
  version: string;
  highKm: number;
  mediumKm: number;
  lowKm: number;
  classifiedKm: number;
  highShare: number;
  bands: { high: string; medium: string; low: string };
  places: VisibilityPlace[];
  byKind: VisibilityKindTotal[];
  /** Of the kilometres slow enough to read, when in the IST day they ran. */
  when: CampaignDayparts;
}

export interface CampaignDayparts {
  version: string;
  morningKm: number;
  middayKm: number;
  eveningKm: number;
  nightKm: number;
  readableKm: number;
  peakShare: number;
  windows: DaypartWindows;
}

const round1 = (value: number): number => Number(value.toFixed(1));

/**
 * What share of the campaign's billed kilometres was slow enough to read.
 *
 * Folded in Node rather than `GROUP BY` in SQL so the skip rules and the
 * 15 / 35 cutoffs live in one place — the same `bandOf` the trip map uses.
 * Asking SQL to restate them is how a pair classified high on the map becomes
 * medium on the bar.
 */
export async function forCampaign(
  campaignId: string,
  version: string = CURRENT_VISIBILITY_VERSION,
): Promise<CampaignVisibility> {
  const cutoffs = cutoffsFor(version);

  const [pairs, parts] = await Promise.all([
    sequelize.query<PairRow>(PAIRS, {
      replacements: { campaignId, zone: IST },
      type: QueryTypes.SELECT,
    }),
    sequelize.query<PartRow>(PARTS, {
      replacements: { campaignId },
      type: QueryTypes.SELECT,
    }),
  ]);

  const pairBand = new Map<string, VisibilityBand | null>();
  const pairDaypart = new Map<string, Daypart>();
  for (const pair of pairs) {
    pairBand.set(pair.from_point_id, bandOf(Number(pair.pair_km), Number(pair.seconds), cutoffs));
    pairDaypart.set(pair.from_point_id, daypartOf(Number(pair.hour_ist)));
  }

  const km: Record<VisibilityBand, number> = { high: 0, medium: 0, low: 0 };
  const whenKm: Record<Daypart, number> = { morning: 0, midday: 0, evening: 0, night: 0 };
  for (const part of parts) {
    const band = pairBand.get(part.from_point_id);
    if (!band) continue;
    km[band] += Number(part.distance_km);
    if (band === 'high' || band === 'medium') {
      const partOfDay = pairDaypart.get(part.from_point_id);
      if (partOfDay) whenKm[partOfDay] += Number(part.distance_km);
    }
  }

  const classifiedKm = km.high + km.medium + km.low;

  const samples: DwellSample[] = [];
  for (const pair of pairs) {
    const band = pairBand.get(pair.from_point_id);
    if (band !== 'high' && band !== 'medium') continue;
    samples.push({
      lat: Number(pair.lat),
      lng: Number(pair.lng),
      km: Number(pair.pair_km),
      seconds: Number(pair.seconds),
      band,
    });
  }

  const places = await namedPlaces(samples);
  const readableKm = km.high + km.medium;
  const peakKm = whenKm.morning + whenKm.evening;

  return {
    campaignId,
    version,
    highKm: round1(km.high),
    mediumKm: round1(km.medium),
    lowKm: round1(km.low),
    classifiedKm: round1(classifiedKm),
    highShare: classifiedKm > 0 ? Number((km.high / classifiedKm).toFixed(4)) : 0,
    bands: publishedBands(cutoffs),
    places,
    byKind: totalsByKind(places),
    when: {
      version: CURRENT_DAYPART_VERSION,
      morningKm: round1(whenKm.morning),
      middayKm: round1(whenKm.midday),
      eveningKm: round1(whenKm.evening),
      nightKm: round1(whenKm.night),
      readableKm: round1(readableKm),
      peakShare: readableKm > 0 ? Number((peakKm / readableKm).toFixed(4)) : 0,
      windows: publishedDayparts(),
    },
  };
}
