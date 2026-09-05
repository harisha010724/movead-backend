import { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import {
  type AuthenticatedUser,
  authenticate,
  authenticateBearer,
} from '../../../modules/identity/identity.service';
import { type SessionAudience } from '../../../modules/identity/identity.model';
import { setActor } from '../../context';
import { ForbiddenError, UnauthenticatedError } from '../../errors';

/**
 * Session cookies for the web portals.
 *
 * Names are prefixed per portal so an admin and an advertiser session can
 * coexist in one browser without overwriting each other, and so a cookie sent
 * to the wrong portal is simply absent rather than subtly wrong.
 */
export const SESSION_COOKIE = {
  admin: 'movead_admin_session',
  advertiser: 'movead_advertiser_session',
  driver: 'movead_driver_session',
} as const satisfies Record<SessionAudience, string>;

export interface AuthState {
  sessionId: string;
  user: AuthenticatedUser;
}

const state = new WeakMap<Request, AuthState>();

/** Reads what `requireAuth` established. Throws if the route is unguarded. */
export function currentUser(req: Request): AuthState {
  const found = state.get(req);
  if (!found) throw new Error('currentUser() used on a route without requireAuth()');
  return found;
}

export function requireAuth(audience: SessionAudience): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    await establishAny(req, audience);
    next();
  };
}

/**
 * For the handful of endpoints that belong to whoever is signed in rather than
 * to a portal — `/v1/auth/me` and sign-out.
 *
 * It resolves a specific audience from whichever cookie is present rather than
 * relaxing the check, so `authenticate` still rejects a session presented under
 * the wrong name. WEB-001 holds: this widens which door you may knock on, not
 * what is behind it.
 */
export function requireAnyAuth(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const audiences: SessionAudience[] = ['admin', 'advertiser', 'driver'];

    for (const audience of audiences) {
      if (cookieFor(req, audience) || (audience === 'driver' && bearerFrom(req))) {
        await establishAny(req, audience);
        next();
        return;
      }
    }

    throw new UnauthenticatedError();
  };
}

function cookieFor(req: Request, audience: SessionAudience): string | undefined {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[SESSION_COOKIE[audience]];
}

/**
 * The driver app's access token. Only the driver audience has one: the portals
 * deliberately keep their session out of JavaScript's reach, and accepting a
 * header there would hand an XSS the very thing `httpOnly` denies it.
 */
function bearerFrom(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) return null;

  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;

  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolves whichever credential the caller presented for this audience.
 *
 * The cookie is tried first so a browser that also happens to send a stale
 * Authorization header still behaves like a browser.
 */
async function establishAny(req: Request, audience: SessionAudience): Promise<void> {
  const cookie = cookieFor(req, audience);
  const bearer = audience === 'driver' ? bearerFrom(req) : null;

  if (!cookie && !bearer) throw new UnauthenticatedError();

  const { session, user } = cookie
    ? await authenticate(cookie, audience)
    : await authenticateBearer(bearer as string, audience);

  state.set(req, { sessionId: session.id, user });
  setActor({ id: user.id, kind: 'user', audience: `movead-${audience}` });
}

/**
 * AC-31 gives admin a single Super Admin role and ADM-028 requires that to be
 * reversible, so authorisation is written against permissions from the start
 * even while every one of them resolves to granted. `requireRole('SUPER_ADMIN')`
 * would mean revisiting every route the day sub-roles arrive.
 */
export function requirePermission(permission: string): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const { user } = currentUser(req);

    if (!user.permissions.includes(permission)) {
      throw new ForbiddenError('You do not have permission to do that.');
    }

    next();
  };
}
