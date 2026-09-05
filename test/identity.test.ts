import { QueryTypes } from 'sequelize';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';
import { currentTotp } from '../src/modules/identity/credentials';

import { ADMIN, BOOTSTRAP_TOKEN, bootstrap, client, signIn } from './helpers/admin';

/**
 * Integration tests against a real PostgreSQL. The permission graph, the
 * unique constraint on email and the lockout counter are all database
 * behaviour, and a mock of them would only prove that the mock works.
 *
 * The suite skips rather than fails when no database is reachable, so a fresh
 * clone can still run `npm test`.
 */
let reachable = false;

beforeAll(async () => {
  reachable = await pingDatabase().then(
    () => true,
    () => false,
  );

  if (!reachable) {
    console.warn('\n  identity tests skipped: no database reachable at DATABASE_URL\n');
  }
});

afterAll(async () => {
  if (reachable) await sequelize.close();
});

/** One guard for the whole file, and a clean slate for every test. */
beforeEach(async (ctx: TestContext) => {
  if (!reachable) {
    ctx.skip();
    return;
  }

  await sequelize.query('TRUNCATE users, user_sessions, audit_log RESTART IDENTITY CASCADE');
});

describe('admin bootstrap', () => {
  it('refuses a wrong bootstrap token', async () => {
    const response = await client()
      .post('/v1/admin/bootstrap')
      .send({ ...ADMIN, token: 'not-the-token-at-all' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('forbidden');
  });

  it('creates the first Super Admin with every permission', async () => {
    const response = await client()
      .post('/v1/admin/bootstrap')
      .send({ ...ADMIN, token: BOOTSTRAP_TOKEN });

    expect(response.status).toBe(201);
    expect(response.body.roles).toEqual(['SUPER_ADMIN']);
    expect(response.body.permissions).toContain('payout.release');
    expect(response.body.permissions).toContain('driver.approve');
    expect(response.body).not.toHaveProperty('passwordHash');
  });

  it('cannot be used twice', async () => {
    const agent = client();
    await bootstrap(agent);

    const second = await agent
      .post('/v1/admin/bootstrap')
      .send({ ...ADMIN, email: 'other@movead.in', token: BOOTSTRAP_TOKEN });

    expect(second.status).toBe(409);
  });

  it('records the bootstrap in the audit trail with no actor', async () => {
    await bootstrap(client());

    const [entry] = await sequelize.query<{ action: string; actor_user_id: string | null }>(
      'SELECT action, actor_user_id FROM audit_log ORDER BY id',
      { type: QueryTypes.SELECT },
    );

    expect(entry?.action).toBe('admin.bootstrapped');
    // Nobody was signed in, so the actor is genuinely absent rather than
    // attributed to a service account.
    expect(entry?.actor_user_id).toBeNull();
  });
});

describe('admin sign-in', () => {
  it('rejects a wrong password without revealing whether the account exists', async () => {
    const agent = client();
    await bootstrap(agent);

    const known = await agent
      .post('/v1/auth/login')
      .send({ email: ADMIN.email, password: 'wrong-password-entirely' });
    const unknown = await agent
      .post('/v1/auth/login')
      .send({ email: 'nobody@movead.in', password: 'wrong-password-entirely' });

    expect(known.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(known.body.message).toBe(unknown.body.message);
  });

  it('never issues a session from the password alone', async () => {
    const agent = client();
    await bootstrap(agent);

    const response = await agent
      .post('/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('mfa_enrolment_required');
    expect(response.body.audience).toBe('admin');
    expect(response.body.challengeToken).toBeTruthy();
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('completes enrolment, signs in, and revokes on sign-out', async () => {
    const agent = client();
    await bootstrap(agent);

    const login = await agent
      .post('/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password });

    const enrol = await agent
      .post('/v1/auth/mfa/enrol')
      .send({ challengeToken: login.body.challengeToken });

    expect(enrol.status).toBe(200);
    expect(enrol.body.otpauthUri).toContain('otpauth://totp/MoveAd:');

    const verify = await agent.post('/v1/auth/mfa/verify').send({
      challengeToken: login.body.challengeToken,
      code: await currentTotp(String(enrol.body.secret)),
    });

    expect(verify.status).toBe(200);
    expect(verify.body.audience).toBe('admin');
    expect(verify.body.user.email).toBe(ADMIN.email);

    const cookie = String((verify.headers['set-cookie'] as unknown as string[])[0]);
    expect(cookie).toContain('movead_admin_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');

    const me = await agent.get('/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.permissions.length).toBeGreaterThan(20);

    expect((await agent.post('/v1/auth/logout')).status).toBe(204);

    // The session lives in the database, so revocation takes effect now rather
    // than whenever the cookie would have expired.
    expect((await agent.get('/v1/auth/me')).status).toBe(401);
  });

  it('rejects a wrong code', async () => {
    const agent = client();
    await bootstrap(agent);

    const login = await agent
      .post('/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password });
    await agent.post('/v1/auth/mfa/enrol').send({ challengeToken: login.body.challengeToken });

    const verify = await agent
      .post('/v1/auth/mfa/verify')
      .send({ challengeToken: login.body.challengeToken, code: '000000' });

    expect(verify.status).toBe(401);
    expect(verify.headers['set-cookie']).toBeUndefined();
  });

  it('locks the account after repeated failures, even for the right password', async () => {
    const agent = client();
    await bootstrap(agent);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await agent
        .post('/v1/auth/login')
        .send({ email: ADMIN.email, password: 'wrong-password-entirely' });
    }

    const response = await agent
      .post('/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password });

    expect(response.status).toBe(423);
    expect(response.body.code).toBe('account_locked');
  });
});

describe('admin authorisation', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await client().get('/v1/auth/me');

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('unauthenticated');
  });

  it('refuses a forged session cookie', async () => {
    const response = await client()
      .get('/v1/auth/me')
      .set('Cookie', 'movead_admin_session=made-up-value');

    expect(response.status).toBe(401);
  });

  it('lets a signed-in admin create another admin', async () => {
    const agent = await signIn();

    const response = await agent.post('/v1/admin/users').send({
      email: 'second@movead.in',
      fullName: 'Second Admin',
      password: 'another-long-enough-password',
      roleKey: 'SUPER_ADMIN',
    });

    expect(response.status).toBe(201);
    expect(response.body.roles).toEqual(['SUPER_ADMIN']);
  });

  it('rejects a duplicate email as a conflict, not a crash', async () => {
    const agent = await signIn();

    const response = await agent.post('/v1/admin/users').send({
      email: ADMIN.email,
      fullName: 'Impostor',
      password: 'another-long-enough-password',
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('conflict');
  });
});
