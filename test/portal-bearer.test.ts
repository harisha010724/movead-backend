import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';
import { SESSION_COOKIE } from '../src/shared/http/middleware/auth';

import { client, signInWithToken } from './helpers/admin';

/**
 * A portal may present its session token in `Authorization` as well as in the
 * cookie.
 *
 * Needed because the cookie does not always arrive. Served from a different
 * site than the API, a browser withholds a `SameSite=Strict` cookie entirely,
 * and `None` only converts the problem into a third-party cookie, which Chrome
 * blocks in Incognito and is retiring for everyone. Sign-in succeeded and every
 * request after it was anonymous.
 *
 * The token is the same opaque value the cookie carries, looked up the same
 * way. So what these prove is that the header is read at all, and — as much to
 * the point — that it grants nothing the cookie would not.
 */

let reachable = false;

beforeAll(async () => {
  reachable = await pingDatabase().then(
    () => true,
    () => false,
  );

  if (!reachable) {
    console.warn('\n  portal bearer tests skipped: no database reachable at DATABASE_URL\n');
  }
});

afterAll(async () => {
  if (reachable) await sequelize.close();
});

beforeEach(async (ctx: TestContext) => {
  if (!reachable) {
    ctx.skip();
    return;
  }

  await sequelize.query('TRUNCATE users, user_sessions, audit_log RESTART IDENTITY CASCADE');
});

describe('portal bearer tokens', () => {
  it('authenticates an admin by header exactly as by cookie', async () => {
    const { token } = await signInWithToken();

    const byCookie = await client()
      .get('/v1/auth/me')
      .set('Cookie', `${SESSION_COOKIE.admin}=${token}`);
    const byHeader = await client().get('/v1/auth/me').set('Authorization', `Bearer ${token}`);

    expect(byCookie.status).toBe(200);
    expect(byHeader.status).toBe(200);
    expect(byHeader.body).toEqual(byCookie.body);
  });

  it('reaches a guarded admin route by header', async () => {
    const { token } = await signInWithToken();

    const response = await client()
      .get('/v1/admin/drivers')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
  });

  it('works through the /api prefix, which is how a proxied portal arrives', async () => {
    const { token } = await signInWithToken();

    const response = await client()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
  });

  it('refuses an admin token at an advertiser door', async () => {
    const { token } = await signInWithToken();

    // Same token, different audience. The check reads the session row rather
    // than trusting the header, so this is refused exactly as the cookie is.
    const response = await client().get('/v1/campaigns').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
  });

  it('refuses a token that is not a session', async () => {
    const response = await client()
      .get('/v1/auth/me')
      .set('Authorization', 'Bearer not-a-real-session-token');

    expect(response.status).toBe(401);
  });

  it('refuses a caller presenting nothing at all', async () => {
    expect((await client().get('/v1/auth/me')).status).toBe(401);
  });

  it('stops working once the session is signed out', async () => {
    const { agent, token } = await signInWithToken();

    await agent.post('/v1/auth/logout').expect(204);

    // The row is gone, so the header has nothing left to resolve. A token that
    // outlived its session would be the real danger in accepting one.
    const response = await client().get('/v1/auth/me').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
  });
});
