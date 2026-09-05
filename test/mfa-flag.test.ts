// Must come first: it sets the environment the config below reads at import.
import './helpers/noMfa';

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';
import { app } from '../src/entrypoints/api';

/**
 * `ADMIN_MFA_REQUIRED=false` — the build-time escape hatch that lets admins in
 * on the password alone while the portal screens are being built.
 *
 * Everything here is the *opposite* of what `identity.test.ts` asserts, which
 * is the point: that suite runs with the flag on and proves the second factor
 * is enforced. Between them, neither state can regress unnoticed.
 */

const ADMIN = {
  email: 'ops@movead.in',
  fullName: 'Ops Admin',
  password: 'correct-horse-battery-staple',
};

const BOOTSTRAP_TOKEN = process.env.ADMIN_BOOTSTRAP_TOKEN ?? 'local-bootstrap-token-change-me';

let reachable = false;
let nextIp = 0;

function client() {
  nextIp += 1;
  return request.agent(app).set('X-Forwarded-For', `10.9.0.${String((nextIp % 250) + 1)}`);
}

beforeAll(async () => {
  reachable = await pingDatabase().then(
    () => true,
    () => false,
  );

  if (!reachable) {
    console.warn('\n  mfa flag tests skipped: no database reachable at DATABASE_URL\n');
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

  await sequelize.query('TRUNCATE users, user_sessions, audit_log, advertisers RESTART IDENTITY CASCADE');
});

describe('admin sign-in with the second factor switched off', () => {
  it('issues a session from the password alone, with no enrolment step', async () => {
    const agent = client();
    await agent
      .post('/v1/admin/bootstrap')
      .send({ ...ADMIN, token: BOOTSTRAP_TOKEN })
      .expect(201);

    const login = await agent
      .post('/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password });

    expect(login.status).toBe(200);
    expect(login.body.status).toBe('authenticated');
    expect(login.body.audience).toBe('admin');
    expect(login.body).not.toHaveProperty('challengeToken');

    const cookie = String((login.headers['set-cookie'] as unknown as string[])[0]);
    expect(cookie).toContain('movead_admin_session=');
    expect(cookie).toContain('HttpOnly');
  });

  it('lands on a usable session, not merely a cookie', async () => {
    const agent = client();
    await agent
      .post('/v1/admin/bootstrap')
      .send({ ...ADMIN, token: BOOTSTRAP_TOKEN })
      .expect(201);
    await agent
      .post('/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password })
      .expect(200);

    const me = await agent.get('/v1/auth/me').expect(200);
    expect(me.body.email).toBe(ADMIN.email);
    expect(me.body.permissions).toContain('user.create');

    // The thing the flag is for: an admin screen answers immediately.
    await agent.get('/v1/admin/drivers').expect(200);
  });

  it('skips the code for an account enrolled before the flag was turned off', async () => {
    const agent = client();
    await agent
      .post('/v1/admin/bootstrap')
      .send({ ...ADMIN, token: BOOTSTRAP_TOKEN })
      .expect(201);

    // Exactly the state a developer is in after running `admin:first`: a real
    // authenticator on the row. Without the ordering in `login` this account
    // would still be prompted, which is the bug the flag exists to avoid.
    await sequelize.query('UPDATE users SET totp_enabled_at = now() WHERE email = $1', {
      bind: [ADMIN.email],
    });

    const login = await agent
      .post('/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password });

    expect(login.body.status).toBe('authenticated');
  });

  it('still refuses a wrong password, because this is not a way in', async () => {
    const agent = client();
    await agent
      .post('/v1/admin/bootstrap')
      .send({ ...ADMIN, token: BOOTSTRAP_TOKEN })
      .expect(201);

    const login = await agent
      .post('/v1/auth/login')
      .send({ email: ADMIN.email, password: 'not-the-right-password' });

    expect(login.status).toBe(401);
    expect(login.headers['set-cookie']).toBeUndefined();
  });
});
