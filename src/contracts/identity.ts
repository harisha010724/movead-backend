import { commonErrorResponses, ErrorBodySchema, IdParamSchema } from './common';
import { registry, z } from './registry';

/**
 * Admin authentication contracts.
 *
 * Passwords are twelve characters minimum with no composition rules. Length
 * beats character classes — the acceptance criteria set no policy, so this is
 * a decision rather than a requirement, and it is recorded as one.
 */
const PasswordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200)
  .openapi({ description: 'Minimum twelve characters.' });

const EmailSchema = z.email().max(254).toLowerCase();

export const AudienceSchema = z
  .enum(['admin', 'advertiser', 'driver'])
  .openapi({ description: 'Which portal this account belongs to. Derived from the account.' });

export const AdminUserSchema = registry.register(
  'AdminUser',
  z.object({
    id: z.uuid(),
    email: z.string(),
    fullName: z.string(),
    status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED']),
    audience: AudienceSchema,
    advertiserId: z.uuid().nullable(),
    driverId: z.uuid().nullable(),
    organisationName: z
      .string()
      .openapi({
        description: "The advertiser's brand name, the driver's name, or the platform for staff.",
      }),
    mfaEnabled: z.boolean(),
    roles: z.array(z.string()),
    permissions: z.array(z.string()),
    lastLoginAt: z.string().nullable(),
  }),
);

export const BootstrapRequestSchema = registry.register(
  'BootstrapRequest',
  z.object({
    token: z.string().min(16).openapi({ description: 'Must equal ADMIN_BOOTSTRAP_TOKEN.' }),
    email: EmailSchema,
    fullName: z.string().min(2).max(120),
    password: PasswordSchema,
  }),
);

export const LoginRequestSchema = registry.register(
  'LoginRequest',
  z.object({ email: EmailSchema, password: z.string().min(1).max(200) }),
);

/**
 * Three outcomes, because the two portals have different MFA rules
 * (architecture Part 12.1). Admin TOTP is mandatory, so an admin password only
 * ever buys a short-lived challenge token. An advertiser without an
 * authenticator is signed in here, cookie and all.
 *
 * `audience` is present on every outcome so the shared login page knows which
 * portal to send the browser to.
 */
/**
 * The session token, returned alongside the cookie rather than instead of it.
 *
 * A portal served from a different site than the API never receives the
 * cookie: `SameSite=Strict` withholds it, and `None` turns it into a
 * third-party cookie, which Chrome blocks in Incognito and is retiring
 * generally. Such a portal sends this value as `Authorization: Bearer` and is
 * authenticated by the same row in `user_sessions` the cookie would have
 * named — same expiry, same revocation, no additional reach.
 *
 * Same-origin deployments should ignore it and let the cookie work, which
 * keeps the session out of JavaScript's reach. Whatever holds this value can
 * be read by an XSS, which is the protection `httpOnly` exists to give.
 */
const SessionTokenSchema = z.string().openapi({
  description:
    'Send as `Authorization: Bearer <token>` where the session cookie cannot reach the API. Prefer the cookie when the portal and the API share an origin.',
});

export const LoginResponseSchema = registry.register(
  'LoginResponse',
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('authenticated'),
      audience: AudienceSchema,
      user: AdminUserSchema,
      sessionToken: SessionTokenSchema,
    }),
    z.object({
      status: z.enum(['mfa_required', 'mfa_enrolment_required']),
      audience: AudienceSchema,
      challengeToken: z.string().openapi({ description: 'Valid for five minutes.' }),
    }),
  ]),
);

/** What the code step returns, and the `authenticated` branch of login. */
export const SessionResponseSchema = registry.register(
  'SessionResponse',
  z.object({
    status: z.literal('authenticated'),
    audience: AudienceSchema,
    user: AdminUserSchema,
    sessionToken: SessionTokenSchema,
  }),
);

// ------------------------------------------------- driver mobile identity

export const MobileTokensSchema = registry.register(
  'DriverAppTokens',
  z.object({
    accessToken: z.string().openapi({
      description: 'JWT, fifteen minutes. Hold it in memory and never write it to disk.',
    }),
    refreshToken: z.string().openapi({
      description:
        'Opaque. Belongs in the Keystore or Keychain, and is replaced on every refresh — the value you sent stops working the moment you receive its successor.',
    }),
    expiresIn: z.int().positive().openapi({ description: 'Seconds until the access token dies.' }),
  }),
);

