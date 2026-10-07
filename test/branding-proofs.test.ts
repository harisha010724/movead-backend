import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';

import { type Agent, client, enrolAndVerify, signIn } from './helpers/admin';
import { captureMail, type MailInbox } from './helpers/mail';

/**
 * Driver wrap-photo checks: request, camera upload with a server-recorded
 * location, then publish to the advertiser. Installation evidence is a
 * different queue.
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
  adDimension: 'WRAP_180',
  startDate: '2026-09-01',
  endDate: '2026-12-31',
  zonePrimeKm: '4000',
  zoneSecondaryKm: '15000',
  zonePolygons: { prime: { path: PRIME_BOX } },
};

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

const DRIVER = {
  mobile: '9845011111',
  name: 'Ramesh Babu',
  email: 'ramesh.wrap@example.com',
};

let reachable = false;
let admin: Agent;
let inbox: MailInbox;
let reviewer: Agent | null = null;

beforeAll(async () => {
  reachable = await pingDatabase().then(
    () => true,
    () => false,
  );
  if (!reachable) {
    console.warn('\n  branding proof tests skipped: no database reachable at DATABASE_URL\n');
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
     installation_photos, branding_proofs, branding_proof_photos, tracking_sessions,
     gps_points, trip_segments
     RESTART IDENTITY CASCADE`,
  );
  admin = await signIn();
});

describe('wrap-photo checks', () => {
  it('opens a check when the wrap is approved, and the driver can submit it', async () => {
    const { driver, assignmentId, advertiser, campaignId } = await liveVehicle();

    const current = await driver.get('/v1/driver/branding-proof').expect(200);
    expect(current.body.status).toBe('REQUESTED');
    expect(current.body.required).toEqual(['FRONT', 'REAR', 'LEFT', 'RIGHT', 'AD_CLOSEUP']);
    expect(current.body.assignmentId).toBe(assignmentId);

    for (const angle of current.body.required as string[]) {
      await uploadWrap(driver, current.body.id, angle);
    }

    const submitted = await driver.post(`/v1/driver/branding-proofs/${current.body.id}/submit`).expect(200);
    expect(submitted.body.status).toBe('SUBMITTED');
    expect(submitted.body.photoCount).toBe(5);
    expect(submitted.body.photos[0].lat).toBeCloseTo(12.9716, 3);

    const published = await advertiser.get(`/v1/campaigns/${campaignId}/branding-proofs`).expect(200);
    expect(published.body.items).toHaveLength(1);
    expect(published.body.items[0].registrationNumber).toBe('KA01BA1232');
    expect(published.body.items[0].photoCount).toBe(5);

    const photoId = String(published.body.items[0].photos[0].id);
    const photo = await advertiser
      .get(`/v1/campaigns/${campaignId}/branding-proof-photos/${photoId}`)
      .expect(200);
    expect(photo.headers['content-type']).toMatch(/image\//);
  });

  it('refuses a gallery-aged capture and a second open request', async () => {
    const { driver, assignmentId } = await liveVehicle();
    const current = await driver.get('/v1/driver/branding-proof').expect(200);

    const stale = await driver
      .post(
        `/v1/driver/branding-proofs/${current.body.id}/photos?${photoQuery('FRONT', {
          capturedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        })}`,
      )
      .attach('file', PNG, { filename: 'front.png', contentType: 'image/png' });
    expect(stale.status).toBe(400);
    expect(stale.body.message).toMatch(/too old/i);

    await admin.post(`/v1/admin/assignments/${assignmentId}/branding-proofs`).expect(409);
  });

  it('accepts wrap-photo metadata as multipart fields', async () => {
    const { driver } = await liveVehicle();
    const current = await driver.get('/v1/driver/branding-proof').expect(200);

    const stored = await driver
      .post(`/v1/driver/branding-proofs/${current.body.id}/photos`)
      .field('angle', 'FRONT')
      .field('lat', '12.9716')
      .field('lon', '77.5946')
      .field('capturedAt', new Date().toISOString())
      .attach('file', PNG, { filename: 'front.png', contentType: 'image/png' })
      .expect(201);

    expect(stored.body.uploaded).toContain('FRONT');
  });

  it('publishes photos to the advertiser without an admin decision', async () => {
    const { driver, advertiser, campaignId, assignmentId } = await liveVehicle();
    const current = await driver.get('/v1/driver/branding-proof').expect(200);

    for (const angle of current.body.required as string[]) {
      await uploadWrap(driver, current.body.id, angle);
    }
    await driver.post(`/v1/driver/branding-proofs/${current.body.id}/submit`).expect(200);

    expect((await driver.get('/v1/driver/eligibility').expect(200)).body.eligible).toBe(true);
    expect((await advertiser.get(`/v1/campaigns/${campaignId}/branding-proofs`).expect(200)).body.items)
      .toHaveLength(1);

    await admin.post(`/v1/admin/assignments/${assignmentId}/branding-proofs`).expect(201);
    const again = await driver.get('/v1/driver/branding-proof').expect(200);
    expect(again.body.status).toBe('REQUESTED');
    expect((await driver.get('/v1/driver/eligibility').expect(200)).body.eligible).toBe(true);
  });

  it('lets the driver start a wrap-photo set without waiting for operations', async () => {
    const { driver } = await liveVehicle();
    const first = await driver.get('/v1/driver/branding-proof').expect(200);
    const started = await driver.post('/v1/driver/branding-proofs').expect(201);
    expect(started.body.id).toBe(first.body.id);
    expect(started.body.status).toBe('REQUESTED');

    for (const angle of started.body.required as string[]) {
      await uploadWrap(driver, started.body.id, angle);
    }
    await driver.post(`/v1/driver/branding-proofs/${started.body.id}/submit`).expect(200);

    const next = await driver.post('/v1/driver/branding-proofs').expect(201);
    expect(next.body.id).not.toBe(started.body.id);
    expect(next.body.status).toBe('REQUESTED');
  });
});

async function liveVehicle(): Promise<{
  driver: Agent;
  assignmentId: string;
  advertiser: Agent;
  campaignId: string;
}> {
  const advertiser = await signInAdvertiser();
  const { vehicleId } = await approvedDriverWithVehicle();

  const created = await advertiser
    .post('/v1/campaigns')
    .send({
      ...CAMPAIGN,
      name: 'ABC Summer 1',
      brandName: 'ABC',
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

  const driver = client();
  await driver
    .post('/v1/auth/login')
    .send({ email: DRIVER.email, password: inbox.passwordFor(DRIVER.email) })
    .expect(200);
  await driver.put('/v1/driver/me/consent').send({ granted: true }).expect(200);

  return { driver, assignmentId, advertiser, campaignId };
}

function photoQuery(
  angle: string,
  over: { lat?: number; lon?: number; capturedAt?: string } = {},
): string {
  const params = new URLSearchParams({
    angle,
    lat: String(over.lat ?? 12.9716),
    lon: String(over.lon ?? 77.5946),
    capturedAt: over.capturedAt ?? new Date().toISOString(),
  });
  return params.toString();
}

async function uploadWrap(driver: Agent, proofId: string, angle: string): Promise<void> {
  await driver
    .post(`/v1/driver/branding-proofs/${proofId}/photos?${photoQuery(angle)}`)
    .attach('file', PNG, { filename: `${angle.toLowerCase()}.png`, contentType: 'image/png' })
    .expect(201);
}

const ADVERTISER_PASSWORD = 'advertiser-password-long-enough';

async function signInAdvertiser(): Promise<Agent> {
  const email = 'buyer@abc.example';
  await admin
    .post('/v1/admin/advertisers')
    .send({
      legalName: 'ABC Retail Private Limited',
      brandName: 'ABC',
      billingEmail: 'accounts@abc.example',
      user: { email, fullName: 'ABC Buyer' },
    })
    .expect(201);

  await client()
    .post(`/v1/invitations/${inbox.tokenFor(email)}/accept`)
    .send({ password: ADVERTISER_PASSWORD })
    .expect(200);

  const portal = client();
  await portal.post('/v1/auth/login').send({ email, password: ADVERTISER_PASSWORD }).expect(200);
  return portal;
}

async function approvedDriverWithVehicle(): Promise<{ driverId: string; vehicleId: string }> {
  const driver = await admin.post('/v1/admin/drivers').send(DRIVER).expect(201);
  const driverId = String(driver.body.driver.id);

  const vehicle = await admin
    .post(`/v1/admin/drivers/${driverId}/vehicles`)
    .send({ registrationNumber: 'KA01BA1232', category: 'CAB' })
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
  const email = 'wrap-reviewer@movead.in';
  const password = 'reviewer-password-long-enough';
  await admin
    .post('/v1/admin/users')
    .send({ email, fullName: 'Wrap Reviewer', password, roleKey: 'SUPER_ADMIN' })
    .expect(201);
  const agent = client();
  await enrolAndVerify(agent, email, password);
  reviewer = agent;
  return agent;
}
