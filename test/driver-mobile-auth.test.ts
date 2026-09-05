import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type TestContext,
} from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';

import { ADMIN, client, signIn } from './helpers/admin';
import { captureMail, type MailInbox } from './helpers/mail';

/**
 * Driver app sign-in: the same emailed credentials as the web portal, answered
 * with a bearer pair instead of a cookie.
 *
 * The properties worth holding onto are that the access token opens driver
 * routes and nothing else, that refreshing rotates so a captured refresh token
 * has a short useful life, and that revoking the session ends both halves at
 * once rather than waiting for the access token to expire.
 */

const DRIVER = {
  mobile: '9845012345',
  name: 'Rahul Kumar',
  email: 'rahul.driver@example.com',
  location: { city: 'Bengaluru', label: 'MG Road, Bengaluru', lat: 12.9756, lng: 77.6069 },
  vehicle: { registrationNumber: 'KA01AB1234', category: 'CAB' as const },
};

let reachable = false;
let inbox: MailInbox;

beforeAll(async () => {
  reachable = await pingDatabase().then(
    () => true,
    () => false,
  );

  if (!reachable) {
    console.warn('\n  driver-mobile-auth tests skipped: no database reachable at DATABASE_URL\n');
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

  inbox = captureMail();
  await sequelize.query(
    'TRUNCATE users, user_sessions, user_invitations, audit_log, drivers, vehicles, vehicle_status_events, documents RESTART IDENTITY CASCADE',
  );
});

afterEach(() => {
  inbox?.restore();
});

/** Onboards the driver and returns the password that was mailed to them. */
async function onboardedDriver(): Promise<string> {
  const admin = await signIn();
  await admin.post('/v1/admin/drivers').send(DRIVER).expect(201);
  return inbox.passwordFor(DRIVER.email);
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

async function appSignIn(): Promise<Tokens> {
  const password = await onboardedDriver();

  const login = await client()
    .post('/v1/driver/auth/login')
    .send({ email: DRIVER.email, password })
    .expect(200);

  return login.body.tokens as Tokens;
}

describe('driver app sign-in', () => {
  it('exchanges the emailed credentials for a token pair and the driver behind them', async () => {
    const password = await onboardedDriver();

    const login = await client()
      .post('/v1/driver/auth/login')
      .send({ email: DRIVER.email, password })
      .expect(200);

    expect(login.body.tokens.accessToken).toEqual(expect.any(String));
    expect(login.body.tokens.refreshToken).toEqual(expect.any(String));
    expect(login.body.tokens.expiresIn).toBeGreaterThan(0);
    expect(login.body.user).toMatchObject({
      email: DRIVER.email,
      fullName: DRIVER.name,
      audience: 'driver',
    });
    expect(login.body.user.driverId).toEqual(expect.any(String));

    // The app is not a browser; handing it a cookie as well would leave a
    // second credential nobody manages.
    expect(login.headers['set-cookie']).toBeUndefined();

    // Nothing about the password survives into the response.
    expect(JSON.stringify(login.body)).not.toContain(password);
  });

  it('refuses a password that was not the one in the mail', async () => {
    await onboardedDriver();

    await client()
      .post('/v1/driver/auth/login')
      .send({ email: DRIVER.email, password: 'not-the-password-from-the-mail' })
      .expect(401);
  });

  it('refuses an admin account rather than issuing it a driver token', async () => {
    await signIn();

    const attempt = await client()
      .post('/v1/driver/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password })
      .expect(403);

    expect(attempt.body.message).toMatch(/for drivers/i);
  });
});

describe('the access token', () => {
  it('opens the driver’s own routes', async () => {
    const tokens = await appSignIn();

    const profile = await client()
      .get('/v1/driver/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);

    expect(profile.body).toMatchObject({ name: DRIVER.name, mobile: DRIVER.mobile });

    const me = await client()
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);

    expect(me.body.audience).toBe('driver');
  });

  it('opens nothing in the admin portal (WEB-001)', async () => {
    const tokens = await appSignIn();

    await client()
      .get('/v1/admin/drivers')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(401);
  });

  it('is refused when it is not a token this server minted', async () => {
    await onboardedDriver();

    await client()
      .get('/v1/driver/me')
      .set('Authorization', 'Bearer not.a.real.token')
      .expect(401);
  });

  it('does not let the refresh token stand in for it', async () => {
    const tokens = await appSignIn();

    await client()
      .get('/v1/driver/me')
      .set('Authorization', `Bearer ${tokens.refreshToken}`)
      .expect(401);
  });
});

describe('refreshing', () => {
  it('returns a new pair and retires the token that was spent', async () => {
    const tokens = await appSignIn();

    const refreshed = await client()
      .post('/v1/driver/auth/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(200);

    expect(refreshed.body.refreshToken).not.toBe(tokens.refreshToken);

    // The new access token works...
    await client()
      .get('/v1/driver/me')
      .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
      .expect(200);

    // ...and the refresh token it replaced does not.
    await client()
      .post('/v1/driver/auth/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(401);
  });

  it('keeps the session, so an access token issued before the rotation still works', async () => {
    const tokens = await appSignIn();

    await client()
      .post('/v1/driver/auth/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(200);

    await client()
      .get('/v1/driver/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);
  });

  it('refuses a token it has never seen', async () => {
    await onboardedDriver();

    await client()
      .post('/v1/driver/auth/refresh')
      .send({ refreshToken: 'nothing-was-ever-issued-with-this-value' })
      .expect(401);
  });
});

describe('signing out', () => {
  it('ends both halves at once', async () => {
    const tokens = await appSignIn();

    await client()
      .post('/v1/driver/auth/logout')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(204);

    // The access token is still inside its fifteen minutes and still correctly
    // signed. It is the session behind it that has gone, which is the whole
    // reason the token names a session rather than carrying the account.
    await client()
      .get('/v1/driver/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(401);

    await client()
      .post('/v1/driver/auth/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(401);
  });
});

describe('the web portal is unaffected', () => {
  it('still signs the same driver in with a cookie', async () => {
    const password = await onboardedDriver();

    const portal = client();
    const login = await portal
      .post('/v1/auth/login')
      .send({ email: DRIVER.email, password })
      .expect(200);

    expect(login.body.audience).toBe('driver');
    expect([login.headers['set-cookie']].flat().join(';')).toMatch(/movead_driver_session=/);

    await portal.get('/v1/driver/me').expect(200);
  });

  it('signs in on the app and the web at once, and signing out of one leaves the other alone', async () => {
    const password = await onboardedDriver();

    const portal = client();
    await portal.post('/v1/auth/login').send({ email: DRIVER.email, password }).expect(200);

    const login = await client()
      .post('/v1/driver/auth/login')
      .send({ email: DRIVER.email, password })
      .expect(200);
    const tokens = login.body.tokens as Tokens;

    await client()
      .post('/v1/driver/auth/logout')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(204);

    await portal.get('/v1/driver/me').expect(200);
  });
});
