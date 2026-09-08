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

    // A cookie names its audience, so it needs no guessing.
    for (const audience of audiences) {
      if (cookieFor(req, audience)) {
        await establishAny(req, audience);
        next();
        return;
      }
    }

    /*
     * A bearer token does not name one. `Authorization` has a single value
     * whichever portal sent it, so the audience has to be found by trying each
     * in turn — a lookup that fails is indistinguishable from a token issued
     * for a different audience, and both simply move to the next.
     *
     * At most three lookups, only on the routes that accept any audience, and
     * only for header-authenticated callers.
     */
    if (bearerFrom(req)) {
      for (const audience of audiences) {
        try {
          await establishAny(req, audience);
          next();
          return;
        } catch {
          continue;
        }
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
 * A token presented in the `Authorization` header.
 *
 * For the driver app this is a JWT. For a portal it is the session token the
 * cookie would otherwise have carried, sent by hand because the cookie could
 * not arrive: the portal and the API are served from different sites, and a
 * browser will not send a `SameSite=Strict` cookie across them. Relaxing it to
 * `None` does not rescue the case either, since that makes it a third-party
 * cookie, which Chrome blocks in Incognito today and is removing generally.
 *
 * The cost is real and worth stating plainly: a token JavaScript can attach is
 * a token an XSS can read, which is precisely what `httpOnly` existed to
 * prevent. The cookie is still set and still preferred, so a same-origin
 * deployment — a linked backend, or one domain for both — keeps that
 * protection without changing a line here.
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
 *
 * The two bearer forms are not interchangeable and are not treated as such.
 * The driver app carries a signed JWT, verified by `authenticateBearer`; a
 * portal carries the same opaque session token its cookie would have held, so
 * it goes to `authenticate`, the identical lookup against `user_sessions`. A
 * portal token is therefore no more powerful in a header than in a cookie —
 * same row, same expiry, same revocation.
 */
async function establishAny(req: Request, audience: SessionAudience): Promise<void> {
  const cookie = cookieFor(req, audience);
  const bearer = bearerFrom(req);

  if (!cookie && !bearer) throw new UnauthenticatedError();

  const { session, user } = await resolve({ cookie, bearer, audience });

  state.set(req, { sessionId: session.id, user });
  setActor({ id: user.id, kind: 'user', audience: `movead-${audience}` });
}

async function resolve(input: {
  cookie: string | undefined;
  bearer: string | null;
  audience: SessionAudience;
}) {
  if (input.cookie) return authenticate(input.cookie, input.audience);

  const token = input.bearer as string;

  if (input.audience !== 'driver') return authenticate(token, input.audience);

  /*
   * Driver has two clients and therefore two bearer formats:
   *
   * - the web portal sends the opaque session token returned by `/auth/login`;
   * - the mobile app sends the JWT returned by `/driver-app/auth/login`.
   *
   * Try the session first because the web portal is the same session model as
   * admin and advertiser. Fall back to the JWT only when it is not a valid
   * driver session. Both paths still verify audience, expiry and revocation.
   */
  try {
    return await authenticate(token, input.audience);
  } catch {
    return authenticateBearer(token, input.audience);
  }
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