export const DriverAppSessionSchema = registry.register(
  'DriverAppSession',
  z.object({ tokens: MobileTokensSchema, user: AdminUserSchema }),
);

export const RefreshRequestSchema = registry.register(
  'DriverAppRefreshRequest',
  z.object({ refreshToken: z.string().min(1) }),
);

export const EnrolRequestSchema = registry.register(
  'MfaEnrolRequest',
  z.object({ challengeToken: z.string() }),
);

export const EnrolResponseSchema = registry.register(
  'MfaEnrolResponse',
  z.object({
    secret: z.string().openapi({ description: 'Base32. Shown once and never again.' }),
    otpauthUri: z.string().openapi({ description: 'Render as a QR code for the authenticator.' }),
  }),
);

export const VerifyRequestSchema = registry.register(
  'MfaVerifyRequest',
  z.object({
    challengeToken: z.string(),
    code: z.string().regex(/^\d{6}$/, 'Six digits'),
  }),
);

export const CreateUserRequestSchema = registry.register(
  'CreateUserRequest',
  z.object({
    email: EmailSchema,
    fullName: z.string().min(2).max(120),
    password: PasswordSchema,
    roleKey: z.string().default('SUPER_ADMIN'),
  }),
);

export const UpdateUserRequestSchema = registry.register(
  'UpdateUserRequest',
  z.object({
    fullName: z.string().min(2).max(120).optional(),
    email: EmailSchema.optional().describe(
      'What they sign in with. Changing it is a security event — see the endpoint description.',
    ),
  }),
);

export const UpdatedUserSchema = registry.register(
  'UpdatedUser',
  z.object({
    id: z.uuid(),
    email: z.string(),
    fullName: z.string(),
    status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED']),
    invitationExpiresAt: z.string().nullable(),
    emailChange: z
      .object({
        previousEmail: z.string(),
        invitationResent: z
          .boolean()
          .describe('True when the account had not been used, so a fresh invitation was sent.'),
        delivered: z
          .boolean()
          .describe(
            'Whether the resulting message — the new invitation, or the warning to the old address — was sent.',
          ),
      })
      .nullable()
      .describe('Null when the address was not touched.'),
  }),
);

export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type EnrolRequest = z.infer<typeof EnrolRequestSchema>;
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

