import { commonErrorResponses, ErrorBodySchema, MoneySchema } from './common';
import { registry, z } from './registry';

/**
 * Tracking — the driver's session, the fixes it uploads, and the totals read
 * back off them (AC-08 through AC-21).
 *
 * The write surface is small on purpose. A phone opens a session, streams
 * batches of fixes at it, and closes it; everything else — distance, zone,
 * money — is derived server-side and only ever read. AC-10.4 is the reason:
 * the one number the phone is not allowed to assert is how far it went.
 *
 * The read surface is the other half of the same data: the wallet those
 * segments sum to, and the day of trips behind any figure in it.
 */

const json = <T>(schema: T) => ({ 'application/json': { schema } });

export const GpsPointSchema = registry.register(
  'GpsPoint',
  z.object({
    clientPointId: z
      .uuid()
      .describe(
        'The id the phone gave this fix. Re-uploading a batch that already landed is a no-op on this key, which is what makes offline sync safe to retry (AC-19.4).',
      ),
    recordedAt: z
      .string()
      .describe('When the fix was captured. Upload time never affects billing (AC-19.3).'),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    accuracyM: z
      .number()
      .nonnegative()
      .describe('Metres. Decides whether this fix can carry money at all (AC-11.1).'),
    speedMps: z.number().nonnegative().nullish(),
    headingDeg: z.number().min(0).max(360).nullish(),
    isMock: z
      .boolean()
      .optional()
      .describe("The operating system's own mock-location flag, carried through untouched."),
    deviceDistanceM: z
      .number()
      .nonnegative()
      .nullish()
      .describe(
        'What the handset thinks it travelled. Stored for comparison and never billed on (AC-10.4, AC-10.5).',
      ),
  }),
);

export const TrackingPointsRequestSchema = registry.register(
  'TrackingPointsRequest',
  z.object({
    sessionId: z.uuid(),
    points: z.array(GpsPointSchema).min(1).max(500),
  }),
);

export const TrackingIngestResultSchema = registry.register(
  'TrackingIngestResult',
  z.object({
    accepted: z.number().int(),
    duplicates: z.number().int(),
    verifiedKm: z.number(),
    pendingKm: z.number(),
  }),
);

export const TrackingSessionSchema = registry.register(
  'TrackingSession',
  z.object({
    id: z.uuid(),
    campaignId: z.uuid(),
    campaignName: z.string(),
    vehicleRegistration: z.string(),
    startedAt: z
      .string()
      .describe('The billing boundary. Nothing before it is billable (AC-08.5).'),
    status: z.enum(['ACTIVE', 'ENDED']),
    verifiedKm: z.number().describe('Billable kilometres so far, summed from the segments.'),
    pendingKm: z
      .number()
      .describe('Measured but held for review, and never paid automatically (AC-11.4, AC-18.2).'),
    estimatedEarnings: MoneySchema,
    route: z.array(z.object({ lat: z.number(), lng: z.number() })),
  }),
);

export const StartSessionRequestSchema = registry.register(
  'StartTrackingSessionRequest',
  z.object({
    startedAt: z
      .string()
      .nullish()
      .describe(
        'The local time the driver pressed start. Sent so a session begun with no signal keeps its own boundary when it finally syncs (AC-08.7). Clamped server-side: never in the future, never more than a day ago.',
      ),
  }),
);

export const StopSessionRequestSchema = registry.register(
  'StopTrackingSessionRequest',
  z.object({ reason: z.string().max(200).nullish() }),
);

export const DaySummarySchema = registry.register(
  'DaySummary',
  z.object({
    date: z.string().describe('Civil day in Asia/Kolkata, `YYYY-MM-DD`.'),
    verifiedKm: z.number(),
    earnings: MoneySchema,
  }),
);

export const EarningsSummarySchema = registry.register(
  'EarningsSummary',
  z.object({
    availableBalance: MoneySchema.describe('Everything billable has earned, less nothing yet.'),
    pendingBalance: MoneySchema.describe(
      'What review is holding, valued at the rate stamped on the held segments — which is why a segment earning nothing still carries a rate.',
    ),
    monthVerifiedKm: z.number(),
    monthEarnings: MoneySchema,
    todayVerifiedKm: z.number(),
    todayEarnings: MoneySchema,
    history: z.array(DaySummarySchema).describe('The last 30 days that earned, newest first.'),
  }),
);

