import { QueryTypes } from 'sequelize';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';

import { client, signIn, type Agent } from './helpers/admin';

/**
 * Driver onboarding, end to end through HTTP (AC-04, AC-05).
 *
 * The tests are written around the invariants rather than the happy path,
 * because the happy path is not what an approval workflow gets wrong. What it
 * gets wrong is approving a vehicle whose documents nobody read, accepting a
 * rejection with no reason, or letting two drivers claim the same plate.
 */

let reachable = false;
let admin: Agent;

const DRIVER = {
  mobile: '9845012345',
  name: 'Rahul Kumar',
  email: 'rahul.kumar@example.com',
  location: {
    city: 'Bengaluru',
    label: 'MG Road, Bengaluru',
    lat: 12.9756,
    lng: 77.6069,
  },
};

const VEHICLE = {
  registrationNumber: 'KA01AB1234',
  category: 'AUTO' as const,
  bodyType: 'Auto rickshaw',
  makeModel: 'Bajaj RE',
  colour: 'Yellow',
  manufactureYear: 2021,
  fuelType: 'CNG',
};

const REASON = 'The insurance certificate expired in June. Upload the current one.';

beforeAll(async () => {
  reachable = await pingDatabase().then(
    () => true,
    () => false,
  );

  if (!reachable) {
    console.warn('\n  onboarding tests skipped: no database reachable at DATABASE_URL\n');
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

  await sequelize.query(
    'TRUNCATE users, user_sessions, user_invitations, audit_log, drivers, vehicles, vehicle_status_events, documents RESTART IDENTITY CASCADE',
  );
  admin = await signIn();
});

describe('creating a driver', () => {
  it('opens the account as PENDING so it cannot receive campaigns', async () => {
    const response = await admin.post('/v1/admin/drivers').send(DRIVER);

    expect(response.status).toBe(201);
    expect(response.body.driver.status).toBe('PENDING');
    expect(response.body.driver.mobile).toBe(DRIVER.mobile);
    expect(response.body.driver.location).toEqual(DRIVER.location);
    expect(response.body.vehicle).toBeNull();
    expect(response.body.user).toMatchObject({ email: DRIVER.email, status: 'ACTIVE' });
  });

  it('refuses a second account on the same email', async () => {
    await admin.post('/v1/admin/drivers').send(DRIVER).expect(201);

    const second = await admin.post('/v1/admin/drivers').send({
      ...DRIVER,
      mobile: '9845091111',
      name: 'Someone Else',
    });

    expect(second.status).toBe(409);
    expect(second.body.details.fields).toContain('email');
  });

  it('refuses a second account on the same mobile number', async () => {
    await admin.post('/v1/admin/drivers').send(DRIVER).expect(201);

    const second = await admin.post('/v1/admin/drivers').send({ ...DRIVER, name: 'Someone Else' });

    expect(second.status).toBe(409);
  });

  it('rejects a malformed mobile number before it reaches the database', async () => {
    const response = await admin
      .post('/v1/admin/drivers')
      .send({ ...DRIVER, mobile: '1234567890' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('validation_failed');
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await client().post('/v1/admin/drivers').send(DRIVER);

    expect(response.status).toBe(401);
  });
});

/**
 * AC-32.1: the admin opens the account from a phone call, knowing the driver's
 * name, number, vehicle type and plate. AC-04's registration list asks for
 * nothing else about the vehicle, so nothing else can be required here.
 */
describe('onboarding with only what an admin can know', () => {
  it('accepts a vehicle with just a plate and a category', async () => {
    const driverId = await createDriver();

    const response = await admin
      .post(`/v1/admin/drivers/${driverId}/vehicles`)
      .send({ registrationNumber: 'KA05MN9012', category: 'CAB' });

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('PENDING');
    expect(response.body.makeModel).toBeNull();
    expect(response.body.colour).toBeNull();
    expect(response.body.manufactureYear).toBeNull();
  });

  it('still validates the details that are supplied', async () => {
    const driverId = await createDriver();

    const response = await admin
      .post(`/v1/admin/drivers/${driverId}/vehicles`)
      .send({ ...VEHICLE, registrationNumber: 'KA05MN9012', manufactureYear: 1889 });

    expect(response.status).toBe(400);
  });

  it('still requires the plate, which is the point of creating the row', async () => {
    const driverId = await createDriver();

    const response = await admin.post(`/v1/admin/drivers/${driverId}/vehicles`).send({
      category: 'CAB',
    });

    expect(response.status).toBe(400);
  });

  it('creates the driver and the vehicle from one form submission', async () => {
    const response = await admin
      .post('/v1/admin/drivers')
      .send({ ...DRIVER, vehicle: { registrationNumber: 'ka 05 mn 9012', category: 'CAB' } });

    expect(response.status).toBe(201);
    expect(response.body.driver.status).toBe('PENDING');
    expect(response.body.vehicle).toMatchObject({
      registrationNumber: 'KA05MN9012',
      category: 'CAB',
      status: 'PENDING',
    });
  });

  /*
   * The retry test. Without a transaction the admin would fix the plate,
   * resubmit, and be told the mobile number was taken — by the record their own
   * failed attempt left behind.
   */
  it('leaves no driver behind when the plate is already taken', async () => {
    const first = await createDriver();
    await admin
      .post(`/v1/admin/drivers/${first}/vehicles`)
      .send({ registrationNumber: 'KA05MN9012', category: 'CAB' })
      .expect(201);

    const clash = await admin.post('/v1/admin/drivers').send({
      mobile: '9845099999',
      name: 'Second Driver',
      email: 'second.driver@example.com',
      vehicle: { registrationNumber: 'KA05MN9012', category: 'CAB' },
    });
    expect(clash.status).toBe(409);

    // The mobile is free, so correcting the plate and resubmitting works.
    const retry = await admin.post('/v1/admin/drivers').send({
      mobile: '9845099999',
      name: 'Second Driver',
      email: 'second.driver@example.com',
      vehicle: { registrationNumber: 'KA06MN9013', category: 'CAB' },
    });
    expect(retry.status).toBe(201);
  });
});

describe('correcting a driver', () => {
  it('changes the mobile while PENDING, because that is the typo that matters', async () => {
    const driverId = await createDriver();

    const response = await admin
      .patch(`/v1/admin/drivers/${driverId}`)
      .send({ name: 'Rahul Kumaran', mobile: '9845077777' });

    expect(response.status).toBe(200);
    expect(response.body.mobile).toBe('9845077777');
    expect(response.body.name).toBe('Rahul Kumaran');
  });

  it('refuses a mobile that another driver holds', async () => {
    const first = await createDriver();
    await createDriver({ mobile: '9845099999', name: 'Second Driver' });

    const response = await admin
      .patch(`/v1/admin/drivers/${first}`)
      .send({ mobile: '9845099999' });

    expect(response.status).toBe(409);
  });

  /*
   * Past PENDING the driver has signed in with that number. Changing it would
   * lock them out of their own account, which is not a correction.
   */
  it('locks the mobile once the driver is past PENDING', async () => {
    const driverId = await createDriver();
    await uploadDocument({ driverId, kind: 'LICENCE' });

    const response = await admin
      .patch(`/v1/admin/drivers/${driverId}`)
      .send({ mobile: '9845077777' });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('mobile_locked');

    // The name is still correctable.
    await admin.patch(`/v1/admin/drivers/${driverId}`).send({ name: 'Corrected Name' }).expect(200);
  });

  it('corrects a mistyped plate while the vehicle is PENDING', async () => {
    const vehicleId = await createVehicle();

    const response = await admin
      .patch(`/v1/admin/vehicles/${vehicleId}`)
      .send({ registrationNumber: 'ka 09 zz 8888' });

    expect(response.status).toBe(200);
    expect(response.body.registrationNumber).toBe('KA09ZZ8888');
  });

  /*
   * AC-05.7. Documents were verified against a plate; swapping it afterwards
   * would carry that approval to a different physical vehicle.
   */
  it('refuses to change the plate once documents are verified', async () => {
    const vehicleId = await verifiedVehicle();

    const response = await admin
      .patch(`/v1/admin/vehicles/${vehicleId}`)
      .send({ registrationNumber: 'KA09ZZ8888' });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('vehicle_not_editable');
  });
});

describe('removing a driver', () => {
  it('demands a reason, and keeps it on the row', async () => {
    const driverId = await createDriver();

    expect((await admin.delete(`/v1/admin/drivers/${driverId}`).send({})).status).toBe(400);

    const removed = await admin
      .delete(`/v1/admin/drivers/${driverId}`)
      .send({ reason: REASON })
      .expect(200);

    expect(removed.body.deletedReason).toBe(REASON);
  });

  it('takes them out of the queue and out of every other endpoint', async () => {
    const driverId = await createDriver();
    await admin.delete(`/v1/admin/drivers/${driverId}`).send({ reason: REASON }).expect(200);

    const list = await admin.get('/v1/admin/drivers').expect(200);
    expect(list.body.items).toHaveLength(0);

    // Not merely hidden from the list: gone as far as every route is concerned.
    expect((await admin.get(`/v1/admin/drivers/${driverId}`)).status).toBe(404);
    expect((await admin.post(`/v1/admin/drivers/${driverId}/approve`)).status).toBe(404);
    expect(
      (await admin.delete(`/v1/admin/drivers/${driverId}`).send({ reason: REASON })).status,
    ).toBe(404);
  });

  /*
   * The whole reason this archives instead of deleting: `audit_log` references
   * the driver and is append-only, so the row has to survive to be read.
   */
  it('leaves the audit trail intact and attributable', async () => {
    const driverId = await createDriver();
    await admin.delete(`/v1/admin/drivers/${driverId}`).send({ reason: REASON }).expect(200);

    const [entry] = await sequelize.query<{ actor_user_id: string | null; after: unknown }>(
      `SELECT actor_user_id, after FROM audit_log
        WHERE action = 'driver.deleted' AND entity_id = $1`,
      { bind: [driverId], type: QueryTypes.SELECT },
    );

    expect(entry?.actor_user_id).not.toBeNull();
    expect(entry?.after).toMatchObject({ reason: REASON });
  });

  it('frees the mobile and the plate for re-use', async () => {
    const driverId = await createDriver();
    await admin
      .post(`/v1/admin/drivers/${driverId}/vehicles`)
      .send({ registrationNumber: 'KA05MN9012', category: 'CAB' })
      .expect(201);

    await admin.delete(`/v1/admin/drivers/${driverId}`).send({ reason: REASON }).expect(200);

    // Re-onboarding the same real person must work. Before migration 008 the
    // archived row went on holding both, so deleting a typo burned the number.
    const again = await admin.post('/v1/admin/drivers').send({
      ...DRIVER,
      vehicle: { registrationNumber: 'KA05MN9012', category: 'CAB' },
    });

    expect(again.status).toBe(201);
  });

  it('moves their vehicles to REMOVED, with the reason on the transition', async () => {
    const driverId = await createDriver();
    const vehicle = await admin
      .post(`/v1/admin/drivers/${driverId}/vehicles`)
      .send({ registrationNumber: 'KA05MN9012', category: 'CAB' })
      .expect(201);

    await admin.delete(`/v1/admin/drivers/${driverId}`).send({ reason: REASON }).expect(200);

    const history = await admin
      .get(`/v1/admin/vehicles/${String(vehicle.body.id)}/history`)
      .expect(200);

    expect(history.body[0]).toMatchObject({ toStatus: 'REMOVED', reason: REASON });
  });
});

describe('the onboarding queue', () => {
  it('carries each driver’s vehicle, so the table needs no second request', async () => {
    const driverId = await createDriver();
    await admin
      .post(`/v1/admin/drivers/${driverId}/vehicles`)
      .send({ registrationNumber: 'ka 05 mn 9012', category: 'CAB' })
      .expect(201);

    const list = await admin.get('/v1/admin/drivers').expect(200);

    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      name: DRIVER.name,
      mobile: DRIVER.mobile,
      status: 'PENDING',
      vehicle: { registrationNumber: 'KA05MN9012', category: 'CAB', status: 'PENDING' },
    });
  });

  it('reports a driver with no vehicle yet rather than hiding them', async () => {
    await createDriver();

    const list = await admin.get('/v1/admin/drivers').expect(200);

    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].vehicle).toBeNull();
  });

  it('filters by status', async () => {
    await createDriver();

    const pending = await admin.get('/v1/admin/drivers?status=PENDING').expect(200);
    const approved = await admin.get('/v1/admin/drivers?status=APPROVED').expect(200);

    expect(pending.body.items).toHaveLength(1);
    expect(approved.body.items).toHaveLength(0);
  });
});

