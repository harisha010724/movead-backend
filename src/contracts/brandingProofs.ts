import { commonErrorResponses, ErrorBodySchema, IdParamSchema } from './common';
import { registry, z } from './registry';

/**
 * Driver wrap-photo checks. Installation evidence stays AC-06; this is the
 * mid-campaign proof that the ads vehicle still carries the wrap, taken by
 * the driver with a location the server recorded.
 */

export const BrandingAngleSchema = registry.register(
  'BrandingProofAngle',
  z.enum(['FRONT', 'REAR', 'LEFT', 'RIGHT', 'AD_CLOSEUP']),
);

export const BrandingProofStatusSchema = registry.register(
  'BrandingProofStatus',
  z.enum(['REQUESTED', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED']),
);

export const BrandingPhotoQuerySchema = z.object({
  angle: BrandingAngleSchema,
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  capturedAt: z.iso.datetime({ offset: true }),
});

export const PhotoIdParamSchema = z.object({ photoId: z.uuid() });

export const CampaignPhotoParamSchema = z.object({
  id: z.uuid(),
  photoId: z.uuid(),
});

export const BrandingProofPhotoSchema = registry.register(
  'BrandingProofPhoto',
  z.object({
    id: z.uuid(),
    angle: BrandingAngleSchema,
    fileName: z.string(),
    lat: z.number(),
    lon: z.number(),
    capturedAt: z.string(),
    uploadedAt: z.string(),
  }),
);

export const BrandingProofSchema = registry.register(
  'BrandingProof',
  z.object({
    id: z.uuid(),
    assignmentId: z.uuid(),
    campaignId: z.uuid(),
    campaignName: z.string(),
    registrationNumber: z.string(),
    driverName: z.string(),
    vehicleCategory: z.string(),
    status: BrandingProofStatusSchema,
    dueAt: z.string(),
    requestedAt: z.string(),
    submittedAt: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    rejectionReason: z.string().nullable(),
    photoCount: z.int(),
    required: z.array(BrandingAngleSchema),
    uploaded: z.array(BrandingAngleSchema),
    photos: z.array(BrandingProofPhotoSchema),
  }),
);

export const EligibleAssignmentSchema = registry.register(
  'BrandingProofEligibleAssignment',
  z.object({
    assignmentId: z.uuid(),
    campaignId: z.uuid(),
    campaignName: z.string(),
    registrationNumber: z.string(),
    driverName: z.string(),
  }),
);

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

registry.registerPath({
  method: 'get',
  path: '/v1/admin/branding-proofs',
  tags: ['admin-installations'],
  summary: 'Recently sent wrap photos',
  description: 'Requires `branding.review`. Published checks, oldest first. Advertisers see the same photos on the campaign.',
  security: [{ cookieAuth: [] }],
  responses: {
    200: {
      description: 'Published wrap-photo sets.',
      content: json(z.object({ items: z.array(BrandingProofSchema) })),
    },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/branding-proofs/waiting',
  tags: ['admin-installations'],
  summary: 'Requested wrap photos not yet submitted',
  security: [{ cookieAuth: [] }],
  responses: {
    200: {
      description: 'Outstanding requests.',
      content: json(z.object({ items: z.array(BrandingProofSchema) })),
    },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/branding-proofs/eligible',
  tags: ['admin-installations'],
  summary: 'Live assignments that can receive a wrap-photo request',
  security: [{ cookieAuth: [] }],
  responses: {
    200: {
      description: 'Live vehicles without an open check.',
      content: json(z.object({ items: z.array(EligibleAssignmentSchema) })),
    },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/assignments/{id}/branding-proofs',
  tags: ['admin-installations'],
  summary: 'Ask a driver to photograph the wrap',
  description: 'Requires `branding.review`. Refused if a check is already open.',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    201: { description: 'Requested.', content: json(BrandingProofSchema) },
    409: { description: 'Already open, or the assignment is not live.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/branding-proof-photos/{photoId}',
  tags: ['admin-installations'],
  summary: 'One wrap photo',
  security: [{ cookieAuth: [] }],
  request: { params: PhotoIdParamSchema },
  responses: {
    200: { description: 'The image bytes.' },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/driver/branding-proof',
  tags: ['driver-portal'],
  summary: 'The open wrap-photo check, if any',
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'The open check, or null.', content: json(BrandingProofSchema.nullable()) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/driver/branding-proofs/{id}/photos',
  tags: ['driver-portal'],
  summary: 'Upload one wrap photo',
  description:
    'Multipart `file` plus `angle`, `lat`, `lon` and `capturedAt` as form fields (query parameters still accepted). Location is taken from the request, not from the file.',
  security: [{ bearerAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    201: { description: 'Stored.', content: json(BrandingProofSchema) },
    400: { description: 'Missing angle, stale capture, or unsupported file.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/driver/branding-proofs',
  tags: ['driver-portal'],
  summary: 'Start a wrap-photo set',
  description: 'The driver opens the camera flow. Returns the open check, or starts one on their live assignment.',
  security: [{ bearerAuth: [] }],
  responses: {
    201: { description: 'The open or newly started check.', content: json(BrandingProofSchema) },
    409: { description: 'No live campaign.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/driver/branding-proofs/{id}/submit',
  tags: ['driver-portal'],
  summary: 'Publish wrap photos to the advertiser',
  security: [{ bearerAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'Published.', content: json(BrandingProofSchema) },
    400: { description: 'An angle is still missing.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/campaigns/{id}/branding-proofs',
  tags: ['campaigns'],
  summary: 'Wrap photos for this campaign',
  description: 'GPS-stamped photos the driver took of the advertisement. Scoped to the signed-in advertiser.',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: {
      description: 'Published wrap-photo sets, newest first.',
      content: json(z.object({ items: z.array(BrandingProofSchema) })),
    },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/campaigns/{id}/branding-proof-photos/{photoId}',
  tags: ['campaigns'],
  summary: 'One wrap photo on this campaign',
  security: [{ cookieAuth: [] }],
  request: { params: CampaignPhotoParamSchema },
  responses: {
    200: { description: 'The image bytes.' },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/driver/branding-proof-photos/{photoId}',
  tags: ['driver-portal'],
  summary: 'The driver\'s own wrap photo',
  security: [{ bearerAuth: [] }],
  request: { params: PhotoIdParamSchema },
  responses: {
    200: { description: 'The image bytes.' },
    401: commonErrorResponses[401],
  },
});
