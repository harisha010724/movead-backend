import {
  commonErrorResponses,
  CursorQuerySchema,
  ErrorBodySchema,
  IdParamSchema,
  paginated,
} from './common';
import { registry, z } from './registry';

/**
 * Driver onboarding contracts (AC-04, AC-05).
 *
 * Two patterns run through all of it. A rejection always carries a reason,
 * because AC-05.5 gives the driver the right to be told what to fix. And
 * identifiers for media are storage keys, never URLs — the API mints a
 * short-lived presigned URL per request instead.
 */

const MobileSchema = z
  .string()
  .regex(/^[6-9]\d{9}$/, 'Ten digits, starting 6 to 9')
  .openapi({
    description: 'Indian mobile number, ten digits, no country code.',
    example: '9845012345',
  });

const RegistrationSchema = z
  .string()
  .min(6)
  .max(16)
  .openapi({ description: 'Normalised to uppercase without spaces.', example: 'KA01AB1234' });

/** Long enough to be a reason and not a shrug. Shown to the driver verbatim. */
const ReasonSchema = z.string().min(10).max(500).openapi({
  description: 'Shown to the driver so they can correct and resubmit.',
  example: 'The insurance certificate expired in June. Upload the current one.',
});

export const DriverStatusSchema = z.enum([
  'PENDING',
  'DOCUMENTS_SUBMITTED',
  'APPROVED',
  'SUSPENDED',
]);

export const VehicleStatusSchema = z.enum([
  'PENDING',
  'DOCUMENTS_VERIFIED',
  'APPROVED',
  'AVAILABLE',
  'ASSIGNED',
  'INSTALLING',
  'ACTIVE',
  'SUSPENDED',
  'REJECTED',
  'REMOVED',
]);

export const DocumentKindSchema = z.enum([
  'RC',
  'LICENCE',
  'INSURANCE',
  'POLLUTION',
  'PERMIT',
  'OTHER',
]);

export const DriverLocationSchema = registry.register(
  'DriverLocation',
  z.object({
    city: z.string(),
    label: z.string(),
    lat: z.number().gte(-90).lte(90),
    lng: z.number().gte(-180).lte(180),
  }),
);

const DriverLocationInputSchema = z.object({
  city: z.string().min(1).max(80).optional().default('Bengaluru'),
  label: z.string().trim().min(1).max(240),
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
});

export const DriverSchema = registry.register(
  'Driver',
  z.object({
    id: z.uuid(),
    mobile: z.string(),
    name: z.string(),
    photoKey: z.string().nullable(),
    status: DriverStatusSchema,
    suspendedReason: z.string().nullable(),
    rejectionReason: z.string().nullable(),
    joinedAt: z.string(),
    city: z.string(),
    location: DriverLocationSchema.nullable(),
  }),
);

/**
 * Six, because in India there are six.
 *
 * An enum rather than free text now that drivers type this themselves: the
 * difference between `CNG`, `cng` and `C.N.G.` is the difference between a
 * column operations can group by and one it can only read. Mirrored by the
 * `vehicles_fuel_type_known` check constraint, migration 022.
 */
export const FuelTypeSchema = registry.register(
  'FuelType',
  z.enum(['PETROL', 'DIESEL', 'CNG', 'LPG', 'ELECTRIC', 'HYBRID']),
);

/**
 * Next year is allowed. Vehicles are sold ahead of their model year, and a
 * driver holding an RC that says 2027 in December 2026 is not lying.
 */
const YearSchema = z
  .number()
  .int()
  .min(1990)
  .max(new Date().getFullYear() + 1);

export const VehicleSchema = registry.register(
  'Vehicle',
  z.object({
    id: z.uuid(),
    driverId: z.uuid(),
    registrationNumber: z.string(),
    category: z.enum(['AUTO', 'CAB']),
    bodyType: z.string().nullable(),
    makeModel: z.string().nullable(),
    colour: z.string().nullable(),
    manufactureYear: z.number().nullable(),
    fuelType: z.string().nullable(),
    imageKey: z.string().nullable(),
    imageUrl: z
      .string()
      .nullable()
      .describe(
        'A path behind the admin session, or null. `imageKey` is the object-store key and is no use to a browser; this is what an <img> can be pointed at.',
      ),
    status: VehicleStatusSchema,
    rejectionReason: z.string().nullable(),
    suspendedReason: z.string().nullable(),
  }),
);

/**
 * `missing`, `expiring` and `expired` are computed, not stored: the first is
 * the absence of a row, the others are a date comparison. A stored flag would
 * need a nightly job that races this screen to tell the truth.
 */
export const ChecklistItemSchema = registry.register(
  'DocumentChecklistItem',
  z.object({
    kind: DocumentKindSchema,
    isMandatory: z.boolean(),
    status: z.enum(['missing', 'uploaded', 'verified', 'rejected', 'expiring', 'expired']),
    documentId: z.uuid().nullable(),
    expiresOn: z.string().nullable(),
    rejectionReason: z.string().nullable(),
    contentType: z
      .string()
      .nullable()
      .describe('So the review screen knows whether to draw an image or a PDF frame.'),
    uploadedAt: z.string().nullable(),
  }),
);

