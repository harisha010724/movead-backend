import { commonErrorResponses, ErrorBodySchema, IdParamSchema, MoneySchema } from './common';
import { ReasonBodySchema } from './drivers';
import { registry, z } from './registry';

/**
 * Assignment and installation — AC-22 and AC-06.
 *
 * The driver-facing shapes here are deliberately identical to the mobile app's
 * `Campaign` and `TrackingEligibility` types, so the phone and the driver web
 * portal read one contract rather than two that drift.
 */

export const AssignmentStatusSchema = registry.register(
  'AssignmentStatus',
  z.enum(['ASSIGNED', 'ACCEPTED', 'INSTALLING', 'ACTIVE', 'ENDED', 'WITHDRAWN']),
);

export const InstallationStatusSchema = registry.register(
  'InstallationStatus',
  z.enum(['SCHEDULED', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED']),
);

export const PhotoAngleSchema = registry.register(
  'InstallationPhotoAngle',
  z.enum(['FRONT', 'REAR', 'LEFT', 'RIGHT']),
);

export const AssignmentSchema = registry.register(
  'CampaignVehicleAssignment',
  z.object({
    id: z.uuid(),
    campaignId: z.uuid(),
    vehicleId: z.uuid(),
    driverId: z.uuid(),
    registrationNumber: z.string(),
    driverName: z.string(),
    vehicleCategory: z.string(),
    status: AssignmentStatusSchema,
    assignedAt: z.string(),
    acceptedAt: z.string().nullable(),
    activatedAt: z.string().nullable(),
    overrideReason: z
      .string()
      .nullable()
      .describe('Set when the vehicle failed a requirement and was assigned anyway (AC-22.3).'),
    installation: z
      .object({
        status: InstallationStatusSchema,
        photoCount: z.int(),
        requiredCount: z.int(),
        rejectionReason: z.string().nullable(),
        submittedAt: z.string().nullable(),
        reviewedAt: z.string().nullable(),
      })
      .nullable(),
  }),
);

export const AssignmentListSchema = registry.register(
  'CampaignVehicleAssignmentList',
  z.object({
    items: z.array(AssignmentSchema),
    summary: z.object({
      requested: z.int().describe('Vehicles the advertiser asked for (AC-22.4).'),
      assigned: z.int(),
      accepted: z.int(),
      installing: z.int(),
      active: z.int(),
    }),
  }),
);

export const AssignVehiclesSchema = registry.register(
  'AssignVehiclesRequest',
  z.object({
    vehicleIds: z.array(z.uuid()).min(1).max(200),
    overrideReason: z
      .string()
      .min(10)
      .max(500)
      .optional()
      .describe('Required only when a vehicle fails a requirement (AC-22.3).'),
  }),
);

export const InstallationPhotoQuerySchema = z.object({ angle: PhotoAngleSchema });
export const PhotoIdParamSchema = z.object({ photoId: z.uuid() });

export const InstallationPhotoSchema = registry.register(
  'InstallationPhoto',
  z.object({
    id: z.uuid(),
    angle: PhotoAngleSchema,
    fileName: z.string(),
    uploadedAt: z.string(),
  }),
);

export const PhotoUploadResponseSchema = registry.register(
  'InstallationPhotoUploadResponse',
  z.object({
    angle: PhotoAngleSchema,
    uploaded: z.array(PhotoAngleSchema),
    required: z.array(PhotoAngleSchema).describe('Per vehicle type, per AC-06.4.'),
  }),
);

// --- Driver-facing --------------------------------------------------------

export const DriverCampaignStatusSchema = registry.register(
  'DriverCampaignStatus',
  z
    .enum(['requested', 'assigned', 'installation_pending', 'active', 'paused', 'completed'])
    .describe(
      '`requested` is an advertiser having picked this vehicle with operations not having confirmed it (AC-22.4). It carries no assignment and nothing can be done with it; every other value follows a real `campaign_vehicles` row.',
    ),
);

export const DriverRateCardSchema = registry.register(
  'DriverRateCard',
  z.object({
    model: z.literal('zoned'),
    zones: z.array(
      z.object({ zone: z.string(), label: z.string(), ratePerKm: MoneySchema }),
    ),
  }),
);

export const DriverCampaignSchema = registry.register(
  'DriverCampaign',
  z.object({
    id: z.uuid(),
    assignmentId: z
      .uuid()
      .nullable()
      .describe('Null when `status` is `requested`. There is nothing to accept yet.'),
    name: z.string(),
    brandName: z.string(),
    logoUrl: z.string().nullable(),
    creativeUrl: z.string().nullable(),
    status: DriverCampaignStatusSchema,
    startDate: z.string(),
    endDate: z.string(),
    vehicleId: z.uuid(),
    vehicleRegistration: z.string(),
    rateCard: DriverRateCardSchema,
    payoutType: z.literal('per_km'),
    minMonthlyTargetKm: z.number(),
    expectedMonthlyEarning: MoneySchema,
    elapsedDays: z.int(),
    totalDays: z.int(),
    daysLeft: z.int(),
    achievedKm: z.number(),
    terms: z.array(z.string()),
    areas: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        zone: z.string(),
        polygon: z.array(z.object({ lat: z.number(), lng: z.number() })),
      }),
    ),
    installation: z
      .object({
        status: InstallationStatusSchema,
        scheduledFor: z.string().nullable(),
        rejectionReason: z.string().nullable(),
      })
      .nullable(),
  }),
);

