import { IdParamSchema, MoneySchema, commonErrorResponses, ErrorBodySchema } from './common';
import { registry, z } from './registry';

const json = (schema: z.ZodType) => ({ 'application/json': { schema } });

const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .openapi({ description: 'Civil day in Asia/Kolkata.', example: '2026-09-01' });

/** Empty means zero. Prime and Secondary are planned kilometres. */
const ZoneKmSchema = z
  .string()
  .regex(/^(\d+)?$/, 'Enter a whole number of kilometres')
  .optional()
  .default('');

const LatLngSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
});

export const CampaignLocationSchema = z.object({
  id: z.string().min(1),
  placeId: z.string(),
  label: z.string().min(1).max(240),
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  tier: z.enum(['prime', 'secondary']),
});

export const ZonePolygonsSchema = z.object({
  prime: z.object({ path: z.array(LatLngSchema).min(3).max(200) }).optional(),
  secondary: z.object({ path: z.array(LatLngSchema).min(3).max(200) }).optional(),
});

export const CampaignVehicleTypeSchema = z.enum(['CAB', 'AUTO']);

export const CampaignStatusSchema = z.enum([
  'DRAFT',
  'PENDING_CONFIRMATION',
  'PENDING_APPROVAL',
  'APPROVED',
  'AWAITING_INSTALLATION',
  'ACTIVE',
  'PAUSED',
  'BUDGET_WARNING',
  'STOPPED',
  'COMPLETED',
  'CANCELLED',
]);

export const CampaignSchema = registry.register(
  'Campaign',
  z.object({
    id: z.uuid(),
    name: z.string(),
    brandName: z.string(),
    status: CampaignStatusSchema,
    city: z.string(),
    vehicleType: CampaignVehicleTypeSchema,
    startDate: DateSchema,
    endDate: DateSchema,
    budget: MoneySchema,
    spent: MoneySchema,
    remaining: MoneySchema,
    zonePrime: MoneySchema,
    zoneSecondary: MoneySchema,
    zoneNetwork: MoneySchema,
    zonePrimeKm: z.string(),
    zoneSecondaryKm: z.string(),
    locations: z.array(CampaignLocationSchema),
    zonePolygons: ZonePolygonsSchema,
    requestedVehicleIds: z.array(z.uuid()),
    targetKm: z.string().nullable(),
    creativeKey: z.string().nullable(),
    creativeFileName: z.string().nullable(),
    vehicleCount: z.number().int(),
    verifiedKm: z.number(),
    impressions: z.number().int(),
  }),
);

export const AdminCampaignSchema = registry.register(
  'AdminCampaign',
  CampaignSchema.extend({
    advertiser: z.object({
      id: z.uuid(),
      legalName: z.string(),
      brandName: z.string(),
    }),
    createdBy: z.uuid(),
    submittedAt: z.string(),
  }),
);

export const AdminCampaignListSchema = registry.register(
  'AdminCampaignList',
  z.object({
    items: z.array(AdminCampaignSchema),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  }),
);

export const CampaignRejectRequestSchema = registry.register(
  'CampaignRejectRequest',
  z.object({
    reason: z
      .string()
      .trim()
      .min(10, 'Give a reason the advertiser can act on')
      .max(500),
  }),
);

/**
 * Halting a campaign that is already on the road costs a driver their earnings
 * for the duration and an advertiser their flight, so it is not a bare button:
 * the reason is written into the audit line and into what both of them are
 * told.
 */
export const CampaignHaltRequestSchema = registry.register(
  'CampaignHaltRequest',
  z.object({
    reason: z
      .string()
      .trim()
      .min(10, 'Give a reason the advertiser and the drivers can act on')
      .max(500),
  }),
);

export const CampaignListSchema = registry.register(
  'CampaignList',
  z.object({
    items: z.array(CampaignSchema),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  }),
);

export const CreateCampaignRequestSchema = registry.register(
  'CreateCampaignRequest',
  z.object({
    name: z.string().trim().min(3).max(80),
    brandName: z.string().trim().min(2).max(120),
    city: z.string().min(1).max(80),
    vehicleType: CampaignVehicleTypeSchema,
    startDate: DateSchema,
    endDate: DateSchema,
    zonePrimeKm: ZoneKmSchema,
    zoneSecondaryKm: ZoneKmSchema,
    locations: z.array(CampaignLocationSchema).max(40).optional().default([]),
    zonePolygons: ZonePolygonsSchema.optional().default({}),
    requestedVehicleIds: z.array(z.uuid()).max(80).optional().default([]),
    targetKm: z.string().optional(),
    creativeKey: z.string().min(1).optional(),
  }),
);

