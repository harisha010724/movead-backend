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

registry.registerPath({
  method: 'get',
  path: '/v1/driver/tracking/eligibility',
  tags: ['driver-portal'],
  summary: 'Whether this driver may start tracking',
  description:
    'The five AC-07 conditions, each with a remedy when it fails. The same shape the app draws its checklist from.',
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
