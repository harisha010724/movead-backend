import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';

import { type Agent, client, enrolAndVerify, signIn } from './helpers/admin';
import { captureMail, type MailInbox } from './helpers/mail';

/**
 * The live map: who may read it, and finding one vehicle on it by its plate.
 *
 * Two advertisers with a vehicle each, because the interesting question is not
 * whether the map draws — `tracking.test.ts` already proves fixes are stored —
 * but whether one buyer can see the other's fleet. The endpoint used to take
 * `campaignId` as its only filter, so omitting it served every vehicle on the
 * platform to whoever asked.
 */

const PRIME_BOX = [
  { lat: 12.97, lng: 77.6 },
  { lat: 12.97, lng: 77.62 },
  { lat: 12.98, lng: 77.62 },
  { lat: 12.98, lng: 77.6 },
];

const CAMPAIGN = {
  city: 'Bengaluru',
  vehicleType: 'CAB',
  startDate: '2026-09-01',
  endDate: '2026-09-30',
  zonePrimeKm: '4000',
  zoneSecondaryKm: '15000',
  zonePolygons: { prime: { path: PRIME_BOX } },
};

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

/** Zephyr's plate and Kestrel's share the `KA` and the `AB`, and nothing else. */
const ZEPHYR = {
  brand: 'Zephyr',
  registration: 'KA05AB9012',
  mobile: '9845012345',
  driverName: 'Rahul Kumar',
  driverEmail: 'rahul.kumar@example.com',
};

const KESTREL = {
  brand: 'Kestrel',
  registration: 'KA09AB3344',
  mobile: '9845067890',
  driverName: 'Priya Nair',
  driverEmail: 'priya.nair@example.com',
};

let reachable = false;
let admin: Agent;
let reviewer: Agent | null = null;
let inbox: MailInbox;