export const EligibilitySchema = registry.register(
  'TrackingEligibility',
  z.object({
    eligible: z.boolean(),
    checks: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        passed: z.boolean(),
        remedy: z.string().nullable().describe('What to do next; null when the check passes.'),
      }),
    ),
  }),
);

export type AssignVehiclesRequest = z.infer<typeof AssignVehiclesSchema>;

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

registry.registerPath({
  method: 'post',
  path: '/v1/admin/campaigns/{id}/vehicles',
  tags: ['admin-campaigns'],
  summary: 'Assign vehicles to a campaign',
  description:
    'Requires `campaign.assign`. Turns the advertiser\'s request into an assignment (AC-22.1). A vehicle that fails a requirement — wrong type, not approved — is refused unless `overrideReason` is supplied (AC-22.3). A vehicle already live on another campaign is always refused (AC-22.6).',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema, body: { content: json(AssignVehiclesSchema) } },
  responses: {
    201: { description: 'Assigned.', content: json(z.array(AssignmentSchema)) },
    400: { description: 'A vehicle fails a requirement.', content: json(ErrorBodySchema) },
    409: { description: 'Already on a live campaign.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/campaigns/{id}/vehicles',
  tags: ['admin-campaigns'],
  summary: 'Vehicles on a campaign, with installation progress',
  description: 'Requires `campaign.read`. The summary answers AC-22.8.',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'Assignments.', content: json(AssignmentListSchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/assignments/{id}/unassign',
  tags: ['admin-campaigns'],
  summary: 'Take a vehicle off a campaign',
  description:
    'Requires `campaign.assign`. AC-22.7: a reason is mandatory, and kilometres already earned in the assigned period are preserved.',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema, body: { content: json(ReasonBodySchema) } },
  responses: {
    200: { description: 'Unassigned.', content: json(AssignmentSchema) },
    409: { description: 'Already off the campaign.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/installations',
  tags: ['admin-installations'],
  summary: 'Installations awaiting review',
  description: 'Requires `installation.review`. Everything in SUBMITTED, oldest first.',
  security: [{ cookieAuth: [] }],
  responses: {
    200: {
      description: 'Queue.',
      content: json(z.object({ items: z.array(AssignmentSchema) })),
    },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/assignments/{id}/photos',
  tags: ['admin-installations'],
  summary: 'Upload one installation photo',
  description:
    'Requires `installation.upload`. Multipart with a single `file` and an `angle` query parameter. Re-uploading an angle replaces it, which is how a rejected installation is corrected (AC-06.9).',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    201: { description: 'Stored.', content: json(PhotoUploadResponseSchema) },
    400: { description: 'Unsupported type or too large.', content: json(ErrorBodySchema) },
    409: { description: 'Already approved.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/assignments/{id}/photos',
  tags: ['admin-installations'],
  summary: 'Photos on an installation',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: {
      description: 'Photos.',
      content: json(z.object({ items: z.array(InstallationPhotoSchema) })),
    },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/assignments/{id}/submit',
  tags: ['admin-installations'],
  summary: 'Send an installation for review',
  description:
    'Requires `installation.upload`. Refused until every photo required for the vehicle type is present (AC-06.5).',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'Submitted.', content: json(AssignmentSchema) },
    400: { description: 'Photos missing.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/assignments/{id}/approve',
  tags: ['admin-installations'],
  summary: 'Approve an installation and put the vehicle live',
  description:
    'Requires `installation.approve`. This is the only thing that makes a vehicle live on a campaign (AC-06.10). The account that submitted the evidence cannot approve it (AC-06.12).',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'Live.', content: json(AssignmentSchema) },
    409: {
      description: 'Not submitted, or the approver installed it.',
      content: json(ErrorBodySchema),
    },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/assignments/{id}/reject',
  tags: ['admin-installations'],
  summary: 'Reject an installation',
  description:
    'Requires `installation.approve`. AC-06.8: a reason is mandatory and is shown to the driver, who redoes the wrap (AC-06.9).',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema, body: { content: json(ReasonBodySchema) } },
  responses: {
    200: { description: 'Rejected.', content: json(AssignmentSchema) },
    409: { description: 'Not awaiting review.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/driver/campaign',
  tags: ['driver-portal'],
  summary: "The driver's current campaign",
  description:
    "Visible from the advertiser's vehicle request onward, not only once live: AC-22.5 requires the driver to accept before installation begins, and a driver whose vehicle has been picked has an interest in knowing before operations confirms it. `status` carries the stage and `assignmentId` is null until there is a real assignment. A confirmed assignment always outranks an outstanding request. Null when neither exists.",
  security: [{ cookieAuth: [] }],
  responses: {
    200: { description: 'Campaign, or null.', content: json(DriverCampaignSchema.nullable()) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/driver/assignments/{id}/accept',
  tags: ['driver-portal'],
  summary: 'Accept an assigned campaign',
  description: 'AC-22.5. Installation cannot be booked until the driver has accepted.',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: {
      description: 'Accepted.',
      content: json(z.object({ status: AssignmentStatusSchema })),
    },
    409: { description: 'Already accepted.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/driver/eligibility',
  tags: ['driver-portal'],
  summary: 'Whether this driver may start tracking',
  description:
    "AC-07's six conditions — the driver's own consent to be tracked (AC-04.3) among them — evaluated from live rows. Every unmet condition is returned with a remedy, per UI-036.3: the driver sees all of them, not just the first.",
  security: [{ cookieAuth: [] }],
  responses: {
    200: { description: 'Checks.', content: json(EligibilitySchema) },
    401: commonErrorResponses[401],
  },
});
