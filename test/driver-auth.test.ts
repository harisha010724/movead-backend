import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';

import { type Agent, client, signIn } from './helpers/admin';
import { captureMail, type MailInbox } from './helpers/mail';

/**
 * Driver web login: admin onboard → username and password in the mail → cookie.
 *
 * Advertiser invitations still never carry a password. Drivers get one so they
 * can sign in without a set-password step.
 */

const DRIVER = {
  mobile: '9845012345',
  name: 'Rahul Kumar',
  email: 'rahul.driver@example.com',
  location: {
    city: 'Bengaluru',
    label: 'MG Road, Bengaluru',
    lat: 12.9756,
    lng: 77.6069,
  },
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
    console.warn('\n  driver-auth tests skipped: no database reachable at DATABASE_URL\n');
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

function onboard(admin: Agent) {
  return admin.post('/v1/admin/drivers').send(DRIVER);
}

describe('driver invitation and web login', () => {
  it('emails a username and password to the address the admin typed', async () => {
    const admin = await signIn();
    const response = await onboard(admin);

    expect(response.status).toBe(201);
    expect(response.body.invitationEmailed).toBe(true);
    expect(response.body.user).toMatchObject({ email: DRIVER.email, status: 'ACTIVE' });
    expect(JSON.stringify(response.body)).not.toMatch(/Password:/);
    expect(response.body).not.toHaveProperty('password');

    const mail = inbox.to(DRIVER.email);
    expect(mail.subject).toMatch(/driver login is ready/i);
    expect(mail.text).toContain(`Username: ${DRIVER.email}`);
    expect(mail.text).toMatch(/^Password: \S+/m);
    expect(mail.text).toContain('/driver/login');
    expect(mail.text).not.toContain('/invitation/');
  });

  it('rejects a password that was not the one in the mail', async () => {
    const admin = await signIn();
    await onboard(admin).expect(201);

    const attempt = await client()
      .post('/v1/auth/login')
      .send({ email: DRIVER.email, password: 'not-the-password-from-the-mail' });

    expect(attempt.status).toBe(401);
  });

  it('signs the driver in immediately with the emailed credentials', async () => {
    const admin = await signIn();
    await onboard(admin).expect(201);
    const password = inbox.passwordFor(DRIVER.email);

    const portal = client();
    const login = await portal
      .post('/v1/auth/login')
      .send({ email: DRIVER.email, password })
      .expect(200);

    expect(login.body.status).toBe('authenticated');
    expect(login.body.audience).toBe('driver');
    expect(login.body.user.driverId).toBe((await onboardedDriverId(admin)).id);
    expect([login.headers['set-cookie']].flat().join(';')).toMatch(/movead_driver_session=/);
    expect(typeof login.body.sessionToken).toBe('string');

    const me = await portal.get('/v1/auth/me').expect(200);
    expect(me.body.audience).toBe('driver');
    expect(me.body.email).toBe(DRIVER.email);

    const profile = await portal.get('/v1/driver/me').expect(200);
    expect(profile.body.name).toBe(DRIVER.name);
    expect(profile.body.mobile).toBe(DRIVER.mobile);

    /*
     * The deployed web portal cannot use the cookie: its static-app host and
     * the API host are different sites, and Incognito blocks the relaxed
     * third-party form too. It therefore sends this same opaque session token
     * as a bearer. Use a fresh agent with no cookie jar, or this assertion
     * would pass for the wrong reason.
     */
    const bearerOnly = client().set('Authorization', `Bearer ${String(login.body.sessionToken)}`);
    const bearerMe = await bearerOnly.get('/v1/auth/me').expect(200);
    expect(bearerMe.body.audience).toBe('driver');
    await bearerOnly.get('/v1/driver/me').expect(200);
  });

  /*
   * Both clients declare this shape by hand, so a field the API stops sending
   * or sends in the wrong case is a runtime hole TypeScript cannot see. The
   * casing in particular: every driver-facing enum is lowercase, and the
   * database column this reads is not.
   */
  it('answers the driver in the driver-facing vocabulary', async () => {
    const admin = await signIn();
    await onboard(admin).expect(201);

    const portal = client();
    await portal
      .post('/v1/auth/login')
      .send({ email: DRIVER.email, password: inbox.passwordFor(DRIVER.email) })
      .expect(200);

    const { body } = await portal.get('/v1/driver/me').expect(200);

    expect(body.status).toBe('pending');
    // A freshly onboarded driver is not approved, and neither is their
    // vehicle, so nothing may badge them as ready to drive (AC-05).
    expect(body.canTrack).toBe(false);
    // Declared by both clients; null rather than absent, so the avatar falls
    // back to initials instead of rendering a broken image.
    expect(body.photoUrl).toBeNull();
    expect(typeof body.joinedAt).toBe('string');
    // Nothing to explain yet. The app gates on `status` and shows this verbatim
    // when it is set, so waiting normally must not read as a rejection.
    expect(body.statusReason).toBeNull();
  });

  it('tells a suspended driver why they are locked out', async () => {
    const admin = await signIn();
    const { body: created } = await onboard(admin).expect(201);

    await admin
      .post(`/v1/admin/drivers/${created.driver.id}/suspend`)
      .send({ reason: 'Licence expired on 12 August' })
      .expect(200);

    const portal = client();
    await portal
      .post('/v1/auth/login')
      .send({ email: DRIVER.email, password: inbox.passwordFor(DRIVER.email) })
      .expect(200);

    const { body } = await portal.get('/v1/driver/me').expect(200);

    expect(body.status).toBe('suspended');
    expect(body.statusReason).toBe('Licence expired on 12 August');
  });
});

async function onboardedDriverId(admin: Agent): Promise<{ id: string }> {
  const list = await admin.get('/v1/admin/drivers').expect(200);
  return { id: String(list.body.items[0]?.id) };
}