describe('the document checklist', () => {
  it('lists what is required and what is missing', async () => {
    const driverId = await createDriver();
    const detail = await admin.get(`/v1/admin/drivers/${driverId}`).expect(200);

    expect(detail.body.driverDocuments).toEqual([
      expect.objectContaining({ kind: 'LICENCE', status: 'missing', isMandatory: true }),
    ]);
  });

  it('moves the driver to DOCUMENTS_SUBMITTED once the whole set is in', async () => {
    // No vehicle on this driver, so the licence *is* the whole mandatory set.
    const driverId = await createDriver();
    await uploadDocument({ driverId, kind: 'LICENCE' });

    const detail = await admin.get(`/v1/admin/drivers/${driverId}`).expect(200);
    expect(detail.body.driver.status).toBe('DOCUMENTS_SUBMITTED');
    expect(detail.body.driverDocuments[0].status).toBe('uploaded');
  });

  it('leaves a driver PENDING while their vehicle papers are outstanding', async () => {
    const driverId = await createDriver();
    await admin.post(`/v1/admin/drivers/${driverId}/vehicles`).send(VEHICLE).expect(201);

    await uploadDocument({ driverId, kind: 'LICENCE' });

    // AC-04.2: "Documents submitted" has to mean submitted, all of them.
    // Flipping on the first upload fills the review queue with drivers who have
    // supplied a licence and none of the four vehicle documents.
    const detail = await admin.get(`/v1/admin/drivers/${driverId}`).expect(200);
    expect(detail.body.driver.status).toBe('PENDING');
  });

  it('supersedes rather than overwrites a resubmission, keeping the rejected copy', async () => {
    const driverId = await createDriver();
    const first = await uploadDocument({ driverId, kind: 'LICENCE' });

    await admin.post(`/v1/admin/documents/${first}/reject`).send({ reason: REASON }).expect(200);
    const second = await uploadDocument({ driverId, kind: 'LICENCE' });

    const rows = await sequelize.query<{ id: string; superseded_by: string | null }>(
      'SELECT id, superseded_by FROM documents ORDER BY created_at',
      { type: QueryTypes.SELECT },
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.superseded_by).toBe(second);
    expect(rows[1]?.superseded_by).toBeNull();
  });

  it('will not verify a document that has already expired', async () => {
    const driverId = await createDriver();
    const documentId = await uploadDocument({
      driverId,
      kind: 'LICENCE',
      expiresOn: '2020-01-01',
    });

    const response = await admin.post(`/v1/admin/documents/${documentId}/verify`);

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('expired');
  });

  it('demands a reason for a rejection', async () => {
    const driverId = await createDriver();
    const documentId = await uploadDocument({ driverId, kind: 'LICENCE' });

    const response = await admin.post(`/v1/admin/documents/${documentId}/reject`).send({});

    expect(response.status).toBe(400);
  });
});