export const DriverDetailSchema = registry.register(
  'DriverDetail',
  z.object({
    driver: DriverSchema,
    vehicles: z.array(VehicleSchema),
    driverDocuments: z.array(ChecklistItemSchema),
    vehicleDocuments: z.record(z.string(), z.array(ChecklistItemSchema)),
  }),
);

/**
 * Only the plate and the category are required.
 *
 * AC-04's registration list asks for a vehicle type and a registration number
 * and nothing else about the vehicle. An admin creating the account under
 * AC-32.1 has those two from a phone call; the descriptive fields are the
 * driver's to add from the app, and demanding them here would have forced the
 * admin to invent them.
 */
export const AddVehicleSchema = registry.register(
  'AddVehicleRequest',
  z.object({
    registrationNumber: RegistrationSchema,
    category: z.enum(['AUTO', 'CAB']),
    bodyType: z.string().min(2).max(60).nullish(),
    makeModel: z.string().min(2).max(80).nullish(),
    colour: z.string().min(2).max(40).nullish(),
    manufactureYear: YearSchema.nullish(),
    fuelType: FuelTypeSchema.nullish(),
  }),
);

/**
 * The vehicle is optional, and creating one here is atomic with the driver.
 *
 * An admin onboarding under AC-32.1 fills one form with a name, a number, a
 * vehicle type and a plate. Making them call two endpoints would mean a
 * duplicate plate leaves a driver behind and spends the mobile number, so the
 * natural retry fails on the wrong field.
 */
export const CreateDriverSchema = registry.register(
  'CreateDriverRequest',
  z.object({
    mobile: MobileSchema,
    name: z.string().min(2).max(120),
    email: z
      .email()
      .max(254)
      .toLowerCase()
      .openapi({ description: 'Sign-in username. The password is emailed here.' }),
    vehicle: AddVehicleSchema.nullish(),
    location: DriverLocationInputSchema.optional(),
  }),
);

export const CreatedDriverSchema = registry.register(
  'CreatedDriver',
  z.object({
    driver: DriverSchema,
    vehicle: VehicleSchema.nullable(),
    user: z
      .object({
        id: z.uuid(),
        email: z.string(),
        status: z.enum(['INVITED', 'ACTIVE']),
      })
      .nullable(),
    invitationEmailed: z.boolean(),
  }),
);

export const UpdateDriverSchema = registry.register(
  'UpdateDriverRequest',
  z.object({
    name: z.string().min(2).max(120).optional(),
    /** Correctable while PENDING only — see the endpoint description. */
    mobile: MobileSchema.optional(),
    photoKey: z.string().max(512).optional(),
    location: DriverLocationInputSchema.optional(),
  }),
);

export const UpdateVehicleSchema = registry.register(
  'UpdateVehicleRequest',
  z.object({
    registrationNumber: RegistrationSchema.optional(),
    category: z.enum(['AUTO', 'CAB']).optional(),
    bodyType: z.string().min(2).max(60).nullish(),
    makeModel: z.string().min(2).max(80).nullish(),
    colour: z.string().min(2).max(40).nullish(),
    manufactureYear: YearSchema.nullish(),
    fuelType: FuelTypeSchema.nullish(),
  }),
);

export const RegisterDocumentSchema = registry.register(
  'RegisterDocumentRequest',
  z
    .object({
      kind: DocumentKindSchema,
      driverId: z.uuid().optional(),
      vehicleId: z.uuid().optional(),
      storageKey: z.string().min(1).max(512),
      contentType: z.string().min(3).max(120),
      byteSize: z.number().int().positive(),
      documentNumber: z.string().max(60).optional(),
      issuedOn: z.iso.date().optional(),
      expiresOn: z.iso.date().optional(),
    })
    .refine((value) => (value.driverId === undefined) !== (value.vehicleId === undefined), {
      message: 'A document belongs to exactly one of a driver or a vehicle',
    }),
);

/**
 * The driver's own view of what they have been asked for.
 *
 * One flat list rather than the admin's driver/vehicle split: the driver holds
 * their licence and their vehicle's papers in the same wallet, and `owner` is
 * carried only so the server knows where to file the row.
 */
export const DriverDocumentItemSchema = registry.register(
  'DriverDocumentItem',
  z.object({
    kind: DocumentKindSchema,
    owner: z.enum(['DRIVER', 'VEHICLE']),
    isMandatory: z.boolean(),
    expires: z
      .boolean()
      .describe('Whether this kind lapses, and therefore whether `expiresOn` is required on upload.'),
    status: z.enum(['missing', 'uploaded', 'verified', 'rejected', 'expiring', 'expired']),
    documentId: z.uuid().nullable(),
    expiresOn: z.string().nullable(),
    rejectionReason: z.string().nullable(),
    uploadedAt: z.string().nullable(),
  }),
);

/**
 * Multipart, so every field arrives as text — `kind` is coerced by the enum and
 * the dates are parsed from strings rather than trusted as JSON types.
 */
