import { commonErrorResponses, ErrorBodySchema, MoneySchema } from './common';
import { registry, z } from './registry';

/**
 * Impressions — a campaign's driving expressed as an audience.
 *
 * Read-only, advertiser-scoped, and deliberately separate from the pricing
 * surface. What the platform bills is verified kilometres per zone, which is
 * GPS-provable and is what the contract is denominated in; impressions are the
 * media translation of that, and are modelled. Every response below says which
 * version of the model produced it and how much of it rests on measurement
 * rather than assumption, because a modelled figure presented without either
 * is indistinguishable from a made-up one.
 *
 * Nothing here carries a driver's identity or a driver's earning. The
 * admin-side audit of the same segments does, which is why it sits behind its
 * own permission; this is the mirror of it, built field by field so that the
 * other side of the money cannot reappear by accident.
 */

const json = <T>(schema: T) => ({ 'application/json': { schema } });

const ZoneEnum = z.enum(['prime', 'secondary', 'network']);

export const ZoneImpressionsSchema = registry.register(
  'ZoneImpressions',
  z.object({
    zone: ZoneEnum,
    verifiedKm: z.number().describe('Billable kilometres driven in this zone.'),
    impressions: z.number().int().describe('Modelled, and rounded only here at the edge.'),
    charge: MoneySchema.describe('What these kilometres cost, at the zone rate.'),
  }),
);

export const DayImpressionsSchema = registry.register(
  'DayImpressions',
  z.object({
    date: z.string().describe('Civil day in Asia/Kolkata, `YYYY-MM-DD`.'),
    verifiedKm: z.number(),
    impressions: z.number().int(),
  }),
);

export const BaselineMixSchema = registry.register(
  'BaselineMix',
  z
    .object({
      cellHour: z
        .number()
        .describe('Share resting on measurement of that road in that hour of the week.'),
      cell: z.number().describe('Share resting on measurement of that road across the week.'),
      zoneDefault: z
        .number()
        .describe('Share resting on a flat per-zone assumption, because the road is barely driven yet.'),
    })
    .describe(
      'How much of the reported audience is measurement and how much is assumption, as shares of the impressions. The figure a competitor cannot publish, because a rented traffic feed cannot say which of its roads it actually knows.',
    ),
);

const totals = {
  modelVersion: z
    .string()
    .describe('Which set of assumptions produced these figures. A campaign is pinned to one.'),
  verifiedKm: z.number().describe('The billable distance behind the audience. Provable, and what the contract is denominated in.'),
  impressions: z.number().int().describe('Modelled opportunities-to-see, counted gross.'),
  charge: MoneySchema,
  cpm: MoneySchema.describe('Cost per thousand impressions — the figure that compares to other media.'),
  byZone: z.array(ZoneImpressionsSchema),
  byDay: z.array(DayImpressionsSchema).describe('Oldest first. Days with no billable driving are absent.'),
  baselineMix: BaselineMixSchema,
};

export const CampaignImpressionsSchema = registry.register(
  'CampaignImpressions',
  z.object({
    campaignId: z.uuid(),
    campaignName: z.string(),
    ...totals,
  }),
);

export const ImpressionWorkingSchema = registry.register(
  'ImpressionWorking',
  z
    .object({
      jamDensity: z.number().describe('Vehicles in a kilometre of one lane, bumper to bumper.'),
      occupantsPerVehicle: z.number().describe('Mean across the traffic mix, not per cab.'),
      lineOfSightShare: z
        .number()
        .describe('Share of people present who could see the wrap at all. Geometry, not print quality.'),
      wrapQuality: z.number().describe('How legible the wrap is, for those who can see it.'),
      zones: z.array(
        z.object({
          zone: ZoneEnum,
          lanes: z.number().describe('Lanes within viewing range, both directions.'),
          pedestrianDensity: z
            .number()
            .describe('People on foot per kilometre. The one input with no measurement behind it.'),
        }),
      ),
      medianObservedKmh: z
        .number()
        .nullable()
        .describe('How fast the fleet actually moved, derived from distance and duration.'),
      medianBaselineKmh: z
        .number()
        .nullable()
        .describe('What those roads do when clear. The gap between the two is the congestion.'),
    })
    .describe('Every coefficient that was multiplied, so the arithmetic can be repeated by hand.'),
);

export const CampaignDayImpressionsSchema = registry.register(
  'CampaignDayImpressions',
  z.object({
    campaignId: z.uuid(),
    date: z.string(),
    ...totals,
    working: ImpressionWorkingSchema,
  }),
);

export const ImpressionDayParamSchema = z.object({
  id: z.uuid(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
    .describe('Civil day in Asia/Kolkata.'),
});

registry.registerPath({
  method: 'get',
  path: '/v1/campaigns/{id}/impressions',
  tags: ['campaigns'],
  summary: 'What the campaign has been seen by',
  description: [
    "The campaign's billable driving, expressed as an audience.",
    '',
    'Guarantee what you measure, report what you model. `verifiedKm` is GPS-provable and is the unit the contract is written in; `impressions` is the media translation of it and is explicitly a model output. Both are returned together so neither can be read without the other.',
    '',
    'The audience is derived from the fleet measuring its own roads: how far below free-flow speed a vehicle was travelling gives the traffic density around it, and therefore the people in a position to see the livery. No traffic feed is licensed and none is needed — which is also why `baselineMix` can be published at all.',
    '',
    'Scoped to the signed-in advertiser. A campaign belonging to someone else is not found rather than forbidden.',
  ].join('\n'),
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: 'The campaign. Zero totals for one that has not been driven yet.',
      content: json(CampaignImpressionsSchema),
    },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
    403: { description: 'Not an advertiser account.', content: json(ErrorBodySchema) },
    404: { description: 'No such campaign for this advertiser.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/campaigns/{id}/impressions/days/{date}',
  tags: ['campaigns'],
  summary: 'One day, with the working shown',
  description: [
    'What a row in the daily series opens into: the same totals for a single day, plus every coefficient the model multiplied to reach them and the two speeds the congestion was read from.',
    '',
    'Published so the figure can be argued with. An impression count nobody can take apart is a number an advertiser has to take on trust, and trust is the thing the rest of this platform is built to avoid asking for.',
  ].join('\n'),
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  request: { params: ImpressionDayParamSchema },
  responses: {
    200: {
      description: 'The day. Zero totals for a day the campaign did not run.',
      content: json(CampaignDayImpressionsSchema),
    },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
    403: { description: 'Not an advertiser account.', content: json(ErrorBodySchema) },
    404: { description: 'No such campaign for this advertiser.', content: json(ErrorBodySchema) },
  },
});
