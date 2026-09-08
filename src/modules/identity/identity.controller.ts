import { type CookieOptions, type Request, type Response } from 'express';

import { IdParamSchema } from '../../contracts/common';
import {
  BootstrapRequestSchema,
  CreateUserRequestSchema,
  EnrolRequestSchema,
  LoginRequestSchema,
  RefreshRequestSchema,
  UpdateUserRequestSchema,
  VerifyRequestSchema,
} from '../../contracts/identity';
import { config } from '../../shared/config';
import { currentUser, SESSION_COOKIE } from '../../shared/http/middleware/auth';
import { parseBody, parseParams } from '../../shared/http/validate';

import * as identity from './identity.service';
import { crossSite, sessionCookie } from './session-cookie';

export async function bootstrap(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, BootstrapRequestSchema);
  const user = await identity.bootstrapFirstAdmin({ ...body, ip: clientIp(req) });

  res.status(201).json(user);
}

export async function login(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, LoginRequestSchema);
  const outcome = await identity.login({
    ...body,
    ip: clientIp(req),
    userAgent: req.get('user-agent') ?? null,
  });

  // An advertiser without an authenticator is signed in by the password step
  // alone, so this branch has a cookie to set. Admin never reaches it.
  if (outcome.status === 'authenticated') {
    setSession(req, res, outcome.issued);
    res.json({
      status: outcome.status,
      audience: outcome.audience,
      user: outcome.issued.user,
      sessionToken: outcome.issued.token,
    });
    return;
  }

  res.json({
    status: outcome.status,
    audience: outcome.audience,
    challengeToken: outcome.challengeToken,
  });
}

/**
 * The same password step as the portal's, answered with tokens instead of a
 * cookie. Kept as its own endpoint rather than a flag on `/v1/auth/login`
 * because what a caller receives should follow from which door they used, not
 * from a parameter they can set.
 */
export async function driverAppLogin(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, LoginRequestSchema);

  res.json(
    await identity.driverMobileLogin({
      ...body,
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? null,
    }),
  );
}

export async function driverAppRefresh(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, RefreshRequestSchema);

  res.json(await identity.refreshDriverMobileSession(body.refreshToken, { ip: clientIp(req) }));
}

export async function driverAppLogout(req: Request, res: Response): Promise<void> {
  const { sessionId, user } = currentUser(req);

  await identity.logout(sessionId, user.id, clientIp(req));

  res.status(204).send();
}

export async function enrolMfa(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, EnrolRequestSchema);
  const enrolment = await identity.beginTotpEnrolment(body.challengeToken);

  res.json(enrolment);
}

export async function verifyMfa(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, VerifyRequestSchema);
  const issued = await identity.verifyMfaAndCreateSession({
    challengeToken: body.challengeToken,
    code: body.code,
    ip: clientIp(req),
    userAgent: req.get('user-agent') ?? null,
  });

  setSession(req, res, issued);
  res.json({
    status: 'authenticated',
    audience: issued.session.audience,
    user: issued.user,
    sessionToken: issued.token,
  });
}

export function me(req: Request, res: Response): void {
  res.json(currentUser(req).user);
}

export async function logout(req: Request, res: Response): Promise<void> {
  const { sessionId, user } = currentUser(req);

  await identity.logout(sessionId, user.id, clientIp(req));

  // Same attributes it was set with. A clear that differs on `sameSite` or
  // `secure` does not match the stored cookie, and the browser keeps it.
  res.clearCookie(SESSION_COOKIE[user.audience], cookieFor(req, new Date(0)));
  res.status(204).send();
}

export async function createUser(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, CreateUserRequestSchema);
  const created = await identity.createStaffUser({
    ...body,
    createdBy: currentUser(req).user.id,
    ip: clientIp(req),
  });

  res.status(201).json(created);
}

export async function updateUser(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const changes = parseBody(req, UpdateUserRequestSchema);
  const actor = currentUser(req).user;

  res.json(
    await identity.updateUserProfile({
      userId: id,
      changes,
      actorUserId: actor.id,
      // Named in the warning that goes to the address losing access, so it says
      // who did this rather than that a system did.
      actorName: actor.fullName,
      ip: clientIp(req),
    }),
  );
}

function setSession(req: Request, res: Response, issued: identity.SessionIssued): void {
  const { session, token } = issued;
  res.cookie(SESSION_COOKIE[session.audience], token, cookieFor(req, session.expiresAt));
}

/**
 * `domain` is what lets one login page serve both portals: without it the
 * cookie belongs to whichever origin happened to host the sign-in, and the
 * redirect to the other portal would arrive unauthenticated. It stays unset in
 * development, where the two dev servers differ only by port and cookies
 * ignore ports.
 */
function cookieFor(req: Request, expires: Date): CookieOptions {
  const cookieDomain = config.session.cookieDomain;

  return sessionCookie(expires, crossSite(req, cookieDomain), {
    cookieDomain,
    secure: config.isProduction,
  });
}

function clientIp(req: Request): string | null {
  return req.ip ?? null;
}
