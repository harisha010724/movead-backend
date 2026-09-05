import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';

import { type Agent, client, signIn } from './helpers/admin';
import { captureMail, type MailInbox } from './helpers/mail';

/**
 * The driver describing their own vehicle (UI-014, UI-015, UI-016).
 *
 * The colour of a driver's car is not something operations knows. AC-04 asks
 * an admin for a plate and a vehicle type over a phone call and stops there,
 * so five columns have existed since migration 005 and stayed null in every
 * row ever created. This is the endpoint that fills them.
 *
 * The decision under test, more than any single field, is that **an edit does
 * not un-approve the vehicle**. UI-016.5 demotes on changes to "attributes
 * that affect verification"; the two that do — the plate the documents were
 * verified against, and the category an advertiser is billed for — are not on
 * this endpoint at all. Several cases below exist only to hold that line, both
 * halves of it: the driver cannot reach identity, and correcting a description
 * cannot cost them a live campaign.
 */

const DRIVER = {
  mobile: '9845012345',
  name: 'Rahul Kumar',
  email: 'rahul.kumar@example.com',
  location: { city: 'Bengaluru', label: 'MG Road, Bengaluru', lat: 12.9756, lng: 77.6069 },
};

const PLATE = 'KA05MN9012';

const DETAILS = {
  bodyType: 'Sedan',
  makeModel: 'Hyundai Verna',
  colour: 'White',
  manufactureYear: 2024,
  fuelType: 'PETROL',
};

/** 1×1 PNG. Small enough to embed, real enough for the MIME check. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

let reachable = false;
let admin: Agent;
let inbox: MailInbox;

beforeAll(async () => {
  reachable = await pingDatabase().then(
    () => true,
    () => false,
  );
  if (!reachable) {
    console.warn('\n  driver vehicle tests skipped: no database reachable at DATABASE_URL\n');
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
    `TRUNCATE users, user_sessions, user_invitations, audit_log, advertisers, campaigns,
     notifications, drivers, driver_consents, vehicles, campaign_vehicles, installations,
     installation_photos, tracking_sessions, gps_points, trip_segments
     RESTART IDENTITY CASCADE`,
  );
  admin = await signIn();
});

describe('reading the vehicle (UI-014, UI-015)', () => {
  it('answers null rather than 404 when operations has not put one on file', async () => {
    const { driver } = await onboarded({ withVehicle: false });

    const response = await driver.get('/v1/driver/me/vehicle').expect(200);
    expect(response.body).toBeNull();
  });

  /*
   * What a freshly onboarded vehicle actually looks like, and the reason this
   * whole feature exists: the plate and the type are there because an admin
   * had them, and everything a driver would recognise their own car by is
   * empty.
   */
  it('starts as a plate, a type, and five blanks', async () => {
    const { driver } = await onboarded();

    const vehicle = (await driver.get('/v1/driver/me/vehicle').expect(200)).body;

    expect(vehicle).toMatchObject({
      registrationNumber: PLATE,
      category: 'CAB',
      status: 'pending',
      canEarn: false,
      bodyType: null,
      makeModel: null,
      colour: null,
      manufactureYear: null,
      fuelType: null,
      photoUrl: null,
    });
  });

  it('carries the reason when the vehicle was rejected (UI-014.4)', async () => {
    const { driver, vehicleId } = await onboarded();

    await admin
      .post(`/v1/admin/vehicles/${vehicleId}/reject`)
      .send({ reason: 'The RC is for a different vehicle.' })
      .expect(200);

    const vehicle = (await driver.get('/v1/driver/me/vehicle').expect(200)).body;
    expect(vehicle.status).toBe('rejected');
    expect(vehicle.statusReason).toBe('The RC is for a different vehicle.');
    expect(vehicle.canEarn).toBe(false);
  });

  /*
   * Ten admin statuses arrive as five. AVAILABLE is a distinct row state and
   * an identical answer to the only question this screen asks, so a driver is
   * never shown a word whose difference from `approved` they cannot act on.
   */
  it('collapses the working statuses into one answer', async () => {
    const { driver, vehicleId } = await onboarded({ approved: true });

    expect((await driver.get('/v1/driver/me/vehicle').expect(200)).body).toMatchObject({
      status: 'approved',
      canEarn: true,
    });

    await sequelize.query(`UPDATE vehicles SET status = 'ACTIVE' WHERE id = '${vehicleId}'`);

    expect((await driver.get('/v1/driver/me/vehicle').expect(200)).body).toMatchObject({
      status: 'approved',
      canEarn: true,
    });
  });
});

