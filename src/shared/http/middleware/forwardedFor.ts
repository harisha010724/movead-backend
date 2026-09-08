import { type RequestHandler } from 'express';

const HEADER = 'x-forwarded-for';

/**
 * Strips the source port that Azure App Service appends to `X-Forwarded-For`.
 *
 * Its front end forwards `203.0.113.5:54321` rather than the bare address every
 * other proxy sends, and `proxy-addr` — which is what `req.ip` is — hands that
 * straight through. Two things break on it. `user_sessions.ip` and
 * `audit_log.ip` are `INET`, so the insert fails with `invalid input syntax`
 * and the whole transaction rolls back: on `/v1/admin/bootstrap` that surfaces
 * as a 500 with no account created. And the rate limiter keys on `req.ip`, so a
 * per-connection port makes every request its own bucket and no limit is ever
 * reached.
 *
 * Must be mounted before anything that reads `req.ip`.
 */
export function forwardedFor(): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers[HEADER];

    if (typeof header === 'string') {
      req.headers[HEADER] = header.split(',').map(stripPort).join(', ');
    }

    next();
  };
}

/**
 * A single colon means IPv4 with a port. Anything with more is IPv6, which
 * carries a port only in the bracketed form — a bare `2001:db8::1` is the
 * address itself and must survive untouched.
 */
function stripPort(entry: string): string {
  const value = entry.trim();

  const bracketed = /^\[(.+)](?::\d+)?$/.exec(value);
  if (bracketed?.[1]) return bracketed[1];

  const colons = value.split(':').length - 1;
  return colons === 1 ? (value.split(':')[0] ?? value) : value;
}
