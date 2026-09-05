import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import { config } from '../../shared/config';
import {
  requireAnyAuth,
  requireAuth,
  requirePermission,
} from '../../shared/http/middleware/auth';
import { RateLimitedError } from '../../shared/errors';
import { loggerFor } from '../../shared/logger';

import * as controller from './identity.controller';

/**
 * Ten attempts per IP per fifteen minutes, on top of the per-account lockout.
 * The account lockout stops an attacker working one address; this stops them
 * working a list of them.
 *
 * Off outside production — local onboarding burns through the window in a
 * few failed password tries, and that is not a threat model we have locally.
 */
function loginLimiter(): RequestHandler {
  if (!config.isProduction) {
    return (_req, _res, next) => {
      next();
    };
  }

  return rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: () => {
      throw new RateLimitedError('Too many sign-in attempts. Try again in a few minutes.');
    },
  });
}

/**
 * Sign-in, mounted at `/v1/auth` and shared by both portals.
 *
 * These endpoints are audience-agnostic on purpose. One login page serves both
 * portals and cannot know which one you belong to until your password has been
 * checked, so the audience is something the response reports rather than
 * something the caller asserts — a caller-supplied portal would just be an
 * invitation to claim the wrong one.
 *
 * WEB-001 is unaffected. The audience is still derived from the account, the
 * session is still stamped with it, and `requireAuth('admin')` still rejects an
 * advertiser session before any permission is read.
 */
export function authRoutes(): Router {
  const router = Router();
  const limiter = loginLimiter();

  if (!config.totp.adminRequired) {
    loggerFor('identity').warn(
      'ADMIN_MFA_REQUIRED=false — admin sign-in is password-only. Never deploy this.',
    );
  }

  router.post('/login', limiter, controller.login);
  router.post('/mfa/enrol', limiter, controller.enrolMfa);
  router.post('/mfa/verify', limiter, controller.verifyMfa);

  // Whoever is signed in, in either portal.
  router.get('/me', requireAnyAuth(), controller.me);
  router.post('/logout', requireAnyAuth(), controller.logout);

  return router;
}

/**
 * The driver app's sign-in, mounted at `/v1/driver/auth`.
 *
 * Separate from `/v1/auth` because it is the one place that issues bearer
 * tokens. The portals' cookie is deliberately unreachable from JavaScript, and
 * a shared endpoint that returned a token to anyone who asked would undo that
 * for the two audiences it protects.
 *
 * `refresh` carries the credential in its body rather than a header, so a
 * proxy access log that records Authorization values does not accumulate the
 * long-lived half of every driver's session.
 */
export function driverAppAuthRoutes(): Router {
  const router = Router();
  const limiter = loginLimiter();

  router.post('/login', limiter, controller.driverAppLogin);
  router.post('/refresh', limiter, controller.driverAppRefresh);
  router.post('/logout', requireAuth('driver'), controller.driverAppLogout);

  return router;
}

/**
 * Admin-only identity administration, mounted at `/v1/admin`.
 *
 * Everything here is guarded by a permission rather than a role (AC-31,
 * ADM-028), so splitting Super Admin into narrower roles later is a data change
 * instead of an edit to every route in the platform.
 */
export function adminIdentityRoutes(): Router {
  const router = Router();

  if (config.admin.bootstrapToken) {
    // Not mounted at all without a token configured, so a production deploy
    // that forgets to unset it still has one guard, and one that never set it
    // has no such endpoint to find.
    router.post('/bootstrap', loginLimiter(), controller.bootstrap);
  } else {
    loggerFor('identity').info('ADMIN_BOOTSTRAP_TOKEN unset — /v1/admin/bootstrap not mounted');
  }

  router.post(
    '/users',
    requireAuth('admin'),
    requirePermission('user.create'),
    controller.createUser,
  );

  // Correcting an account is the same authority as creating one — and the
  // commonest correction is an address that was typed wrong, which is why the
  // account cannot be reached in the first place.
  router.patch(
    '/users/:id',
    requireAuth('admin'),
    requirePermission('user.create'),
    controller.updateUser,
  );

  return router;
}