export const UploadDocumentSchema = registry.register(
  'UploadDocumentRequest',
  z.object({
    kind: DocumentKindSchema,
    documentNumber: z.string().trim().min(1).max(60).optional(),
    expiresOn: z.iso.date().optional(),
  }),
);

export const ReasonBodySchema = registry.register(
  'ReasonRequest',
  z.object({ reason: ReasonSchema }),
);

export const DriverListQuerySchema = CursorQuerySchema.extend({
  status: DriverStatusSchema.optional(),
  search: z.string().min(1).max(60).optional(),
});

/**
 * The onboarding queue's row. Deliberately not `Driver`: the screen shows a
 * plate and a vehicle type beside every name, and a list that omitted them
 * would force the client into one request per row to render a table.
 */
export const DriverListItemSchema = registry.register(
  'DriverListItem',
  z.object({
    id: z.uuid(),
    name: z.string(),
    mobile: z.string(),
    status: DriverStatusSchema,
    photoKey: z.string().nullable(),
    joinedAt: z.string(),
    city: z.string(),
    location: DriverLocationSchema.nullable(),
    vehicle: z
      .object({
        id: z.uuid(),
        registrationNumber: z.string(),
        category: z.enum(['AUTO', 'CAB']),
        status: VehicleStatusSchema,
      })
      .nullable()
      .openapi({ description: 'Null until a vehicle has been added to the driver.' }),
  }),
);

export const DriverPageSchema = registry.register('DriverPage', paginated(DriverListItemSchema));

export type CreateDriver = z.infer<typeof CreateDriverSchema>;
export type UpdateDriver = z.infer<typeof UpdateDriverSchema>;
export type AddVehicle = z.infer<typeof AddVehicleSchema>;
export type RegisterDocument = z.infer<typeof RegisterDocumentSchema>;

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const secured = [{ cookieAuth: [] }];

/**
 * The five endpoints that reject or suspend something share a shape: an id in
 * the path, a mandatory reason in the body, and the same failure modes.
 * Declaring it once keeps the reason requirement from drifting between them.
 */
