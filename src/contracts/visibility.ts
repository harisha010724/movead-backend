import { commonErrorResponses, ErrorBodySchema } from './common';
import { registry, z } from './registry';

/**
 * Visibility mix — a campaign's billable driving, banded by how fast it ran.
 *
 * Read-only, advertiser-scoped, and deliberately separate from pricing and
 * from impressions. What the platform bills is verified kilometres; what this
 * answers is how much of that distance was slow enough to read. The cutoffs
 * travel with every response so a figure cannot be shown without the rule
 * that produced it.
 *
 * Nothing here carries a driver's identity or a driver's earning. Speed is
 * derived from each GPS pair's own distance and duration, the same formula
 * impressions already uses — never from the handset's `speed_mps`, and never
 * from a traffic feed.
 */

const json = <T>(schema: T) => ({ 'application/json': { schema } });

export const VisibilityBandSchema = z.enum(['high', 'medium', 'low']);

export const VisibilityCutoffsSchema = registry.register(
  'VisibilityCutoffs',
  z
    .object({
      high: z.string().describe('Published cutoff for a crawl / jam / signal.'),
      medium: z.string().describe('Published cutoff for ordinary city traffic.'),
      low: z.string().describe('Published cutoff for a fly-by.'),
    })
    .describe(
      'The 15 / 35 km/h bands, written out so an advertiser can argue with them. Platform-fixed, not advertiser-editable.',
    ),
);

export const VisibilityPlaceKindSchema = z.enum([
  'signal',
  'mall',
  'transit',
  'residential',
  'junction',
]);

export const VisibilityPlaceSchema = registry.register(
  'VisibilityPlace',
  z
    .object({
      kind: VisibilityPlaceKindSchema,
      name: z
        .string()
        .describe('A mapped name when Overpass knew one; otherwise the kind label.'),
      lat: z.number(),
      lng: z.number(),
      km: z.number().describe('Readable kilometres that sat in this cluster.'),
      seconds: z.number().int(),
      visits: z.number().int(),
      source: z
        .enum(['gps', 'osm'])
        .describe('gps is a dwell the fixes found; osm means a mapped feature renamed it.'),
    })
    .describe(
      'A place the wrap was readable. First a GPS cluster, then optionally named from OpenStreetMap. Not a billing input.',
    ),
);

export const VisibilityKindTotalSchema = registry.register(
  'VisibilityKindTotal',
  z.object({
    kind: VisibilityPlaceKindSchema,
    km: z.number(),
    count: z.number().int(),
  }),
);

export const DaypartWindowsSchema = registry.register(
  'DaypartWindows',
  z
    .object({
      morning: z.string(),
      midday: z.string(),
      evening: z.string(),
      night: z.string(),
    })
    .describe(
      'The IST clock windows, written out so an advertiser can argue with them. Platform-fixed, not advertiser-editable.',
    ),
);

export const CampaignDaypartsSchema = registry.register(
  'CampaignDayparts',
  z
    .object({
      version: z.string().describe('Which clock windows produced these figures.'),
      morningKm: z.number(),
      middayKm: z.number(),
      eveningKm: z.number(),
      nightKm: z.number(),
      readableKm: z
        .number()
        .describe('highKm + mediumKm. Fly-bys are omitted so daytime speed does not mint a peak.'),
      peakShare: z
        .number()
        .describe(
          '(morningKm + eveningKm) / readableKm, or 0 when nothing was slow enough to read.',
        ),
      windows: DaypartWindowsSchema,
    })
    .describe(
      'Of the kilometres slow enough to read, when in the IST day they ran. Not a people count and not a billing input.',
    ),
);

export const CampaignVisibilitySchema = registry.register(
  'CampaignVisibility',
  z.object({
    campaignId: z.uuid(),
    version: z
      .string()
      .describe('Which cutoffs produced these figures. A campaign is not re-banded silently.'),
    highKm: z.number().describe('Billable kilometres driven below the high-visibility cutoff.'),
    mediumKm: z.number(),
    lowKm: z.number(),
    classifiedKm: z
      .number()
      .describe(
        'Billable kilometres that were classifiable. Parked and near-zero stretches are omitted, so this can be smaller than the campaign\'s verified kilometres.',
      ),
    highShare: z
      .number()
      .describe('highKm / classifiedKm, or 0 when nothing classifiable was driven.'),
    bands: VisibilityCutoffsSchema,
    places: z
      .array(VisibilityPlaceSchema)
      .describe(
        'Readable dwells on this campaign — junctions first, renamed when a signal, mall, station or apartment sits in the same 80 m. A fly-by is not a place.',
      ),
    byKind: z.array(VisibilityKindTotalSchema),
    when: CampaignDaypartsSchema,
  }),
);

registry.registerPath({
  method: 'get',
  path: '/v1/campaigns/{id}/visibility',
  tags: ['campaigns'],
  summary: 'How readable the wrap was',
  description: [
    "The campaign's billable driving, split by how fast the vehicle was moving.",
    '',
    'Slow driving is easier to read. This is not what you are billed on — verified kilometres stay the unit the contract is written in, and nothing here multiplies a charge or an earning.',
    '',
    'Speed is derived from each GPS pair\'s own distance and duration, the same formula the impression model already uses. A pair clipped at a zone boundary keeps the vehicle\'s speed; only its distance is split. Parked and near-zero stretches are omitted so a night in a depot cannot become high visibility.',
    '',
    'Places are a second read of the same pairs: high and medium samples are clustered within 80 m, then optionally named from OpenStreetMap (signals, malls, transit, apartments). Overpass is best-effort — a timeout returns the GPS junctions unnamed rather than failing the mix. Neither layer multiplies a charge.',
    '',
    '`when` is a third read of the same high and medium pairs, bucketed by the IST hour the pair started. Morning 07–11, midday 11–17, evening 17–21, night 21–07. A daytime fly-by is not a peak hour. Nothing here is a people count.',
    '',
    'Scoped to the signed-in advertiser. A campaign belonging to someone else is not found rather than forbidden.',
  ].join('\n'),
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: 'The mix. Zero totals for a campaign that has not been driven yet.',
      content: json(CampaignVisibilitySchema),
    },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
    403: { description: 'Not an advertiser account.', content: json(ErrorBodySchema) },
    404: { description: 'No such campaign for this advertiser.', content: json(ErrorBodySchema) },
  },
});
