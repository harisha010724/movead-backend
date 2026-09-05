import { commonErrorResponses, ErrorBodySchema, IdParamSchema } from './common';
import { registry, z } from './registry';

/**
 * Accepting an invitation — the one part of onboarding the customer does.
 *
 * These two endpoints are **unauthenticated**, and have to be: the person
 * calling them has no password yet, which is the entire reason they are here.
 * What stands in for a session is the token in the path — 256 bits of
 * randomness, single-use, expiring, and authorising exactly one action.
 */

export const InvitationTokenParamSchema = z.object({
  token: z.string().min(20).max(200),
});

export const InvitationSchema = registry.register(
  'Invitation',
  z.object({
    email: z.string().describe('The address that will sign in. Not editable here.'),
    fullName: z.string(),
    organisation: z
      .string()
      .nullable()
      .describe('The advertiser brand, MoveAd Driver, or null for staff.'),
    expiresAt: z.string(),
    audience: z.enum(['admin', 'advertiser', 'driver']),
  }),
);

export const AcceptInvitationRequestSchema = registry.register(
  'AcceptInvitationRequest',
  z.object({
    password: z
      .string()
      .min(12, 'Use at least 12 characters')
      .max(200)
      .describe('Chosen by the customer. MoveAd never sees or sends a password.'),
  }),
);

export const AcceptedInvitationSchema = registry.register(
  'AcceptedInvitation',
  z.object({
    email: z.string(),
    audience: z
      .enum(['admin', 'advertiser', 'driver'])
      .describe('Which portal to sign in to now the password is set.'),
  }),
);

export const ResendInvitationSchema = registry.register(
  'ResendInvitation',
  z.object({
    email: z.string(),
    delivered: z.boolean(),
    expiresAt: z.string(),
  }),
);

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

/**
 * The three ways an invitation can be unusable each get their own code, because
 * they need different sentences in front of a customer: ask for another, you
 * already did this, or check for a newer email.
 */
const invitationRefusals = {
  404: {
    description: 'No such invitation. The link is wrong or was never issued.',
    content: json(ErrorBodySchema),
  },
  422: {
    description:
      'The invitation exists but cannot be used: `invitation_expired`, `invitation_used` or `invitation_superseded`.',
    content: json(ErrorBodySchema),
  },
} as const;

registry.registerPath({
  method: 'get',
  path: '/v1/invitations/{token}',
  tags: ['invitations'],
  summary: 'Read an invitation',
  description:
    'Public. Returns just enough for the set-password page to greet the person and show which address they are securing. Rate limited.',
  request: { params: InvitationTokenParamSchema },
  responses: {
    200: { description: 'The invitation is live.', content: json(InvitationSchema) },
    ...invitationRefusals,
    429: { description: 'Too many attempts.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/invitations/{token}/accept',
  tags: ['invitations'],
  summary: 'Set the password an invitation was issued for',
  description:
    'Public. Sets the password, moves the account to ACTIVE and consumes the invitation. ' +
    'No session is issued — the portal signs in with the new password immediately afterwards, reusing the ordinary login path rather than minting a session from an unauthenticated endpoint.',
  request: {
    params: InvitationTokenParamSchema,
    body: { content: json(AcceptInvitationRequestSchema) },
  },
  responses: {
    200: { description: 'Password set.', content: json(AcceptedInvitationSchema) },
    ...invitationRefusals,
    400: commonErrorResponses[400],
    429: { description: 'Too many attempts.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/users/{id}/resend-invitation',
  tags: ['admin-advertisers'],
  summary: 'Send a fresh invitation',
  description:
    'Requires `user.create`. Issues a new link and emails it. Any invitation still outstanding is superseded, so the previous link stops working — which is the point when the first one may have gone astray.',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'A new invitation was issued.', content: json(ResendInvitationSchema) },
    403: { description: 'Missing permission.', content: json(ErrorBodySchema) },
    404: { description: 'No user with that id.', content: json(ErrorBodySchema) },
    422: {
      description: 'The account is suspended and cannot be invited.',
      content: json(ErrorBodySchema),
    },
    401: commonErrorResponses[401],
  },
});
