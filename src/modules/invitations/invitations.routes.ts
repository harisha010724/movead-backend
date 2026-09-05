import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

import { RateLimitedError } from '../../shared/errors';
import { requireAuth, requirePermission } from '../../shared/http/middleware/auth';

import * as controller from './invitations.controller';

/**
 * A token is 256 bits, so this is not really brute-force protection — guessing
 * one is not a thing that happens. It is here because these are the only
 * unauthenticated write endpoints on the API, and an unauthenticated endpoint
 * that runs argon2 on every call is a cheap way to make the server do expensive
 * work. Thirty attempts per IP per fifteen minutes is far above any honest use.
 */
function invitationLimiter() {
  return rateLimit({
    windowMs: 15 * 60_000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: () => {
      throw new RateLimitedError('Too many attempts. Try again in a few minutes.');
    },
  });
}

/**
 * Accepting an invitation, mounted at `/v1/invitations`.
 *
 * Deliberately outside `/admin` and deliberately unauthenticated: the caller
 * has no password yet. The token in the path is what authorises them, and the
 * only thing it authorises is setting that password.
 */
export function invitationRoutes(): Router {
  const router = Router();
  const limiter = invitationLimiter();

  router.get('/:token', limiter, controller.show);
  router.post('/:token/accept', limiter, controller.accept);

  return router;
}

/** Resending, mounted at `/v1/admin`. Staff-only, unlike the two above. */
export function adminInvitationRoutes(): Router {
  const router = Router();

  router.post(
    '/users/:id/resend-invitation',
    requireAuth('admin'),
    requirePermission('user.create'),
    controller.resend,
  );

  return router;
}
