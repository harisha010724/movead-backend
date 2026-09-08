import { type CookieOptions, type Request } from 'express';

/**
 * The attributes the portal session cookie is set and cleared with.
 *
 * Its own module because two things need to agree on them exactly — the sign-in
 * that sets the cookie and the sign-out that clears it. A clear whose
 * attributes differ does not match the stored cookie, and the browser keeps it.
 */

export interface CookieContext {
  /** `COOKIE_DOMAIN`, or null where the cookie belongs to one host. */
  cookieDomain: string | null;
  secure: boolean;
}

/**
 * `httpOnly` so an XSS in the portal cannot read it, `Secure` outside
 * development, and `SameSite=Strict` so no cross-site request can ride it —
 * the attributes architecture Part 12.1 requires.
 *
 * `Strict` unless the portal that signed in cannot be reached by it. A cookie
 * the browser refuses to send is not a stricter cookie, it is a broken login:
 * the sign-in succeeds, the cookie is stored, and every request afterwards
 * arrives anonymous. So when the caller is a different site from this server,
 * the cookie is issued `None` — still `Secure`, still `httpOnly` — because a
 * session that works is worth more than an attribute that reads well.
 *
 * The relaxation is narrow and undoes itself. Only an origin the operator put
 * in `CORS_ORIGINS` reaches this code, since anything else is refused before
 * the route runs; and the moment the portal and the API share a site — a
 * linked backend, or `app.` and `api.` under one domain with `COOKIE_DOMAIN`
 * set — `crossSite` reads false and `Strict` returns with nothing to remember
 * to change back.
 */
export function sessionCookie(
  expires: Date,
  isCrossSite: boolean,
  context: CookieContext,
): CookieOptions {
  return {
    httpOnly: true,
    // `SameSite=None` is discarded without it, so a cross-site cookie forces it
    // even where production has not. In practice that is only ever localhost,
    // which browsers already treat as a secure origin.
    secure: context.secure || isCrossSite,
    sameSite: isCrossSite ? 'none' : 'strict',
    path: '/',
    expires,
    ...(context.cookieDomain ? { domain: context.cookieDomain } : {}),
  };
}

/**
 * Whether the caller is a different site from the one answering.
 *
 * No `Origin` means no browser, and so no SameSite rule to satisfy — the mobile
 * app and every server-side client land here.
 *
 * Hosts are compared whole rather than reduced to a registrable domain. Doing
 * that reduction correctly needs the public suffix list, and guessing at it
 * errs towards calling two sites the same when they are not. `COOKIE_DOMAIN`
 * already states which suffix the operator treats as one site, and it is the
 * same value the cookie is scoped to, so subdomains of it are recognised
 * without anything being inferred.
 */
export function crossSite(req: Request, cookieDomain: string | null): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;

  if (!origin || !host) return false;
  if (origin === `${req.protocol}://${host}`) return false;

  const originHost = hostOf(origin);
  if (!originHost) return false;

  const shared = cookieDomain?.replace(/^\./, '');
  if (shared && under(originHost, shared) && under(hostname(host), shared)) return false;

  return originHost !== hostname(host);
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

/** Strips the port, and leaves a bracketed IPv6 literal alone. */
function hostname(host: string): string {
  return host.startsWith('[') ? host : (host.split(':')[0] ?? host);
}

function under(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}