describe('approving a driver', () => {
  it('is refused while a mandatory document is unverified', async () => {
    const driverId = await createDriver();
    await uploadDocument({ driverId, kind: 'LICENCE' });

    const response = await admin.post(`/v1/admin/drivers/${driverId}/approve`);

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('documents_outstanding');
  });

  it('succeeds once the licence is verified', async () => {
    const driverId = await createDriver();
    const documentId = await uploadDocument({ driverId, kind: 'LICENCE' });
    await admin.post(`/v1/admin/documents/${documentId}/verify`).expect(200);

    const response = await admin.post(`/v1/admin/drivers/${driverId}/approve`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('APPROVED');
  });

  it('returns a rejected driver to PENDING with the reason recorded', async () => {
    const driverId = await createDriver();
    await uploadDocument({ driverId, kind: 'LICENCE' });

    const response = await admin
      .post(`/v1/admin/drivers/${driverId}/reject`)
      .send({ reason: REASON });

    expect(response.status).toBe(200);
    // PENDING and not a terminal state: AC-05.5 gives them the right to fix it.
    expect(response.body.status).toBe('PENDING');
    expect(response.body.rejectionReason).toBe(REASON);
  });

  it('records a suspension reason, and clears it on reinstatement', async () => {
    const driverId = await approvedDriver();

    const suspended = await admin
      .post(`/v1/admin/drivers/${driverId}/suspend`)
      .send({ reason: 'Repeated no-shows for the scheduled installation appointment.' });
    expect(suspended.body.status).toBe('SUSPENDED');
    expect(suspended.body.suspendedReason).toBeTruthy();

    const reinstated = await admin.post(`/v1/admin/drivers/${driverId}/reinstate`).expect(200);
    expect(reinstated.body.status).toBe('APPROVED');
    expect(reinstated.body.suspendedReason).toBeNull();
  });
});

describe('the vehicle state machine', () => {
  it('normalises the registration and refuses a duplicate plate platform-wide', async () => {
    const first = await createDriver();
    const second = await createDriver({ mobile: '9845099999', name: 'Another Driver' });

    const created = await admin
      .post(`/v1/admin/drivers/${first}/vehicles`)
      .send({ ...VEHICLE, registrationNumber: 'ka 01 ab 1234' })
      .expect(201);
    expect(created.body.registrationNumber).toBe('KA01AB1234');

    // A plate identifies one physical vehicle, so the clash is across the
    // platform rather than within a driver (AC-05.7).
    const clash = await admin.post(`/v1/admin/drivers/${second}/vehicles`).send(VEHICLE);
    expect(clash.status).toBe(409);
  });

  it('will not approve a vehicle straight from PENDING', async () => {
    const vehicleId = await createVehicle();

    const response = await admin.post(`/v1/admin/vehicles/${vehicleId}/approve`);

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('invalid_transition');
  });

  it('will not mark documents verified while any is outstanding', async () => {
    const vehicleId = await createVehicle();

    const response = await admin.post(`/v1/admin/vehicles/${vehicleId}/verify-documents`);

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('documents_outstanding');
    expect(response.body.details.outstanding).toHaveLength(4);
  });

  it('walks PENDING to DOCUMENTS_VERIFIED to APPROVED, recording every step', async () => {
    const vehicleId = await verifiedVehicle();

    const approved = await admin.post(`/v1/admin/vehicles/${vehicleId}/approve`).expect(200);
    expect(approved.body.status).toBe('APPROVED');

    const history = await admin.get(`/v1/admin/vehicles/${vehicleId}/history`).expect(200);
    const states = (history.body as { toStatus: string }[]).map((row) => row.toStatus);
    expect(states).toEqual(['APPROVED', 'DOCUMENTS_VERIFIED', 'PENDING']);
  });

  it('demands a reason to reject, and keeps it on the record', async () => {
    const vehicleId = await createVehicle();

    expect((await admin.post(`/v1/admin/vehicles/${vehicleId}/reject`).send({})).status).toBe(400);

    const rejected = await admin
      .post(`/v1/admin/vehicles/${vehicleId}/reject`)
      .send({ reason: REASON })
      .expect(200);

    expect(rejected.body.status).toBe('REJECTED');
    expect(rejected.body.rejectionReason).toBe(REASON);
  });
});

describe('the audit trail', () => {
  it('attributes every decision to the admin who made it', async () => {
    const driverId = await approvedDriver();
    await admin.post(`/v1/admin/drivers/${driverId}/reject`).send({ reason: REASON });

    const rows = await sequelize.query<{ action: string; actor_user_id: string | null }>(
      "SELECT action, actor_user_id FROM audit_log WHERE entity_type IN ('driver','document') ORDER BY id",
      { type: QueryTypes.SELECT },
    );

    expect(rows.map((row) => row.action)).toEqual([
      'driver.created',
      'document.uploaded',
      'document.verified',
      'driver.approved',
      'driver.rejected',
    ]);
    // AC-31.5: attributable to a named individual, never to "the system".
    expect(rows.every((row) => row.actor_user_id !== null)).toBe(true);
  });
});

describe('the review queue', () => {
  it('filters by status and searches by name or mobile', async () => {
    await createDriver();
    await createDriver({ mobile: '9845099999', name: 'Priya Sharma' });

    const pending = await admin.get('/v1/admin/drivers?status=PENDING').expect(200);
    expect(pending.body.items).toHaveLength(2);

    const searched = await admin.get('/v1/admin/drivers?search=priya').expect(200);
    expect(searched.body.items).toHaveLength(1);
    expect(searched.body.items[0].name).toBe('Priya Sharma');

    const byMobile = await admin.get('/v1/admin/drivers?search=9845012345').expect(200);
    expect(byMobile.body.items[0].mobile).toBe(DRIVER.mobile);
  });
});

// ------------------------------------------------------------------- helpers

async function createDriver(driver: Partial<typeof DRIVER> = {}): Promise<string> {
  const payload = {
    ...DRIVER,
    ...driver,
    email: driver.email ?? (driver.mobile ? `${driver.mobile}@drivers.example` : DRIVER.email),
  };
  const response = await admin.post('/v1/admin/drivers').send(payload).expect(201);
  return String(response.body.driver.id);
}

async function createVehicle(): Promise<string> {
  const driverId = await createDriver();
  const response = await admin
    .post(`/v1/admin/drivers/${driverId}/vehicles`)
    .send(VEHICLE)
    .expect(201);

  return String(response.body.id);
}

/** A driver whose licence has been uploaded and verified, then approved. */
async function approvedDriver(): Promise<string> {
  const driverId = await createDriver();
  const documentId = await uploadDocument({ driverId, kind: 'LICENCE' });

  await admin.post(`/v1/admin/documents/${documentId}/verify`).expect(200);
  await admin.post(`/v1/admin/drivers/${driverId}/approve`).expect(200);

  return driverId;
}

const VEHICLE_DOCUMENTS = ['RC', 'INSURANCE', 'POLLUTION', 'PERMIT'] as const;

/** A vehicle with all four mandatory documents verified and the state moved on. */
async function verifiedVehicle(): Promise<string> {
  const vehicleId = await createVehicle();

  for (const kind of VEHICLE_DOCUMENTS) {
    const documentId = await uploadDocument({ vehicleId, kind });
    await admin.post(`/v1/admin/documents/${documentId}/verify`).expect(200);
  }

  await admin.post(`/v1/admin/vehicles/${vehicleId}/verify-documents`).expect(200);
  return vehicleId;
}

async function uploadDocument(input: {
  kind: string;
  driverId?: string;
  vehicleId?: string;
  expiresOn?: string;
}): Promise<string> {
  const response = await admin
    .post('/v1/admin/documents')
    .send({
      ...input,
      // A storage key, never a URL: the bytes went straight to object storage
      // and are served back through short-lived presigned URLs.
      storageKey: `documents/${input.kind.toLowerCase()}/${Date.now()}-${Math.random()}.jpg`,
      contentType: 'image/jpeg',
      byteSize: 204_800,
    })
    .expect(201);

  return String(response.body.id);
}
