import { commonErrorResponses, ErrorBodySchema, IdParamSchema } from './common';
import { registry, z } from './registry';

/**
 * Advertiser onboarding, admin side (AC-32.2).
 *
 * There is no self-registration endpoint here and there is not meant to be
 * one: an advertiser account exists because an operator created it.
 *
 * Note what these schemas do *not* contain: a password. An operator creates the
 * account and the platform emails a single-use link; the customer chooses their
 * own password. See migration 009 for the reasoning.
 */

const EmailSchema = z.email().max(254).toLowerCase();

export const AdvertiserUserSchema = registry.register(
  'AdvertiserUser',
  z.object({
    id: z.uuid(),
    email: z.string(),
    fullName: z.string(),
    status: z.string().describe('INVITED until they accept, then ACTIVE'),
    invitationExpiresAt: z
      .string()
      .nullable()
      .describe('When the outstanding invitation lapses. Null once accepted.'),
  }),
);

export const AdvertiserSchema = registry.register(
  'Advertiser',
  z.object({
    id: z.uuid(),
    legalName: z.string(),
    brandName: z.string(),
    gstin: z.string().nullable(),
    pan: z.string().nullable(),
    billingEmail: z.string(),
    status: z.enum(['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'CLOSED']),
    createdAt: z.string(),
    primaryUser: AdvertiserUserSchema.nullable(),
  }),
);

export const AdvertiserContactSchema = registry.register(
  'AdvertiserContact',
  z.object({
    email: EmailSchema,
    fullName: z.string().min(2).max(120),
  }),
);

export const CreateAdvertiserRequestSchema = registry.register(
  'CreateAdvertiserRequest',
  z.object({
    legalName: z.string().min(2).max(200),
    brandName: z.string().min(1).max(120),
    // Format-checked here and again by a CHECK constraint in the database. The
    // constraint is the one that counts; this one produces a better message.
    gstin: z
      .string()
      .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/, 'That is not a valid GSTIN')
      .nullish(),
    pan: z
      .string()
      .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'That is not a valid PAN')
      .nullish(),
    billingEmail: EmailSchema,
    user: AdvertiserContactSchema.nullish().describe(
      'The first portal login. Created in the same transaction and sent an invitation.',
    ),
  }),
);

export const UpdateAdvertiserRequestSchema = registry.register(
  'UpdateAdvertiserRequest',
  z
    .object({
      legalName: z.string().min(2).max(200).optional(),
      brandName: z.string().min(1).max(120).optional(),
      // Nullable as well as optional, and the two mean different things: absent
      // leaves the value alone, null clears it. An advertiser registered before
      // they had a GSTIN has to be able to stop having one on record.
      gstin: z
        .string()
        .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/, 'That is not a valid GSTIN')
        .nullish(),
      pan: z
        .string()
        .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'That is not a valid PAN')
        .nullish(),
      billingEmail: EmailSchema.optional(),
    })
    .describe(
      'Every field is optional; only what is sent is changed. The account status is not here — activating or suspending an advertiser is a separate decision under `advertiser.activate`.',
    ),
);

export const OnboardedAdvertiserSchema = registry.register(
  'OnboardedAdvertiser',
  z.object({
    advertiser: AdvertiserSchema,
    user: AdvertiserUserSchema.nullable(),
    invitationEmailed: z
      .boolean()
      .describe(
        'False when the account was created but the email could not be sent. The invitation is still valid — resend it.',
      ),
  }),
);

export const InvitedUserSchema = registry.register(
  'InvitedUser',
  z.object({
    user: AdvertiserUserSchema,
    invitationEmailed: z.boolean(),
  }),
);

export type CreateAdvertiserRequest = z.infer<typeof CreateAdvertiserRequestSchema>;
export type AdvertiserContact = z.infer<typeof AdvertiserContactSchema>;

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

registry.registerPath({
  method: 'post',
  path: '/v1/admin/advertisers',
  tags: ['admin-advertisers'],
  summary: 'Onboard an advertiser',
  description:
    'Requires `advertiser.create`. Creates the account and, when `user` is supplied, its first portal login — both in one transaction. ' +
    'The login is created in INVITED with no usable password, and an invitation email is sent. ' +
    'The account starts in ONBOARDING; it becomes ACTIVE when its wallet is funded.',
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(CreateAdvertiserRequestSchema) } },
  responses: {
    201: { description: 'Created.', content: json(OnboardedAdvertiserSchema) },
    403: { description: 'Missing permission.', content: json(ErrorBodySchema) },
    409: {
      description: 'That email address is already registered. Nothing was created.',
      content: json(ErrorBodySchema),
    },
    401: commonErrorResponses[401],
    400: commonErrorResponses[400],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/advertisers',
  tags: ['admin-advertisers'],
  summary: 'List advertiser accounts',
  description: 'Requires `advertiser.read`. Each row carries its first login and invitation state.',
  security: [{ cookieAuth: [] }],
  responses: {
    200: { description: 'Advertisers.', content: json(z.array(AdvertiserSchema)) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/admin/advertisers/{id}',
  tags: ['admin-advertisers'],
  summary: "Correct an advertiser's details",
  description:
    'Requires `advertiser.create`. Corrects the organisation on record — its names, tax identifiers and billing address. ' +
    'It does not touch the people: a contact\'s name or sign-in address belongs to their user account, not to the company.',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema, body: { content: json(UpdateAdvertiserRequestSchema) } },
  responses: {
    200: { description: 'Updated.', content: json(AdvertiserSchema) },
    403: { description: 'Missing permission.', content: json(ErrorBodySchema) },
    404: { description: 'No advertiser with that id.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
    400: commonErrorResponses[400],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/advertisers/{id}/users',
  tags: ['admin-advertisers'],
  summary: 'Add a portal login to an advertiser',
  description:
    'Requires `user.create`. The user is scoped to this advertiser, which is what makes their session an advertiser session rather than a staff one. ' +
    'No password is accepted: the account is created in INVITED and emailed a single-use link.',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema, body: { content: json(AdvertiserContactSchema) } },
  responses: {
    201: { description: 'Created and invited.', content: json(InvitedUserSchema) },
    403: { description: 'Missing permission.', content: json(ErrorBodySchema) },
    404: { description: 'No advertiser with that id.', content: json(ErrorBodySchema) },
    409: { description: 'That email is already registered.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
    400: commonErrorResponses[400],
  },
});