beforeAll(async () => {
  reachable = await pingDatabase().then(
    () => true,
    () => false,
  );
  if (!reachable) {
    console.warn('\n  live position tests skipped: no database reachable at DATABASE_URL\n');
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
  reviewer = null;
  await sequelize.query(
    `TRUNCATE users, user_sessions, user_invitations, audit_log, advertisers, campaigns,
     notifications, drivers, driver_consents, vehicles, campaign_vehicles, installations,
     installation_photos, tracking_sessions, gps_points, trip_segments
     RESTART IDENTITY CASCADE`,
  );
  admin = await signIn();
});

describe('who may read the live map', () => {
  it('shows an advertiser their own vehicle and not the other one', async () => {
    const zephyr = await trackingFleet(ZEPHYR);
    await trackingFleet(KESTREL);

    const map = await zephyr.advertiser.get('/v1/vehicles/live-positions').expect(200);

    expect(plates(map)).toEqual([ZEPHYR.registration]);
  });

  /*
   * The regression this file was written for. `campaignId` was the only
   * filter, and it was optional, so the way to read every plate on the
   * platform was to leave it off — no error, no empty list, just the whole
   * fleet including a competitor's.
   */
  it('does not widen to the whole fleet when the campaign filter is omitted', async () => {
    const zephyr = await trackingFleet(ZEPHYR);
    await trackingFleet(KESTREL);

    const map = await zephyr.advertiser.get('/v1/vehicles/live-positions').expect(200);

    expect(plates(map)).not.toContain(KESTREL.registration);
  });

  it('shows operations both of them', async () => {
    await trackingFleet(ZEPHYR);
    await trackingFleet(KESTREL);

    const map = await admin.get('/v1/vehicles/live-positions').expect(200);

    expect(plates(map).sort()).toEqual([ZEPHYR.registration, KESTREL.registration].sort());
  });

  /*
   * 404 rather than an empty list. The advertiser filter would return nothing
   * either way, but "no vehicles are tracking" and "that campaign is not
   * yours" are different answers and a buyer acts differently on each.
   */
  it('answers 404 for a campaign belonging to someone else', async () => {
    const zephyr = await trackingFleet(ZEPHYR);
    const kestrel = await trackingFleet(KESTREL);

    await zephyr.advertiser
      .get('/v1/vehicles/live-positions')
      .query({ campaignId: kestrel.campaignId })
      .expect(404);
  });

  it('refuses a driver, who has no fleet to watch', async () => {
    const zephyr = await trackingFleet(ZEPHYR);

    await zephyr.driver.get('/v1/vehicles/live-positions').expect(403);
  });

  it('refuses a caller with no session at all', async () => {
    await client().get('/v1/vehicles/live-positions').expect(401);
  });

  /*
   * A dead session must not veto a live one.
   *
   * The portal cookies are prefixed per audience so an operator can hold an
   * admin and an advertiser session in one browser. `requireAnyAuth` walks
   * them in a fixed order and used to commit to the first one present, so a
   * stale `movead_admin_session` — left behind by an earlier visit to the
   * other portal — was tried, failed, and took the request down with it while
   * a valid advertiser cookie sat unread in the same headers.
   *
   * It presented as a signed-in portal insisting the session had ended, and
   * only on the three routes using this guard: `/auth/me`, `/auth/logout` and
   * the live map. Every `requireAuth(audience)` route on the same page worked,
   * which is what made it read like a broken endpoint rather than a broken
   * guard.
   */
  it('reads past a stale cookie for another portal to the live one', async () => {
    await trackingFleet(ZEPHYR);

    // `admin` already carries a working admin cookie. Signing the advertiser
    // in on the same agent puts both in one jar, as one browser would.
    await admin
      .post('/v1/auth/login')
      .send({ email: advertiserEmail(ZEPHYR), password: ADVERTISER_PASSWORD })
      .expect(200);

    await sequelize.query(
      `UPDATE user_sessions SET expires_at = now() - interval '1 hour'
        WHERE user_id = (SELECT id FROM users WHERE email = 'ops@movead.in')`,
    );

    const me = await admin.get('/v1/auth/me').expect(200);
    expect(me.body.audience).toBe('advertiser');

    const map = await admin.get('/v1/vehicles/live-positions').expect(200);
    expect(plates(map)).toEqual([ZEPHYR.registration]);
  });
});

describe('finding a vehicle by its number', () => {
  it('returns the one vehicle whose plate matches in full', async () => {
    const zephyr = await trackingFleet(ZEPHYR);
    await trackingFleet(KESTREL);

    const found = await admin
      .get('/v1/vehicles/live-positions')
      .query({ vehicleNumber: ZEPHYR.registration })
      .expect(200);

    expect(plates(found)).toEqual([ZEPHYR.registration]);
    expect(found.body.items[0]).toMatchObject({
      vehicleRef: ZEPHYR.registration,
      state: 'RUNNING',
    });
    expect(Number(found.body.items[0].lat)).toBeCloseTo(12.979, 2);
    expect(zephyr.campaignId).toBeTruthy();
  });

  /*
   * A plate is read off a wrap in a photograph or repeated down a phone, and
   * the part that survives is rarely the start of it. Both fixtures begin
   * `KA` and carry `AB`, so a prefix match would not distinguish them.
   */
  it('matches the tail of a plate, not only its start', async () => {
    await trackingFleet(ZEPHYR);
    await trackingFleet(KESTREL);

    const found = await admin
      .get('/v1/vehicles/live-positions')
      .query({ vehicleNumber: '3344' })
      .expect(200);

    expect(plates(found)).toEqual([KESTREL.registration]);
  });

  it('ignores the spaces and dashes people type into a plate', async () => {
    await trackingFleet(ZEPHYR);

    const found = await admin
      .get('/v1/vehicles/live-positions')
      .query({ vehicleNumber: 'ka 05-ab' })
      .expect(200);

    expect(plates(found)).toEqual([ZEPHYR.registration]);
  });

  /*
   * The needle is interpolated into a `LIKE` pattern, where `_` matches any
   * one character and `%` matches any run of them. `KA0_AB9012` is Zephyr's
   * plate with one character blanked: if the wildcard reached the pattern it
   * would find the vehicle, and searching `%` would return the whole fleet.
   * Stripped to `KA0AB9012`, it matches nothing, which is the correct answer
   * to a plate nobody has.
   */
  it('treats a wildcard as punctuation rather than as a pattern', async () => {
    await trackingFleet(ZEPHYR);
    await trackingFleet(KESTREL);

    const wildcard = await admin
      .get('/v1/vehicles/live-positions')
      .query({ vehicleNumber: 'KA0_AB9012' })
      .expect(200);
    expect(wildcard.body.items).toEqual([]);

    const literal = await admin
      .get('/v1/vehicles/live-positions')
      .query({ vehicleNumber: 'KA05AB9012' })
      .expect(200);
    expect(plates(literal)).toEqual([ZEPHYR.registration]);
  });

  it('searches within the advertiser, so a competitor cannot be looked up', async () => {
    const zephyr = await trackingFleet(ZEPHYR);
    await trackingFleet(KESTREL);

    const found = await zephyr.advertiser
      .get('/v1/vehicles/live-positions')
      .query({ vehicleNumber: KESTREL.registration })
      .expect(200);

    expect(found.body.items).toEqual([]);
  });

  it('returns nothing rather than everything for a plate that does not exist', async () => {
    await trackingFleet(ZEPHYR);

    const found = await admin
      .get('/v1/vehicles/live-positions')
      .query({ vehicleNumber: 'TN01ZZ0000' })
      .expect(200);

    expect(found.body.items).toEqual([]);
  });
});

// ------------------------------------------------------------------ fixtures

function plates(response: { body: { items: { vehicleRef: string }[] } }): string[] {
  return response.body.items.map((item) => item.vehicleRef);
}

interface Fixture {
  brand: string;
  registration: string;
  mobile: string;
  driverName: string;
  driverEmail: string;
}

/** An advertiser, a live campaign, and a driver mid-session reporting fixes. */
async function trackingFleet(
  fixture: Fixture,
): Promise<{ advertiser: Agent; driver: Agent; campaignId: string }> {
  const advertiser = await signInAdvertiser(fixture);
  const { vehicleId } = await approvedDriverWithVehicle(fixture);

  const created = await advertiser
    .post('/v1/campaigns')
    .send({
      ...CAMPAIGN,
      name: `${fixture.brand} Summer Sale`,
      brandName: fixture.brand,
      requestedVehicleIds: [vehicleId],
    })
    .expect(201);

  const campaignId = String(created.body.id);
  await admin.post(`/v1/admin/campaigns/${campaignId}/approve`).expect(200);
  await admin.post(`/v1/admin/campaigns/${campaignId}/print-ready`).expect(200);

  const assigned = await admin
    .post(`/v1/admin/campaigns/${campaignId}/vehicles`)
    .send({ vehicleIds: [vehicleId] })
    .expect(201);
  const assignmentId = String(assigned.body[0].id);

  for (const angle of ['FRONT', 'REAR', 'LEFT', 'RIGHT']) {
    await admin
      .post(`/v1/admin/assignments/${assignmentId}/photos?angle=${angle}`)
      .attach('file', PNG, { filename: `${angle.toLowerCase()}.png`, contentType: 'image/png' })
      .expect(201);
  }
  await admin.post(`/v1/admin/assignments/${assignmentId}/submit`).expect(200);
  await (await secondAdmin()).post(`/v1/admin/assignments/${assignmentId}/approve`).expect(200);

  const driver = await signInDriver(fixture);
  const session = await driver.post('/v1/driver/tracking/session').send({}).expect(200);

  // Without a fix there is no position, and a vehicle with no position is not
  // on the map — so every assertion about the map needs points uploaded first.
  await driver
    .post('/v1/driver/tracking/points')
    .send({ sessionId: String(session.body.id), points: northboundRun() })
    .expect(200);

  return { advertiser, driver, campaignId };
}

/** Four fixes climbing through the Prime box, ending near 12.979. */
function northboundRun() {
  const base = new Date(Date.now() - 4 * 60 * 1000);
  return [12.9715, 12.974, 12.9765, 12.979].map((lat, index) => ({
    clientPointId: randomUUID(),
    recordedAt: new Date(base.getTime() + index * 30_000).toISOString(),
    lat,
    lon: 77.61,
    accuracyM: 8,
    speedMps: 11,
    headingDeg: 0,
    isMock: false,
  }));
}

const ADVERTISER_PASSWORD = 'advertiser-password-long-enough';

function advertiserEmail(fixture: Fixture): string {
  return `buyer@${fixture.brand.toLowerCase()}.example`;
}

async function signInAdvertiser(fixture: Fixture): Promise<Agent> {
  const email = advertiserEmail(fixture);
  const password = ADVERTISER_PASSWORD;

  await admin
    .post('/v1/admin/advertisers')
    .send({
      legalName: `${fixture.brand} Beverages Private Limited`,
      brandName: fixture.brand,
      billingEmail: `accounts@${fixture.brand.toLowerCase()}.example`,
      user: { email, fullName: `${fixture.brand} Buyer` },
    })
    .expect(201);

  await client()
    .post(`/v1/invitations/${inbox.tokenFor(email)}/accept`)
    .send({ password })
    .expect(200);

  const portal = client();
  await portal.post('/v1/auth/login').send({ email, password }).expect(200);
  return portal;
}

async function approvedDriverWithVehicle(
  fixture: Fixture,
): Promise<{ driverId: string; vehicleId: string }> {
  const driver = await admin
    .post('/v1/admin/drivers')
    .send({
      mobile: fixture.mobile,
      name: fixture.driverName,
      email: fixture.driverEmail,
      location: { city: 'Bengaluru', label: 'MG Road, Bengaluru', lat: 12.9756, lng: 77.6069 },
    })
    .expect(201);
  const driverId = String(driver.body.driver.id);

  const vehicle = await admin
    .post(`/v1/admin/drivers/${driverId}/vehicles`)
    .send({ registrationNumber: fixture.registration, category: 'CAB' })
    .expect(201);
  const vehicleId = String(vehicle.body.id);

  const licence = await uploadDocument({ driverId, kind: 'LICENCE' });
  await admin.post(`/v1/admin/documents/${licence}/verify`).expect(200);
  await admin.post(`/v1/admin/drivers/${driverId}/approve`).expect(200);

  for (const kind of ['RC', 'INSURANCE', 'POLLUTION', 'PERMIT']) {
    const documentId = await uploadDocument({ vehicleId, kind });
    await admin.post(`/v1/admin/documents/${documentId}/verify`).expect(200);
  }
  await admin.post(`/v1/admin/vehicles/${vehicleId}/verify-documents`).expect(200);
  await admin.post(`/v1/admin/vehicles/${vehicleId}/approve`).expect(200);

  return { driverId, vehicleId };
}

async function uploadDocument(input: {
  kind: string;
  driverId?: string;
  vehicleId?: string;
}): Promise<string> {
  const response = await admin
    .post('/v1/admin/documents')
    .send({
      ...input,
      storageKey: `documents/${input.kind.toLowerCase()}/${Date.now()}-${Math.random()}.jpg`,
      contentType: 'image/jpeg',
      byteSize: 204_800,
    })
    .expect(201);

  return String(response.body.id);
}

async function secondAdmin(): Promise<Agent> {
  if (reviewer) return reviewer;

  const email = 'reviewer@movead.in';
  const password = 'reviewer-password-long-enough';

  await admin
    .post('/v1/admin/users')
    .send({ email, fullName: 'Install Reviewer', password, roleKey: 'SUPER_ADMIN' })
    .expect(201);

  const agent = client();
  await enrolAndVerify(agent, email, password);
  reviewer = agent;
  return agent;
}

async function signInDriver(fixture: Fixture): Promise<Agent> {
  const agent = client();
  await agent
    .post('/v1/auth/login')
    .send({ email: fixture.driverEmail, password: inbox.passwordFor(fixture.driverEmail) })
    .expect(200);
  await agent.put('/v1/driver/me/consent').send({ granted: true }).expect(200);
  return agent;
}