export const EstimateCampaignRequestSchema = registry.register(
  'EstimateCampaignRequest',
  z.object({
    city: z.string().min(1),
    vehicleType: CampaignVehicleTypeSchema,
    startDate: DateSchema,
    endDate: DateSchema,
    zonePrimeKm: ZoneKmSchema,
    zoneSecondaryKm: ZoneKmSchema,
  }),
);

export const EstimateCampaignResponseSchema = registry.register(
  'EstimateCampaignResponse',
  z.object({
    budget: MoneySchema,
    estimatedKm: z.object({
      prime: z.number(),
      secondary: z.number(),
      network: z.number(),
    }),
    estimatedSpend: z.object({
      prime: MoneySchema,
      secondary: MoneySchema,
      network: MoneySchema,
      total: MoneySchema,
    }),
    estimatedVehicles: z.number().int(),
    estimatedDays: z.number().int(),
  }),
);

export const AvailableVehiclesRequestSchema = registry.register(
  'AvailableVehiclesRequest',
  z.object({
    vehicleType: CampaignVehicleTypeSchema,
    zonePolygons: ZonePolygonsSchema,
  }),
);

export const AvailableVehicleSchema = registry.register(
  'AvailableVehicle',
  z.object({
    id: z.uuid(),
    vehicleType: CampaignVehicleTypeSchema,
    areaLabel: z.string(),
    lat: z.number().describe('The onboard pin, so the picker can map the vehicle.'),
    lng: z.number(),
    zone: z.enum(['prime', 'secondary']),
    status: z.string(),
    availability: z.enum(['available', 'booked', 'pending']).describe(
      'What a buyer can do with it now. Only `available` may be selected: `booked` is already carrying a live campaign (AC-22.6) and `pending` has not been approved by operations.',
    ),
    bookedUntil: z
      .string()
      .optional()
      .describe(
        'Present only when `availability` is `booked`: the end date of the campaign holding this vehicle, so a buyer can plan the next flight instead of asking when it frees up.',
      ),
    publicRef: z
      .string()
      .describe(
        'A stable, opaque reference for this vehicle. Retained alongside the plate for logs and support conversations; the screens name the vehicle by its plate.',
      ),
    registrationNumber: z
      .string()
      .describe(
        'The plate, shown to every audience. ADV-039 withholds driver *personal information*, and the vehicle a buyer is ordering is not that — see AC-22.4.',
      ),
    driverName: z
      .string()
      .optional()
      .describe(
        'Admin only, per ADV-039. Who is driving stays an operations matter even though the vehicle itself is named.',
      ),
  }),
);

export const AvailableVehiclesResponseSchema = registry.register(
  'AvailableVehiclesResponse',
  z.object({
    items: z.array(AvailableVehicleSchema),
    primeCount: z.number().int(),
    secondaryCount: z.number().int(),
    availableCount: z.number().int().describe('Of the listed vehicles, how many can be ordered.'),
  }),
);

export const CreativeUploadResponseSchema = registry.register(
  'CreativeUploadResponse',
  z.object({
    storageKey: z.string(),
    fileName: z.string(),
    contentType: z.string(),
    byteSize: z.number().int(),
  }),
);

export const CampaignListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: CampaignStatusSchema.optional(),
});

export const CreativeKeyParamSchema = z.object({
  userId: z.uuid(),
  fileName: z.string().min(1).max(80),
});