describe('describing the vehicle (UI-015, UI-016)', () => {
  it('saves all five, and reads them back after a fresh sign-in', async () => {
    const { driver } = await onboarded();

    const saved = await driver.patch('/v1/driver/me/vehicle').send(DETAILS).expect(200);
    expect(saved.body).toMatchObject(DETAILS);

    const again = await (await signInDriver()).get('/v1/driver/me/vehicle').expect(200);
    expect(again.body).toMatchObject(DETAILS);
  });

  it('leaves absent fields alone and clears the ones sent as null', async () => {
    const { driver } = await onboarded();
    await driver.patch('/v1/driver/me/vehicle').send(DETAILS).expect(200);

    const patched = await driver
      .patch('/v1/driver/me/vehicle')
      .send({ colour: null })
      .expect(200);

    expect(patched.body.colour).toBeNull();
    expect(patched.body.makeModel).toBe('Hyundai Verna');
  });

  it('rejects an empty body rather than reporting a save that changed nothing', async () => {
    const { driver } = await onboarded();
    await driver.patch('/v1/driver/me/vehicle').send({}).expect(400);
  });

  /*
   * A fuel type is one of six answers, not a sentence. Free text here would
   * mean `CNG`, `cng` and `C.N.G.` are three fuels, and a column operations
   * can only read rather than group by.
   */
  it('refuses a fuel type nobody sells', async () => {
    const { driver } = await onboarded();

    await driver.patch('/v1/driver/me/vehicle').send({ fuelType: 'Petrol' }).expect(400);
    await driver.patch('/v1/driver/me/vehicle').send({ fuelType: 'COAL' }).expect(400);
    await driver.patch('/v1/driver/me/vehicle').send({ fuelType: 'CNG' }).expect(200);
  });

  it('takes next year but not next decade, and nothing from before 1990', async () => {
    const { driver } = await onboarded();
    const nextYear = new Date().getFullYear() + 1;

    await driver.patch('/v1/driver/me/vehicle').send({ manufactureYear: nextYear }).expect(200);
    await driver
      .patch('/v1/driver/me/vehicle')
      .send({ manufactureYear: nextYear + 5 })
      .expect(400);
    await driver.patch('/v1/driver/me/vehicle').send({ manufactureYear: 1980 }).expect(400);
  });

  it('answers 404 when there is no vehicle to describe', async () => {
    const { driver } = await onboarded({ withVehicle: false });
    await driver.patch('/v1/driver/me/vehicle').send(DETAILS).expect(404);
  });
});

describe('what the driver may not change (UI-016.3)', () => {
  /*
   * The plate is the identity every document was verified against. A driver
   * who could edit it could carry an approval over to a different vehicle,
   * which is precisely the fraud AC-05.7 exists to stop — and unlike the
   * admin's own correction endpoint, there is no window in which it is safe,
   * because by the time a driver can sign in the account is already live.
   */
  it('will not take a new registration number', async () => {
    const { driver } = await onboarded();

    await driver
      .patch('/v1/driver/me/vehicle')
      .send({ registrationNumber: 'KA05MN9999' })
      .expect(400);

    expect((await driver.get('/v1/driver/me/vehicle').expect(200)).body.registrationNumber).toBe(
      PLATE,
    );
  });

  /*
   * Category is the product. An advertiser picked "Auto" or "Cab", is billed
   * against that choice and had a wrap made for it; a driver flipping it after
   * the fact changes what was sold.
   */
  it('will not take a new category', async () => {
    const { driver } = await onboarded();

    await driver.patch('/v1/driver/me/vehicle').send({ category: 'AUTO' }).expect(400);

    expect((await driver.get('/v1/driver/me/vehicle').expect(200)).body.category).toBe('CAB');
  });
});

describe('an approved vehicle stays approved (UI-016.5)', () => {
  /*
   * The decision this feature turns on.
   *
   * Demoting on a descriptive change would mean a driver who corrects the
   * spelling of their own paintwork stops earning until an operator gets round
   * to them — a punishment for accuracy, on the one screen whose entire point
   * is accuracy. It is safe only because identity is unreachable above: the
   * plate pins which vehicle this is, so no edit here can make it another one.
   */
  it('does not send the vehicle back for re-verification after an edit', async () => {
    const { driver } = await onboarded({ approved: true });

    const saved = await driver.patch('/v1/driver/me/vehicle').send(DETAILS).expect(200);

    expect(saved.body.status).toBe('approved');
    expect(saved.body.canEarn).toBe(true);
  });

  it('records both sides of the change, and the status it was made at', async () => {
    const { driver } = await onboarded({ approved: true });
    await driver.patch('/v1/driver/me/vehicle').send({ colour: 'White' }).expect(200);

    const [entry] = (await sequelize.query(
      `SELECT before, after FROM audit_log WHERE action = 'vehicle.described_by_driver'`,
      { type: 'SELECT' },
    )) as { before: Record<string, unknown>; after: Record<string, unknown> }[];

    expect(entry?.before).toMatchObject({ colour: null });
    // The status rides along so that a change made *after* approval is visible
    // as one, without joining the vehicle's status history alongside.
    expect(entry?.after).toMatchObject({ colour: 'White', vehicleStatus: 'APPROVED' });
  });
});