const reasoned = (summary: string, description: string, response: z.ZodType) => ({
  summary,
  description,
  security: secured,
  request: {
    params: IdParamSchema,
    body: { content: json(ReasonBodySchema) },
  },
  responses: {
    200: { description: 'Updated.', content: json(response) },
    401: commonErrorResponses[401],
    403: { description: 'Missing permission.', content: json(ErrorBodySchema) },
    404: { description: 'Not found.', content: json(ErrorBodySchema) },
    422: {
      description: 'The transition is not allowed from the current state.',
      content: json(ErrorBodySchema),
    },
    400: commonErrorResponses[400],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/drivers',
  tags: ['admin-drivers'],
  summary: 'Create a driver record, and optionally their vehicle',
  description:
    'AC-32.1. The admin opens the account; the driver completes their own details from the app. The driver starts PENDING and cannot receive campaigns. Passing a vehicle creates it in the same transaction, so a duplicate plate leaves no driver behind.',
  security: secured,
  request: { body: { content: json(CreateDriverSchema) } },
  responses: {
    201: { description: 'Created.', content: json(CreatedDriverSchema) },
    409: {
      description:
        'That mobile, email or plate is already registered. Nothing was created.',
      content: json(ErrorBodySchema),
    },
    401: commonErrorResponses[401],
    400: commonErrorResponses[400],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/drivers',
  tags: ['admin-drivers'],
  summary: 'The onboarding queue',
  description: 'Filter by status to work the review queue. Cursor paginated, newest first.',
  security: secured,
  request: { query: DriverListQuerySchema },
  responses: {
    200: { description: 'A page of drivers.', content: json(DriverPageSchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/drivers/{id}',
  tags: ['admin-drivers'],
  summary: 'Everything the reviewer needs on one screen',
  description:
    'The driver, their vehicles, and a document checklist for each — including what is missing.',
  security: secured,
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'The driver in full.', content: json(DriverDetailSchema) },
    404: { description: 'No such driver.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/admin/drivers/{id}',
  tags: ['admin-drivers'],
  summary: 'Correct a driver’s details',
  description:
    'The mobile number can only be changed while the driver is PENDING. Past that they have signed in with it, and changing it would lock them out of their own account.',
  security: secured,
  request: { params: IdParamSchema, body: { content: json(UpdateDriverSchema) } },
  responses: {
    200: { description: 'Updated.', content: json(DriverSchema) },
    404: { description: 'No such driver.', content: json(ErrorBodySchema) },
    409: {
      description: 'That mobile number already has an account.',
      content: json(ErrorBodySchema),
    },
    422: {
      description: 'The driver is past PENDING, so the mobile is locked.',
      content: json(ErrorBodySchema),
    },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/admin/drivers/{id}',
  tags: ['admin-drivers'],
  summary: 'Remove a driver from the platform, with a reason',
  description:
    'Archives rather than erases. The audit trail references the driver and is append-only (AC-31.5), so the row survives with `deletedAt` and the reason set, and disappears from every list. Their vehicles move to REMOVED, which frees both the mobile number and the plate for re-use.',
  security: secured,
  request: { params: IdParamSchema, body: { content: json(ReasonBodySchema) } },
  responses: {
    200: { description: 'Archived.', content: json(DriverSchema) },
    400: commonErrorResponses[400],
    404: { description: 'No such driver, or already removed.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
    403: { description: 'Missing permission.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/admin/vehicles/{id}',
  tags: ['admin-vehicles'],
  summary: 'Correct a vehicle’s details',
  description:
    'Only while PENDING. Once documents have been verified they were verified against a plate, and changing it afterwards would carry that approval to a different vehicle (AC-05.7). Past PENDING, reject and add the correct vehicle.',
  security: secured,
  request: { params: IdParamSchema, body: { content: json(UpdateVehicleSchema) } },
  responses: {
    200: { description: 'Updated.', content: json(VehicleSchema) },
    404: { description: 'No such vehicle.', content: json(ErrorBodySchema) },
    409: {
      description: 'That registration is already on the platform.',
      content: json(ErrorBodySchema),
    },
    422: {
      description: 'The vehicle is past PENDING and can no longer be corrected.',
      content: json(ErrorBodySchema),
    },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/drivers/{id}/approve',
  tags: ['admin-drivers'],
  summary: 'Approve a driver',
  description: 'Refused while any mandatory document of theirs is unverified.',
  security: secured,
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'Approved.', content: json(DriverSchema) },
    422: { description: 'Documents are still outstanding.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/drivers/{id}/reject',
  tags: ['admin-drivers'],
  ...reasoned(
    'Reject a driver, with a reason',
    'Returns them to PENDING with the reason recorded, because AC-05.5 gives them the right to correct and resubmit.',
    DriverSchema,
  ),
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/drivers/{id}/suspend',
  tags: ['admin-drivers'],
  ...reasoned('Suspend a driver, with a reason', 'A suspended driver cannot track.', DriverSchema),
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/drivers/{id}/reinstate',
  tags: ['admin-drivers'],
  summary: 'Lift a driver’s suspension',
  description: 'Returns them to APPROVED and clears the suspension reason.',
  security: secured,
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'Reinstated.', content: json(DriverSchema) },
    422: { description: 'That driver is not suspended.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/drivers/{id}/vehicles',
  tags: ['admin-vehicles'],
  summary: 'Add a vehicle to a driver',
  description:
    'Registration is unique platform-wide: a plate identifies one physical vehicle (AC-05.7).',
  security: secured,
  request: { params: IdParamSchema, body: { content: json(AddVehicleSchema) } },
  responses: {
    201: { description: 'Created, PENDING review.', content: json(VehicleSchema) },
    409: {
      description: 'That registration is already on the platform.',
      content: json(ErrorBodySchema),
    },
    401: commonErrorResponses[401],
    400: commonErrorResponses[400],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/vehicles/{id}/verify-documents',
  tags: ['admin-vehicles'],
  summary: 'Mark a vehicle’s documents verified',
  description:
    'Step one of AC-05.2. Refused while any mandatory vehicle document is unverified, so the state cannot become a label.',
  security: secured,
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'Moved to DOCUMENTS_VERIFIED.', content: json(VehicleSchema) },
    422: {
      description: 'Documents outstanding, or the transition is not allowed.',
      content: json(ErrorBodySchema),
    },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/vehicles/{id}/approve',
  tags: ['admin-vehicles'],
  summary: 'Approve a vehicle',
  description:
    'Only from DOCUMENTS_VERIFIED. An unapproved vehicle can never generate billable kilometres (AC-05.4).',
  security: secured,
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'Approved.', content: json(VehicleSchema) },
    422: { description: 'Not allowed from the current state.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/vehicles/{id}/reject',
  tags: ['admin-vehicles'],
  ...reasoned(
    'Reject a vehicle, with a reason',
    'The reason is shown to the driver, who can correct and resubmit.',
    VehicleSchema,
  ),
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/vehicles/{id}/suspend',
  tags: ['admin-vehicles'],
  ...reasoned(
    'Suspend a vehicle, with a reason',
    'AC-05.8. Stops the vehicle earning and, once tracking exists, ends any live session.',
    VehicleSchema,
  ),
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/vehicles/{id}/reinstate',
  tags: ['admin-vehicles'],
  summary: 'Lift a vehicle’s suspension',
  description: 'Returns it to APPROVED and clears the suspension reason.',
  security: secured,
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'Reinstated.', content: json(VehicleSchema) },
    422: { description: 'Not allowed from the current state.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/vehicles/{id}/history',
  tags: ['admin-vehicles'],
  summary: 'Every state this vehicle has been in',
  description:
    'AC-05.3. Disputes about when a vehicle became billable are settled by reading these rows.',
  security: secured,
  request: { params: IdParamSchema },
  responses: {
    200: {
      description: 'Newest first.',
      content: json(z.array(z.record(z.string(), z.unknown()))),
    },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/documents',
  tags: ['admin-documents'],
  summary: 'Register an uploaded document',
  description:
    'Records the storage key of a file already uploaded to object storage. A current document of the same kind is superseded, not overwritten, so a rejected copy survives for the appeal.',
  security: secured,
  request: { body: { content: json(RegisterDocumentSchema) } },
  responses: {
    201: {
      description: 'Recorded, awaiting review.',
      content: json(z.record(z.string(), z.unknown())),
    },
    401: commonErrorResponses[401],
    400: commonErrorResponses[400],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/documents/{id}/file',
  tags: ['admin-documents'],
  summary: 'Read a document for review',
  description:
    'The bytes, inline, so an operator can look at a licence before deciding on it. Behind `document.read` rather than `document.verify`: looking is a lower bar than deciding, and who looked is answerable through the audit trail. A `404` naming the *file* rather than the document means storage and the database have diverged.',
  security: secured,
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'The file.' },
    401: commonErrorResponses[401],
    403: { description: 'Missing permission.', content: json(ErrorBodySchema) },
    404: { description: 'No such document, or its bytes are gone.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/documents/{id}/verify',
  tags: ['admin-documents'],
  summary: 'Verify a document',
  description:
    'Refused for an already-expired document: verifying one would make a vehicle billable on a lapsed certificate.',
  security: secured,
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'Verified.', content: json(z.record(z.string(), z.unknown())) },
    422: { description: 'Expired or superseded.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/documents/{id}/reject',
  tags: ['admin-documents'],
  ...reasoned(
    'Reject a document, with a reason',
    'The reason reaches the driver, who uploads a replacement that supersedes this one.',
    z.record(z.string(), z.unknown()),
  ),
});

// --- Driver-facing ---------------------------------------------------------

/**
 * Lowercase, unlike `DriverStatusSchema` above, which is the admin's view of
 * the same column. Every driver-facing enum on this API is lowercase; both
 * clients declare it that way, and the two audiences are separate contracts
 * that happen to read one table.
 */
export const DriverPortalStatusSchema = registry.register(
  'DriverPortalStatus',
  z.enum(['pending', 'documents_submitted', 'approved', 'suspended']),
);

export const PincodeSchema = z
  .string()
  .regex(/^[1-9][0-9]{5}$/, 'A PIN code is six digits and does not start with a zero.');

export const IfscSchema = z
  .string()
  .transform((value) => value.toUpperCase())
  .pipe(
    z
      .string()
      .regex(
        /^[A-Z]{4}0[A-Z0-9]{6}$/,
        'An IFSC is eleven characters: four letters, a zero, then six more.',
      ),
  );

export const DriverAddressSchema = registry.register(
  'DriverAddress',
  z.object({
    line1: z.string().min(3).max(160),
    line2: z.string().max(160).nullish(),
    city: z.string().min(2).max(80),
    state: z.string().min(2).max(80),
    pincode: PincodeSchema,
  }),
);

/**
 * What a driver may be shown about their own payout details without asking
 * again (AC-04.6). Enough to recognise the account, not enough to use it.
 */
export const MaskedPayoutSchema = registry.register(
  'MaskedPayout',
  z.discriminatedUnion('method', [
    z.object({
      method: z.literal('BANK'),
      accountName: z.string(),
      accountNumberMasked: z.string(),
      ifsc: z.string(),
    }),
    z.object({ method: z.literal('UPI'), upiIdMasked: z.string() }),
  ]),
);

export const PayoutDetailsSchema = registry.register(
  'PayoutDetails',
  z.discriminatedUnion('method', [
    z.object({
      method: z.literal('BANK'),
      accountName: z.string().min(2).max(120),
      accountNumber: z
        .string()
        .regex(/^[0-9]{9,18}$/, 'An account number is 9 to 18 digits, with no spaces.'),
      ifsc: IfscSchema,
    }),
    z.object({
      method: z.literal('UPI'),
      upiId: z
        .string()
        .regex(/^[a-zA-Z0-9._-]{2,64}@[a-zA-Z]{2,32}$/, 'A UPI id looks like name@bank.'),
    }),
  ]),
);

export const ConsentStateSchema = registry.register(
  'ConsentState',
  z.object({
    granted: z.boolean(),
    recordedAt: z.iso
      .datetime()
      .nullable()
      .describe('When the current state began. Null when the driver has never been asked.'),
    policyVersion: z
      .string()
      .nullable()
      .describe('The disclosure they agreed to. Consent to unrecorded wording proves nothing.'),
  }),
);

export const UpdateDriverProfileSchema = registry.register(
  'UpdateDriverProfileRequest',
  z
    .object({
      name: z.string().min(2).max(120).optional(),
      // Explicit null clears it; absent leaves it alone. The two are different
      // intentions and a screen with an empty optional field means the second.
      address: DriverAddressSchema.nullish(),
      payout: PayoutDetailsSchema.nullish(),
    })
    .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change.'),
);

export const SetConsentSchema = registry.register(
  'SetConsentRequest',
  z.object({ granted: z.boolean() }),
);

export const DriverProfileSchema = registry.register(
  'DriverProfile',
  z.object({
    id: z.uuid(),
    name: z.string(),
    mobile: MobileSchema,
    status: DriverPortalStatusSchema,
    statusReason: z
      .string()
      .nullable()
      .describe('Why they are suspended or were rejected, verbatim. Null when there is nothing to explain.'),
    canTrack: z
      .boolean()
      .describe(
        'AC-05: the driver is approved and so is their vehicle. This is what the clients badge on — never the status string.',
      ),
    photoUrl: z
      .string()
      .nullable()
      .describe(
        'A path, not an absolute URL, and null until the driver sends one. Behind the driver session like the campaign creative, so a client must attach its token rather than pass this to a plain image loader.',
      ),
    joinedAt: z.iso.datetime(),
    vehicle: z
      .object({
        registrationNumber: RegistrationSchema,
        category: z.enum(['CAB', 'AUTO']),
        makeModel: z.string(),
      })
      .nullable(),
    email: z
      .email()
      .nullable()
      .describe(
        'The sign-in username. Read-only to the driver (UI-013.5) — changing it would move the account to a mailbox nobody audited, so it is an admin action.',
      ),
    address: DriverAddressSchema.nullable(),
    payout: MaskedPayoutSchema.nullable().describe(
      'Masked (AC-04.6). The account number is never returned here; POST /v1/driver/me/payout/reveal is the explicit action that returns it.',
    ),
    consent: z.object({ locationTracking: ConsentStateSchema }),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/v1/driver/me',
  tags: ['driver-portal'],
  summary: 'The signed-in driver',
  description:
    'The account behind the session, for the Android app and the driver web portal alike. Accepts a driver cookie or a driver bearer token.',
  security: [{ cookieAuth: [] }, { bearerAuth: [] }],
  responses: {
    200: { description: 'The driver.', content: json(DriverProfileSchema) },
    401: commonErrorResponses[401],
  },
});

/** A driver arrives with a cookie from the browser or a bearer token from the app. */
const driverSecured: Record<string, string[]>[] = [{ cookieAuth: [] }, { bearerAuth: [] }];

registry.registerPath({
  method: 'patch',
  path: '/v1/driver/me',
  tags: ['driver-portal'],
  summary: 'Update your own name, address or payout details',
  description: [
    'The only write a driver may make about themselves, and deliberately narrow.',
    '',
    'Mobile and email are absent because UI-013.5 makes both admin corrections — a driver who could change their email could move their own account to a mailbox nobody audited. Status and the operating pin are absent because a driver moving their own pin would be choosing which zone rate they earn.',
    '',
    'Payout details replace wholesale rather than merge, so switching from a bank account to a UPI id cannot leave the old account behind for a payout run to find.',
  ].join('\n'),
  security: driverSecured,
  request: { body: { content: json(UpdateDriverProfileSchema) } },
  responses: {
    200: { description: 'The updated profile.', content: json(DriverProfileSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
    422: { description: 'A field failed its format rule.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/driver/me/payout/reveal',
  tags: ['driver-portal'],
  summary: 'Show the payout details in full',
  description:
    "AC-04.6's explicit action, as a request rather than a client-side toggle. A field the payload already carries in full is not masked, it is obscured — so the unmasked value is only ever sent in response to the driver asking for it, and the asking is audited.",
  security: driverSecured,
  responses: {
    200: {
      description: 'The details in full, or null when none are on file.',
      content: json(PayoutDetailsSchema.nullable()),
    },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/driver/me/photo',
  tags: ['driver-portal'],
  summary: 'Send a profile photo',
  description:
    'Multipart, field name `file`. JPEG, PNG or WebP up to 5 MB — no PDF, unlike documents, because this one is rendered as an avatar. Replaces whatever was there; the previous object is left in the store rather than deleted.',
  security: driverSecured,
  request: {
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({ file: z.string().describe('binary') }),
        },
      },
    },
  },
  responses: {
    200: { description: 'The updated profile.', content: json(DriverProfileSchema) },
    401: commonErrorResponses[401],
    422: {
      description: 'Not an accepted image type, empty, or over 5 MB.',
      content: json(ErrorBodySchema),
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/driver/me/photo',
  tags: ['driver-portal'],
  summary: 'The profile photo bytes',
  description: "Serves the driver's own photo inline. 404 when they have not sent one.",
  security: driverSecured,
  responses: {
    200: { description: 'The image.', content: { 'image/*': { schema: z.string() } } },
    401: commonErrorResponses[401],
    404: { description: 'No photo on file.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/driver/me/consent',
  tags: ['driver-portal'],
  summary: 'The tracking disclosure, and where this driver stands on it',
  description:
    'The disclosure text is served rather than shipped in the client so that the wording a driver read and the version recorded against their answer cannot drift apart (AC-04.4).',
  security: driverSecured,
  responses: {
    200: {
      description: 'The disclosure and the current state.',
      content: json(
        z.object({
          disclosure: z.object({
            version: z.string(),
            title: z.string(),
            summary: z.string(),
            points: z.array(z.object({ heading: z.string(), body: z.string() })),
          }),
          current: ConsentStateSchema,
          history: z.array(ConsentStateSchema),
        }),
      ),
    },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'put',
  path: '/v1/driver/me/consent',
  tags: ['driver-portal'],
  summary: 'Give or withdraw consent to location tracking',
  description: [
    'AC-04.3: recorded as its own decision, never bundled into a terms acceptance. Every answer is a new row, so "were they consenting on the 14th?" survives them changing their mind on the 15th.',
    '',
    '**Withdrawing is not a preference, it is a stop (AC-04.5).** Any running tracking session ends, and the driver is taken off every live campaign — which costs the advertiser a vehicle, so the response says how many. Kilometres already earned are untouched: consent covered the collection at the time, and deleting earnings because someone asked to stop being followed would be a penalty dressed as a privacy control.',
  ].join('\n'),
  security: driverSecured,
  request: { body: { content: json(z.object({ granted: z.boolean() })) } },
  responses: {
    200: {
      description: 'The new state, and what withdrawing cost.',
      content: json(
        ConsentStateSchema.extend({
          trackingStopped: z.boolean().optional(),
          campaignsReleased: z.number().int().optional(),
        }),
      ),
    },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
  },
});

/**
 * The vehicle as its own driver sees it (UI-014, UI-015).
 *
 * A narrower status set than the admin's ten. `AVAILABLE`, `ASSIGNED`,
 * `INSTALLING` and `ACTIVE` all collapse into `approved`, because on this
 * screen they are one answer — the vehicle is cleared to earn. Which campaign
 * it is currently carrying is My Campaign's question, and answering it twice,
 * in two vocabularies, is how the two screens end up disagreeing.
 */
export const DriverVehicleStatusSchema = registry.register(
  'DriverVehicleStatus',
  z.enum(['pending', 'documents_verified', 'approved', 'rejected', 'suspended']),
);

export const DriverVehicleSchema = registry.register(
  'DriverVehicle',
  z.object({
    id: z.uuid(),
    registrationNumber: RegistrationSchema,
    category: z.enum(['AUTO', 'CAB']),
    status: DriverVehicleStatusSchema,
    statusReason: z
      .string()
      .nullable()
      .describe('UI-014.4 — why it was rejected or suspended, verbatim. Null when there is nothing to explain.'),
    canEarn: z
      .boolean()
      .describe('AC-05.4. What the screen badges on, so it cannot drift from the status vocabulary.'),
    bodyType: z.string().nullable(),
    makeModel: z.string().nullable(),
    colour: z.string().nullable(),
    manufactureYear: z.number().int().nullable(),
    fuelType: FuelTypeSchema.nullable(),
    photoUrl: z
      .string()
      .nullable()
      .describe(
        'A path, not an absolute URL, and null until the driver sends one. Behind the driver session, so a client attaches its token rather than handing this to a plain image loader.',
      ),
  }),
);

/**
 * What a driver may change about their own vehicle: the five descriptive
 * fields, and nothing else.
 *
 * The plate and the category are absent, and their absence is the whole design
 * (UI-016.3, UI-016.5). Those two are what the vehicle *is* — the plate is the
 * identity every document was verified against, and the category is the
 * product an advertiser chose and is billed for. Leaving them out means the
 * fields a driver can reach are exactly the ones that cannot change which
 * vehicle this is, which is why an edit here does not send an approved vehicle
 * back for re-verification.
 */
export const UpdateDriverVehicleSchema = registry.register(
  'UpdateDriverVehicleRequest',
  z
    .object({
      bodyType: z.string().trim().min(2).max(60).nullish(),
      makeModel: z.string().trim().min(2).max(80).nullish(),
      colour: z.string().trim().min(2).max(40).nullish(),
      manufactureYear: YearSchema.nullish(),
      fuelType: FuelTypeSchema.nullish(),
    })
    .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change.'),
);

registry.registerPath({
  method: 'get',
  path: '/v1/driver/me/vehicle',
  tags: ['driver-portal'],
  summary: "The signed-in driver's vehicle",
  description:
    'Null when operations has not put one on file yet, which UI-014.5 turns into a prompt rather than an empty card.',
  security: driverSecured,
  responses: {
    200: { description: 'The vehicle, or null.', content: json(DriverVehicleSchema.nullable()) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/driver/me/vehicle',
  tags: ['driver-portal'],
  summary: 'Correct your own vehicle details',
  description: [
    'The five descriptive fields, at any status. Nobody else knows the colour of the driver’s own car: AC-04 never collects it, and an admin onboarding from a phone call has the plate and the type and nothing more.',
    '',
    '**Editing does not return the vehicle to `Pending`.** UI-016.5 demotes on changes to "attributes that affect verification", and the two that do — the plate the documents were verified against, and the category an advertiser bought — are not on this endpoint at all. What is left cannot change which vehicle this is, so demoting on it would stop a driver’s earnings for correcting the spelling of their own paintwork. Every change is audited instead, and the operator reviewing the vehicle sees the current values against the RC.',
  ].join('\n'),
  security: driverSecured,
  request: { body: { content: json(UpdateDriverVehicleSchema) } },
  responses: {
    200: { description: 'The updated vehicle.', content: json(DriverVehicleSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
    404: { description: 'No vehicle on file.', content: json(ErrorBodySchema) },
    422: { description: 'A field failed its format rule.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/driver/me/vehicle/photo',
  tags: ['driver-portal'],
  summary: 'Send a photo of the vehicle',
  description:
    'Multipart, field name `file`. JPEG, PNG or WebP up to 5 MB. UI-014.2 — and the first time anything has written `vehicles.image_key`, which has existed and stayed null since migration 005. Replaces whatever was there; the previous object is left in the store.',
  security: driverSecured,
  request: {
    body: {
      content: {
        'multipart/form-data': { schema: z.object({ file: z.string().meta({ format: 'binary' }) }) },
      },
    },
  },
  responses: {
    200: { description: 'The updated vehicle.', content: json(DriverVehicleSchema) },
    401: commonErrorResponses[401],
    404: { description: 'No vehicle on file.', content: json(ErrorBodySchema) },
    422: {
      description: 'Not an accepted image type, empty, or over 5 MB.',
      content: json(ErrorBodySchema),
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/driver/me/vehicle/photo',
  tags: ['driver-portal'],
  summary: 'The vehicle photo bytes',
  description: "Serves the driver's own vehicle photo inline. 404 when they have not sent one.",
  security: driverSecured,
  responses: {
    200: { description: 'The image.', content: { 'image/*': { schema: z.string() } } },
    401: commonErrorResponses[401],
    404: { description: 'No photo on file.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/vehicles/{id}/photo',
  tags: ['drivers'],
  summary: 'The vehicle photo, for the operator reviewing it',
  description:
    'The same bytes the driver uploaded. AC-32.4 asks the operator to verify the vehicle, and a photo they cannot open is a field the driver filled in for nobody.',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'The image.', content: { 'image/*': { schema: z.string() } } },
    401: commonErrorResponses[401],
    404: { description: 'No photo on file.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/driver/documents',
  tags: ['driver-portal'],
  summary: 'What the driver has been asked for',
  description:
    "The driver's own papers and their vehicle's, as one list, each with its review status. A driver with no vehicle on file is asked only for their own — listing four they cannot supply would read as a permanent block.",
  security: driverSecured,
  responses: {
    200: { description: 'The checklist.', content: json(z.array(DriverDocumentItemSchema)) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/driver/documents',
  tags: ['driver-portal'],
  summary: 'Upload a document',
  description:
    'Multipart, field `file`: a photo (JPEG, PNG or WebP) or a PDF, up to 10 MB. A current document of the same kind is superseded rather than overwritten, so a rejected copy survives the appeal. Kinds that lapse require `expiresOn`, because AC-05.6 refuses to verify an expired document and the driver should learn that while they are still holding the paper.',
  security: driverSecured,
  request: {
    body: {
      content: {
        'multipart/form-data': {
          schema: UploadDocumentSchema.extend({
            file: z.string().meta({ format: 'binary' }),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: 'Uploaded, awaiting review.', content: json(DriverDocumentItemSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
    422: {
      description:
        'Unsupported type, empty or oversized file, a missing or already-past expiry date, a kind drivers are not asked for, or vehicle papers with no vehicle on file.',
      content: json(ErrorBodySchema),
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/driver/documents/{id}/file',
  tags: ['driver-portal'],
  summary: 'Read back a document the driver uploaded',
  description:
    "The bytes, so the app can show what was sent. Scoped to the signed-in driver and their own vehicles; anything else answers 404 rather than 403, because whether a document id exists is not this driver's business.",
  security: driverSecured,
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'The file.' },
    401: commonErrorResponses[401],
    404: { description: 'Not found, or not theirs.', content: json(ErrorBodySchema) },
  },
});

export const AvailableFleetQuerySchema = z.object({
  vehicleType: z.enum(['CAB', 'AUTO']).optional(),
});

export const AvailableFleetVehicleSchema = registry.register(
  'AvailableFleetVehicle',
  z.object({
    id: z.uuid(),
    vehicleType: z.enum(['CAB', 'AUTO']),
    publicRef: z.string().describe('A stable, opaque reference kept alongside the plate.'),
    registrationNumber: z.string().describe('The plate. Shown to every audience — see AC-22.4.'),
    areaLabel: z.string(),
    city: z.string(),
    lat: z.number(),
    lng: z.number(),
    status: VehicleStatusSchema,
    availability: z
      .enum(['available', 'booked', 'pending'])
      .describe('The same three states the campaign vehicle picker uses, derived from `status`.'),
    bookedUntil: z
      .string()
      .optional()
      .describe(
        'Present only when `availability` is `booked`: the end date of the campaign holding this vehicle.',
      ),
  }),
);

export const AvailableFleetSchema = registry.register(
  'AvailableFleet',
  z.object({
    items: z.array(AvailableFleetVehicleSchema),
    cabCount: z.number().int(),
    autoCount: z.number().int(),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/v1/vehicles/available',
  tags: ['vehicles'],
  summary: 'Browse onboarded vehicles an advertiser can place ads on',
  description:
    'Requires `advertiser.vehicle.read`. Pins come from admin onboarding. Each vehicle is named by its plate; the driver behind it is not named (ADV-039).',
  security: secured,
  request: { query: AvailableFleetQuerySchema },
  responses: {
    200: { description: 'The fleet, without driver identities.', content: json(AvailableFleetSchema) },
    401: commonErrorResponses[401],
  },
});