registry.registerPath({
  method: 'get',
  path: '/v1/campaigns',
  tags: ['campaigns'],
  summary: 'List this advertiser\'s campaigns',
  security: [{ cookieAuth: [] }],
  request: { query: CampaignListQuerySchema },
  responses: {
    200: { description: 'Campaigns.', content: json(CampaignListSchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/campaigns',
  tags: ['campaigns'],
  summary: 'Submit a campaign for review',
  description:
    'Requires `advertiser.campaign.create`. The campaign is owned by the signed-in advertiser and starts in PENDING_APPROVAL.',
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(CreateCampaignRequestSchema) } },
  responses: {
    201: { description: 'Created.', content: json(CampaignSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/campaigns/estimate',
  tags: ['campaigns'],
  summary: 'Estimate reach for a draft campaign',
  description:
    'Uses planned Prime and Secondary kilometres at the fixed rates (₹5/km and ₹2/km). Network is leftover geography at ₹1/km and is not planned. An estimate is not a commitment — billing is only for verified kilometres.',
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(EstimateCampaignRequestSchema) } },
  responses: {
    200: { description: 'Estimate.', content: json(EstimateCampaignResponseSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/vehicles/in-zones',
  tags: ['admin-vehicles'],
  summary: 'Vehicles whose operating pin sits in Prime or Secondary',
  description:
    'Same matching as the advertiser browse, but includes driver name and plate for operations. Requires `vehicle.read`.',
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(AvailableVehiclesRequestSchema) } },
  responses: {
    200: { description: 'Vehicles in the drawn zones.', content: json(AvailableVehiclesResponseSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/campaigns/available-vehicles',
  tags: ['campaigns'],
  summary: 'Vehicles whose operating pin sits in Prime or Secondary',
  description:
    'Requires `advertiser.vehicle.select`. Matching is the driver’s onboard pin against the draft outlines. Identity is withheld (no name, no plate). Assignment still needs admin confirmation (AC-22.4).',
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(AvailableVehiclesRequestSchema) } },
  responses: {
    200: { description: 'Vehicles in the drawn zones.', content: json(AvailableVehiclesResponseSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/campaigns/{id}',
  tags: ['campaigns'],
  summary: 'Read one of this advertiser\'s campaigns',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'The campaign.', content: json(CampaignSchema) },
    401: commonErrorResponses[401],
    404: { description: 'No such campaign on this account.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/campaigns/{id}',
  tags: ['campaigns'],
  summary: 'Update a campaign still in review',
  description:
    'Requires `advertiser.campaign.create`. Allowed while the campaign is DRAFT, PENDING_CONFIRMATION or PENDING_APPROVAL. After approval the campaign is locked.',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema, body: { content: json(CreateCampaignRequestSchema) } },
  responses: {
    200: { description: 'Updated.', content: json(CampaignSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
    404: { description: 'No such campaign on this account.', content: json(ErrorBodySchema) },
    409: { description: 'The campaign can no longer be edited.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/campaigns/creatives',
  tags: ['campaigns'],
  summary: 'Upload campaign artwork',
  description:
    'Multipart field `file`. PDF or PNG, up to 25 MB. Stored under the signed-in user\'s folder. Returns a storage key to send with campaign create.',
  security: [{ cookieAuth: [] }],
  request: {
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: z.string().openapi({ format: 'binary' }),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: 'Stored.', content: json(CreativeUploadResponseSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/campaigns/creatives/{userId}/{fileName}',
  tags: ['campaigns'],
  summary: 'Fetch uploaded artwork',
  security: [{ cookieAuth: [] }],
  request: { params: CreativeKeyParamSchema },
  responses: {
    200: { description: 'The file bytes.' },
    403: { description: 'Not this user\'s file.', content: json(ErrorBodySchema) },
    404: { description: 'No such file.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/campaigns',
  tags: ['admin-campaigns'],
  summary: 'List campaigns across advertisers',
  description: 'Requires `campaign.read`. Filter by status to build the review queue.',
  security: [{ cookieAuth: [] }],
  request: { query: CampaignListQuerySchema },
  responses: {
    200: { description: 'Campaigns.', content: json(AdminCampaignListSchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/campaigns/{id}',
  tags: ['admin-campaigns'],
  summary: 'Read a campaign for review',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'The campaign.', content: json(AdminCampaignSchema) },
    401: commonErrorResponses[401],
    404: { description: 'No such campaign.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/campaigns/{id}/creative',
  tags: ['admin-campaigns'],
  summary: 'Fetch the campaign artwork for review',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'The file bytes.' },
    401: commonErrorResponses[401],
    404: { description: 'No creative on this campaign.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/campaigns/{id}/approve',
  tags: ['admin-campaigns'],
  summary: 'Approve a campaign and send the creative to the printer',
  description:
    'Requires `campaign.approve`. Only PENDING_APPROVAL. Moves the campaign to APPROVED (at the printer). The admin who created the campaign cannot approve it (AC-34.7).',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'Approved and sent to print.', content: json(AdminCampaignSchema) },
    401: commonErrorResponses[401],
    403: { description: 'Creator cannot approve their own campaign.', content: json(ErrorBodySchema) },
    404: { description: 'No such campaign.', content: json(ErrorBodySchema) },
    409: { description: 'Not in review.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/campaigns/{id}/print-ready',
  tags: ['admin-campaigns'],
  summary: 'Mark printer wraps as received and start installation',
  description:
    'Requires `campaign.approve`. Only APPROVED. Moves the campaign to AWAITING_INSTALLATION and tells the advertiser the ads are being installed.',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'Print ready, installing.', content: json(AdminCampaignSchema) },
    401: commonErrorResponses[401],
    404: { description: 'No such campaign.', content: json(ErrorBodySchema) },
    409: { description: 'Not at the printer.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/campaigns/{id}/installed',
  tags: ['admin-campaigns'],
  summary: 'Mark wraps as installed and make the campaign live',
  description:
    'Requires `campaign.approve`. Only AWAITING_INSTALLATION, and only with at least one vehicle assigned — a campaign live on no vehicles can never report a kilometre, and leaves the driver whose vehicle was requested waiting on a confirmation that will not come. Moves the campaign to ACTIVE and tells the advertiser and every assigned driver.',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'Installed and live.', content: json(AdminCampaignSchema) },
    401: commonErrorResponses[401],
    404: { description: 'No such campaign.', content: json(ErrorBodySchema) },
    409: {
      description: 'Not being installed, or no vehicle is assigned.',
      content: json(ErrorBodySchema),
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/campaigns/{id}/reject',
  tags: ['admin-campaigns'],
  summary: 'Reject a campaign in review',
  description:
    'Requires `campaign.approve`. The campaign is cancelled. A reason is required so the advertiser knows what to fix.',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema, body: { content: json(CampaignRejectRequestSchema) } },
  responses: {
    200: { description: 'Rejected.', content: json(AdminCampaignSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
    404: { description: 'No such campaign.', content: json(ErrorBodySchema) },
    409: { description: 'Not in review.', content: json(ErrorBodySchema) },
  },
});

/*
 * What happens to a campaign after it goes live (AC-34.10).
 *
 * `PAUSED`, `STOPPED` and `COMPLETED` were in the status enum from the start
 * and every client already drew a badge for them, but nothing wrote them: a
 * campaign could be started and never stopped, and its vehicles stayed booked
 * to it for good.
 */

registry.registerPath({
  method: 'post',
  path: '/v1/admin/campaigns/{id}/pause',
  tags: ['admin-campaigns'],
  summary: 'Pause a running campaign',
  description:
    'Requires `campaign.approve`. Kilometres stop being billed and drivers stop being eligible to track, but the wraps stay on and the vehicles stay assigned so the same fleet resumes. Both the advertiser and every driver carrying it are told.',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema, body: { content: json(CampaignHaltRequestSchema) } },
  responses: {
    200: { description: 'Paused.', content: json(AdminCampaignSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
    404: { description: 'No such campaign.', content: json(ErrorBodySchema) },
    409: { description: 'Not running.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/campaigns/{id}/resume',
  tags: ['admin-campaigns'],
  summary: 'Resume a paused campaign',
  description:
    'Requires `campaign.approve`. Only PAUSED. Billing and driver tracking restart on the same vehicles.',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'Running again.', content: json(AdminCampaignSchema) },
    401: commonErrorResponses[401],
    404: { description: 'No such campaign.', content: json(ErrorBodySchema) },
    409: { description: 'Not paused.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/campaigns/{id}/complete',
  tags: ['admin-campaigns'],
  summary: 'Close a campaign that has run its course',
  description:
    'Requires `campaign.approve`. Ends every live assignment, which is what frees the vehicles for the next buyer — availability is read from the assignment, not from the vehicle row (AC-22.4a). Earnings and spend already recorded are untouched.',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'Completed.', content: json(AdminCampaignSchema) },
    401: commonErrorResponses[401],
    404: { description: 'No such campaign.', content: json(ErrorBodySchema) },
    409: { description: 'Not running or paused.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/campaigns/{id}/stop',
  tags: ['admin-campaigns'],
  summary: 'Stop a campaign before its end date',
  description:
    'Requires `campaign.approve`. The same release of vehicles as completing, but a decision to cut the flight short rather than the end of it, so a reason is required. The two are kept apart because a report that cannot tell them apart cannot say why a campaign underdelivered.',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema, body: { content: json(CampaignHaltRequestSchema) } },
  responses: {
    200: { description: 'Stopped.', content: json(AdminCampaignSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
    404: { description: 'No such campaign.', content: json(ErrorBodySchema) },
    409: { description: 'Not running or paused.', content: json(ErrorBodySchema) },
  },
});