describe('the vehicle photo (UI-014.2)', () => {
  it('accepts an image and then serves it back', async () => {
    const { driver } = await onboarded();

    const saved = await driver
      .post('/v1/driver/me/vehicle/photo')
      .attach('file', PNG, { filename: 'car.png', contentType: 'image/png' })
      .expect(200);

    expect(saved.body.photoUrl).toBe('/v1/driver/me/vehicle/photo');

    const served = await driver.get('/v1/driver/me/vehicle/photo').expect(200);
    expect(served.headers['content-type']).toContain('image/png');
    expect(served.body).toEqual(PNG);
  });

  it('answers 404 before one has been sent, rather than an empty 200', async () => {
    const { driver } = await onboarded();

    expect((await driver.get('/v1/driver/me/vehicle').expect(200)).body.photoUrl).toBeNull();
    await driver.get('/v1/driver/me/vehicle/photo').expect(404);
  });

  it('refuses a PDF, which documents accept and a photo of a car cannot be', async () => {
    const { driver } = await onboarded();

    await driver
      .post('/v1/driver/me/vehicle/photo')
      .attach('file', Buffer.from('%PDF-1.4'), {
        filename: 'car.pdf',
        contentType: 'application/pdf',
      })
      .expect(422);
  });

  /*
   * AC-32.4 asks the operator to verify the vehicle. A photo only its owner
   * can open is a field the driver filled in for nobody.
   */
  it('is the same image the operator reviewing the vehicle sees', async () => {
    const { driver, vehicleId } = await onboarded();
    await driver
      .post('/v1/driver/me/vehicle/photo')
      .attach('file', PNG, { filename: 'car.png', contentType: 'image/png' })
      .expect(200);

    const served = await admin.get(`/v1/admin/vehicles/${vehicleId}/photo`).expect(200);
    expect(served.body).toEqual(PNG);

    // And the admin payload points at that route rather than at the storage
    // key, which no browser can do anything with.
    const detail = await admin.get(`/v1/admin/drivers/${await driverIdOf()}`).expect(200);
    expect(detail.body.vehicles[0].imageUrl).toBe(`/v1/admin/vehicles/${vehicleId}/photo`);
  });

  it('does not let one driver read another driver’s vehicle photo', async () => {
    const { driver } = await onboarded();
    await driver
      .post('/v1/driver/me/vehicle/photo')
      .attach('file', PNG, { filename: 'car.png', contentType: 'image/png' })
      .expect(200);

    const other = await onboardedSecondDriver();
    await other.get('/v1/driver/me/vehicle/photo').expect(404);
  });
});

// --- helpers ---------------------------------------------------------------

async function onboarded(
  options: { withVehicle?: boolean; approved?: boolean } = {},
): Promise<{ driver: Agent; vehicleId: string }> {
  const withVehicle = options.withVehicle ?? true;

  const created = await admin
    .post('/v1/admin/drivers')
    .send({
      ...DRIVER,
      ...(withVehicle ? { vehicle: { registrationNumber: PLATE, category: 'CAB' } } : {}),
    })
    .expect(201);

  const vehicleId = withVehicle ? String(created.body.vehicle.id) : '';

  if (options.approved) {
    for (const kind of ['RC', 'INSURANCE', 'POLLUTION', 'PERMIT']) {
      const documentId = await uploadDocument({ vehicleId, kind });
      await admin.post(`/v1/admin/documents/${documentId}/verify`).expect(200);
    }
    await admin.post(`/v1/admin/vehicles/${vehicleId}/verify-documents`).expect(200);
    await admin.post(`/v1/admin/vehicles/${vehicleId}/approve`).expect(200);
  }

  return { driver: await signInDriver(), vehicleId };
}

async function onboardedSecondDriver(): Promise<Agent> {
  const email = 'sujay.gowda@example.com';
  await admin
    .post('/v1/admin/drivers')
    .send({
      mobile: '9845099999',
      name: 'Sujay Gowda',
      email,
      vehicle: { registrationNumber: 'KA05MN1111', category: 'AUTO' },
    })
    .expect(201);

  const agent = client();
  await agent
    .post('/v1/auth/login')
    .send({ email, password: inbox.passwordFor(email) })
    .expect(200);
  return agent;
}

async function uploadDocument(input: { kind: string; vehicleId: string }): Promise<string> {
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

async function signInDriver(): Promise<Agent> {
  const agent = client();
  await agent
    .post('/v1/auth/login')
    .send({ email: DRIVER.email, password: inbox.passwordFor(DRIVER.email) })
    .expect(200);
  return agent;
}

async function driverIdOf(): Promise<string> {
  const rows = (await sequelize.query(
    `SELECT id FROM drivers WHERE mobile = '${DRIVER.mobile}'`,
    { type: 'SELECT' },
  )) as { id: string }[];

  const first = rows[0];
  if (!first) throw new Error('No driver');
  return first.id;
}