export const TripSchema = registry.register(
  'Trip',
  z.object({
    id: z.uuid().describe('The tracking session this trip is.'),
    sequence: z.number().int().describe('Position within the day, from 1.'),
    startedAt: z.string(),
    endedAt: z.string(),
    verifiedKm: z.number().describe('Billable kilometres only. Held distance is not counted here.'),
    earnings: MoneySchema,
    status: z
      .enum(['verified', 'pending_review', 'rejected'])
      .describe(
        'A trip holding anything in review reads `pending_review`, even where most of it cleared: the badge answers whether the figure is final.',
      ),
    zoneBreakdown: z
      .array(z.object({ zone: z.enum(['prime', 'secondary', 'network']), km: z.number(), earnings: MoneySchema }))
      .nullable()
      .describe('Null when nothing on this trip was billable, so there is nothing to split.'),
  }),
);

export const DayDetailSchema = registry.register(
  'DayDetail',
  z.object({
    date: z.string(),
    totalVerifiedKm: z.number(),
    totalEarnings: MoneySchema,
    trips: z.array(TripSchema).describe('Earliest first.'),
  }),
);

export const DayParamSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
    .describe('Civil day in Asia/Kolkata.'),
});

export const DriverTripLegSchema = registry.register(
  'DriverTripLeg',
  z.object({
    zone: z.enum(['prime', 'secondary', 'network']),
    state: z.enum(['BILLABLE', 'PENDING_REVIEW', 'NON_BILLABLE']),
    flagReason: z
      .string()
      .nullable()
      .describe('Why this stretch has not been paid. Null unless it is held or refused.'),
    startedAt: z.string(),
    endedAt: z.string(),
    distanceKm: z.number(),
    earnings: MoneySchema.describe("The driver's own earning for this stretch."),
    path: z
      .array(z.object({ lat: z.number(), lng: z.number() }))
      .describe('The line to draw, in order.'),
  }),
);

export const DriverTripSchema = registry.register(
  'DriverTrip',
  z.object({
    id: z.uuid(),
    campaignName: z.string(),
    startedAt: z.string(),
    endedAt: z.string().nullable().describe('Null while the trip is still running.'),
    verifiedKm: z.number(),
    earnings: MoneySchema,
    status: z.enum(['verified', 'pending_review', 'rejected']),
    legs: z
      .array(DriverTripLegSchema)
      .describe(
        'Consecutive stretches agreeing on zone, state and reason, merged into one run each. Refused and held stretches are included, so the map accounts for every kilometre the driver drove and not only the paid ones.',
      ),
  }),
);

// --- GPS audit (AC-25) ---------------------------------------------------

export const AuditDaySchema = registry.register(
  'AuditDay',
  z.object({
    vehicle: z
      .object({ id: z.uuid(), registrationNumber: z.string() })
      .describe('The vehicle the plate resolved to, so the screen can show what it matched.'),
    date: z.string(),
    totalVerifiedKm: z.number(),
    totalEarnings: MoneySchema,
    totalCharge: MoneySchema.describe('What the advertiser is charged for the same distance.'),
    trips: z.array(TripSchema).describe('Earliest first.'),
  }),
);

export const TripLegSchema = registry.register(
  'TripLeg',
  z.object({
    zone: z.enum(['prime', 'secondary', 'network']),
    state: z.enum(['BILLABLE', 'PENDING_REVIEW', 'NON_BILLABLE']),
    flagReason: z.string().nullable().describe('Why this run earns nothing yet.'),
    startedAt: z.string(),
    endedAt: z.string(),
    distanceKm: z.number(),
    advertiserRate: MoneySchema,
    driverRate: MoneySchema,
    advertiserCharge: MoneySchema,
    driverEarning: MoneySchema,
    segments: z.number().int().describe('How many priced segments were merged into this run.'),
    path: z
      .array(z.object({ lat: z.number(), lng: z.number() }))
      .describe(
        'The line to draw, in order. Boundary crossings are reconstructed by walking the straight line between two fixes by cumulative distance, which is the same line the pipeline clipped.',
      ),
  }),
);