registry.registerPath({
  method: 'post',
  path: '/v1/admin/bootstrap',
  tags: ['admin-auth'],
  summary: 'Create the first Super Admin',
  description:
    'Available only while the platform has no users, and only with the bootstrap token. There is no self-signup and no seeded default account.',
  request: { body: { content: json(BootstrapRequestSchema) } },
  responses: {
    201: {
      description: 'Created. Sign in to enrol an authenticator.',
      content: json(AdminUserSchema),
    },
    403: { description: 'Bootstrap token missing or wrong.', content: json(ErrorBodySchema) },
    409: { description: 'A user already exists.', content: json(ErrorBodySchema) },
    400: commonErrorResponses[400],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/auth/login',
  tags: ['auth'],
  summary: 'Password step, both portals',
  description:
    'Shared by the admin and advertiser portals. The audience is derived from the account and reported in the response — it is never something the caller supplies. Admin TOTP is mandatory, so an admin only ever receives a five-minute challenge token; an advertiser without an authenticator receives a session.',
  request: { body: { content: json(LoginRequestSchema) } },
  responses: {
    200: {
      description: 'Password accepted. Either a session, or a second factor is required.',
      content: json(LoginResponseSchema),
    },
    401: { description: 'Email or password is wrong.', content: json(ErrorBodySchema) },
    403: { description: 'The account is not active.', content: json(ErrorBodySchema) },
    423: { description: 'Locked after repeated failures.', content: json(ErrorBodySchema) },
    400: commonErrorResponses[400],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/auth/mfa/enrol',
  tags: ['auth'],
  summary: 'Generate an authenticator secret',
  description:
    'First sign-in only. The secret is stored encrypted but stays inactive until a code proves the authenticator holds it.',
  request: { body: { content: json(EnrolRequestSchema) } },
  responses: {
    200: { description: 'Secret and provisioning URI.', content: json(EnrolResponseSchema) },
    401: { description: 'The challenge expired.', content: json(ErrorBodySchema) },
    409: { description: 'An authenticator is already configured.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/auth/mfa/verify',
  tags: ['auth'],
  summary: 'Code step — issues the session cookie',
  description:
    'On success sets an httpOnly, SameSite=Strict session cookie named for the audience. The session is server-side and revocable; nothing about it is carried in the token itself.',
  request: { body: { content: json(VerifyRequestSchema) } },
  responses: {
    200: { description: 'Signed in.', content: json(SessionResponseSchema) },
    401: { description: 'Wrong code, or the challenge expired.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/auth/me',
  tags: ['auth'],
  summary: 'The signed-in user, with resolved permissions',
  description:
    'Accepts either portal session. `audience` tells the shared login page which portal to land on.',
  security: [{ cookieAuth: [] }],
  responses: {
    200: { description: 'The current user.', content: json(AdminUserSchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/auth/logout',
  tags: ['auth'],
  summary: 'Revoke the current session',
  security: [{ cookieAuth: [] }],
  responses: { 204: { description: 'Signed out.' }, 401: commonErrorResponses[401] },
});

registry.registerPath({
  method: 'post',
  path: '/v1/driver/auth/login',
  tags: ['driver-app'],
  summary: 'Driver app sign-in with the emailed username and password',
  description:
    'The app cannot hold the portal cookie, so this returns a bearer pair instead: a fifteen-minute access token for memory and a rotating refresh token for the Keystore.\n\n' +
    'Driver accounts only. An advertiser or admin presenting correct credentials is refused with 403 rather than issued a token every driver route would then reject.',
  request: { body: { content: json(LoginRequestSchema) } },
  responses: {
    200: { description: 'Signed in.', content: json(DriverAppSessionSchema) },
    401: { description: 'Email or password is wrong.', content: json(ErrorBodySchema) },
    403: {
      description: 'Not a driver account, or the account is not active.',
      content: json(ErrorBodySchema),
    },
    423: { description: 'Locked after repeated failures.', content: json(ErrorBodySchema) },
    400: commonErrorResponses[400],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/driver/auth/refresh',
  tags: ['driver-app'],
  summary: 'Exchange a refresh token for a new pair',
  description:
    'Rotates. The token you send is dead on return, so store the new one before the next request — replaying the old one reads as an expired session and returns 401.',
  request: { body: { content: json(RefreshRequestSchema) } },
  responses: {
    200: { description: 'A new pair.', content: json(MobileTokensSchema) },
    401: {
      description: 'Unknown, rotated, expired or revoked. Sign in again.',
      content: json(ErrorBodySchema),
    },
    400: commonErrorResponses[400],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/driver/auth/logout',
  tags: ['driver-app'],
  summary: 'Revoke this device’s session',
  description: 'Ends the session behind the access token, which kills its refresh token with it.',
  security: [{ bearerAuth: [] }],
  responses: { 204: { description: 'Signed out.' }, 401: commonErrorResponses[401] },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/users',
  tags: ['admin-users'],
  summary: 'Create another staff user',
  description: 'Requires the `user.create` permission.',
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(CreateUserRequestSchema) } },
  responses: {
    201: { description: 'Created.', content: json(AdminUserSchema) },
    403: { description: 'Missing permission.', content: json(ErrorBodySchema) },
    409: { description: 'That email is already registered.', content: json(ErrorBodySchema) },
    401: commonErrorResponses[401],
    400: commonErrorResponses[400],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/admin/users/{id}',
  tags: ['admin-users'],
  summary: "Correct a person's name, or the address they sign in with",
  description:
    'Requires `user.create`. Used to fix what was typed when the account was opened — most often a mistyped email that means the invitation went nowhere.\n\n' +
    'Changing the address is treated as a security event, and what happens depends on whether the account has been used. ' +
    '**Still INVITED:** the outstanding invitation is voided and a new one is sent to the corrected address, so the wrong mailbox is left holding a dead link. ' +
    '**Already ACTIVE:** the password is untouched and still works, every session is ended, and the *previous* address is emailed a warning — the mailbox losing access is the only party who might not know. ' +
    'A suspended or disabled account is refused.',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema, body: { content: json(UpdateUserRequestSchema) } },
  responses: {
    200: { description: 'Updated.', content: json(UpdatedUserSchema) },
    403: { description: 'Missing permission.', content: json(ErrorBodySchema) },
    404: { description: 'No user with that id.', content: json(ErrorBodySchema) },
    409: { description: 'That email is already registered.', content: json(ErrorBodySchema) },
    422: {
      description: 'The account is suspended, so its sign-in address is frozen.',
      content: json(ErrorBodySchema),
    },
    401: commonErrorResponses[401],
    400: commonErrorResponses[400],
  },
});