export const TripDetailSchema = registry.register(
  'TripDetail',
  z.object({
    id: z.uuid(),
    vehicleRegistration: z.string(),
    campaignName: z.string(),
    driverName: z.string(),
    startedAt: z.string(),
    endedAt: z.string().nullable().describe('Null while the trip is still running.'),
    distanceKm: z.number(),
    advertiserCharge: MoneySchema,
    driverEarning: MoneySchema,
    legs: z.array(TripLegSchema),
  }),
);

export const AuditDayQuerySchema = z.object({
  vehicleNumber: z
    .string()
    .min(4)
    .max(16)
    .describe(
      'The registration on the vehicle. Matched exactly once punctuation and spacing are removed, so `KA 01 AB 1234` finds `KA01AB1234` — but a partial plate finds nothing, because an audit has to be about the vehicle you meant.',
    ),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
    .describe('Civil day in Asia/Kolkata.'),
});

registry.registerPath({
  method: 'get',
  path: '/v1/driver/earnings',
  tags: ['driver-portal'],
  summary: "The driver's own earnings",
  description:
    'AC-23. Every figure is summed from `trip_segments` on each read, so what the phone shows and what a payout run computes cannot drift apart. Days are Asia/Kolkata days — a shift that ends at 01:00 belongs to the night it was driven, not to the UTC date it happened to fall on.',
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  responses: {
    200: { description: 'The wallet.', content: json(EarningsSummarySchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/driver/earnings/days/{date}',
  tags: ['driver-portal'],
  summary: 'One day of trips',
  description: [
    'What a row in the earnings history opens into: the trips behind that day and what each one earned.',
    '',
    'A trip is one tracking session — one press of Start to one press of Stop — because that is the unit the driver performed. The segments underneath are a pricing artefact and there are hundreds of them in an afternoon.',
    '',
    'A session driven through midnight appears on both days, carrying only the segments driven on each, and its times are the first and last of those. The day total therefore always equals the matching `history` row, so a driver who taps a figure never finds the trips inside it adding up to something else.',
  ].join('\n'),
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  request: { params: DayParamSchema },
  responses: {
    200: {
      description: 'The day. Zero totals and an empty list for a day not driven.',
      content: json(DayDetailSchema),
    },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/driver/trips/{id}',
  tags: ['driver-portal'],
  summary: 'Where one of my trips went',
  description: [
    "AC-24. The route behind a row in the day's trip list, so a driver can see the drive they are being paid for rather than take the distance on trust.",
    '',
    'The line is returned as runs coloured by pricing zone, which is what makes a zoned rate card legible: two trips of the same length paying differently is explained by where they ran, and this is where that shows.',
    '',
    'Held and refused stretches are included and marked. A driver whose map shows 26 km against a paid 24 km is owed the missing two and the reason for them.',
    '',
    'Carries no advertiser rate or charge. What the platform bills for a kilometre is not the driver\'s to see, and the response is built field by field rather than filtered so that it cannot become so by accident.',
  ].join('\n'),
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'The trip.', content: json(DriverTripSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
    404: {
      description:
        "No such trip, or it belongs to another driver — the same answer for both, so a session id cannot be tested for existence.",
      content: json(ErrorBodySchema),
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/drivers/{id}/trips',
  tags: ['admin-drivers'],
  summary: "One day of a driver's trips",
  description:
    'The same day the driver sees, for settling a question about it. Reading it does not change what is owed; releasing held distance is the review queue\'s job, not this endpoint\'s.',
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    query: DayParamSchema,
  },
  responses: {
    200: { description: 'The day.', content: json(DayDetailSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
    403: { description: 'Not permitted to read drivers.', content: json(ErrorBodySchema) },
    404: { description: 'No such driver.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/gps-audit/trips',
  tags: ['admin-drivers'],
  summary: "One day of a vehicle's trips",
  description: [
    'AC-25. The screen that settles disputes, entered the way the dispute arrives: a plate and a date.',
    '',
    'Keyed on the vehicle rather than the driver, because an advertiser disputing an invoice is disputing distance their livery was carried, and the livery is on the car. A vehicle handed to a relief driver mid-campaign was still working, and filing that afternoon under a second person would split one day of billed kilometres in two.',
    '',
    'Carries the advertiser charge alongside the driver earning, which the driver-facing version of this day deliberately does not.',
  ].join('\n'),
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  request: { query: AuditDayQuerySchema },
  responses: {
    200: {
      description: 'The day. Zero totals and an empty list for a day the vehicle did not work.',
      content: json(AuditDaySchema),
    },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
    403: { description: 'Not permitted to audit trips.', content: json(ErrorBodySchema) },
    404: { description: 'No vehicle carries that registration.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/gps-audit/trips/{id}',
  tags: ['admin-drivers'],
  summary: 'One trip, opened up',
  description: [
    'The priced ground underneath a trip: where it ran, which zone each stretch was classified into, the rate that applied and the money that followed.',
    '',
    'Returned as runs rather than raw segments. A segment is one pair of GPS fixes seconds apart, and an afternoon is thousands of them; consecutive segments agreeing on zone, state and flag reason are the same fact about the journey, so they are merged and counted. A trip that enters and leaves Prime is therefore several runs, not one — which is the whole point of looking.',
  ].join('\n'),
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'The trip.', content: json(TripDetailSchema) },
    401: commonErrorResponses[401],
    403: { description: 'Not permitted to audit trips.', content: json(ErrorBodySchema) },
    404: { description: 'No such trip.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/driver/tracking/eligibility',
  tags: ['driver-portal'],
  summary: 'Whether this driver may start tracking',
  description:
    'The AC-07 conditions, each with a remedy when it fails. The same shape the app draws its checklist from.',
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  responses: {
    200: { description: 'The checklist.', content: json(z.unknown()) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/driver/tracking/session',
  tags: ['driver-portal'],
  summary: 'Start tracking',
  description:
    'Refused unless every AC-07 condition holds, and refused by the server rather than only by a disabled button. A driver may hold one session at a time across all their devices (AC-08.6); starting again returns the session they already have, because a phone that lost the response and retried needs to find it rather than a conflict it cannot act on.',
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  request: { body: { content: json(StartSessionRequestSchema) } },
  responses: {
    200: { description: 'Tracking is running.', content: json(TrackingSessionSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
    409: {
      description: 'A condition is unmet, or no campaign is assigned.',
      content: json(ErrorBodySchema),
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/driver/tracking/session',
  tags: ['driver-portal'],
  summary: 'The running session, or null',
  description:
    'Kilometres and earnings are summed from the segments on every read rather than held as a counter, so the figure on the phone and the figure in a payout run cannot drift apart.',
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  responses: {
    200: {
      description: 'The session, or null when nothing is running.',
      content: json(TrackingSessionSchema.nullable()),
    },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/driver/tracking/session',
  tags: ['driver-portal'],
  summary: 'Stop tracking',
  description:
    'Ends the session. Fixes already uploaded keep their segments and their money; stopping is not a withdrawal.',
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  request: { body: { content: json(StopSessionRequestSchema) } },
  responses: {
    200: { description: 'Stopped.', content: json(TrackingSessionSchema) },
    401: commonErrorResponses[401],
    404: { description: 'Nothing was running.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/driver/tracking/points',
  tags: ['driver-portal'],
  summary: 'Upload a batch of GPS fixes',
  description: [
    'Safe to retry. The phone deletes its local buffer only after a 2xx, so every lost response produces a re-send of a batch already stored; the fix id and the segment key make the second copy a no-op rather than a second kilometre (AC-16.10).',
    '',
    'The batch is priced as it lands: fixes are graded on accuracy, paired into segments, split at every zone boundary they cross, and charged at the rates in force. Eligibility is re-checked per batch, so a campaign paused mid-shift stops the meter from that moment (AC-07.3).',
  ].join('\n'),
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  request: { body: { content: json(TrackingPointsRequestSchema) } },
  responses: {
    200: { description: 'Stored and priced.', content: json(TrackingIngestResultSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
    404: { description: 'No such session for this driver.', content: json(ErrorBodySchema) },
  },
});
