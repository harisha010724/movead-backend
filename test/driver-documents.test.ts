import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';

import { type Agent, client, signIn } from './helpers/admin';
import { captureMail, type MailInbox } from './helpers/mail';

/**
 * AC-04.1 — the driver photographs their own paperwork and sends it.
 *
 * The point of the suite is the boundary: a driver may upload against the kinds
 * they were asked for, may read back only their own, and may not use the route
 * to reach anybody else's. The rest is the rules a phone will actually hit —
 * an unsupported type, a missing expiry, a resubmission after a rejection.
 */

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

const DRIVER = {
  mobile: '9845012345',
  name: 'Rahul Kumar',
  email: 'rahul.driver@example.com',
  location: { city: 'Bengaluru', label: 'MG Road, Bengaluru', lat: 12.9756, lng: 77.6069 },
  vehicle: { registrationNumber: 'KA01AB1234', category: 'CAB' as const },
};

const OTHER_DRIVER = {
  mobile: '9845099999',
  name: 'Suresh Reddy',
  email: 'suresh.driver@example.com',
  location: { city: 'Bengaluru', label: 'HSR Layout, Bengaluru', lat: 12.9121, lng: 77.6446 },
  vehicle: { registrationNumber: 'KA01ZZ9999', category: 'AUTO' as const },
};

/** Comfortably ahead of today, so the expiring-soon window never catches it. */
function futureDate(): string {
  return new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
}

let reachable = false;
let inbox: MailInbox;

beforeAll(async () => {
  reachable = await pingDatabase().then(
    () => true,
    () => false,
  );

  if (!reachable) {
    console.warn('\n  driver-documents tests skipped: no database reachable at DATABASE_URL\n');
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

/** Onboards a driver and signs in as them, returning their own portal agent. */
async function signedInDriver(driver = DRIVER): Promise<{ portal: Agent; admin: Agent }> {
  const admin = await signIn();
  await admin.post('/v1/admin/drivers').send(driver).expect(201);

  const portal = client();
  await portal
    .post('/v1/auth/login')
    .send({ email: driver.email, password: inbox.passwordFor(driver.email) })
    .expect(200);

  return { portal, admin };
}

/** Supertest hands back `any`; naming the shape once keeps the assertions honest. */
interface ChecklistRow {
  kind: string;
  owner: 'DRIVER' | 'VEHICLE';
  isMandatory: boolean;
  expires: boolean;
  status: string;
  documentId: string | null;
  expiresOn: string | null;
  rejectionReason: string | null;
  uploadedAt: string | null;
}

async function checklistOf(portal: Agent): Promise<ChecklistRow[]> {
  const response = await portal.get('/v1/driver/documents').expect(200);
  return response.body as ChecklistRow[];
}

/** The one driver each test creates; the table is truncated between them. */
async function driverIdOf(admin: Agent): Promise<string> {
  const response = await admin.get('/v1/admin/drivers').expect(200);
  return (response.body as { items: { id: string }[] }).items[0]!.id;
}

function upload(portal: Agent, kind: string, fields: Record<string, string> = {}) {
  const request = portal
    .post('/v1/driver/documents')
    .field('kind', kind)
    .attach('file', PNG, { filename: `${kind.toLowerCase()}.png`, contentType: 'image/png' });

  for (const [name, value] of Object.entries(fields)) request.field(name, value);
  return request;
}

describe('what the driver is asked for', () => {
  it('lists their own papers and their vehicle’s as one list', async () => {
    const { portal } = await signedInDriver();

    const items = await checklistOf(portal);

    // One wallet, not two tables: the driver photographs all five.
    expect(items.map((item) => item.kind).sort()).toEqual([
      'INSURANCE',
      'LICENCE',
      'PERMIT',
      'POLLUTION',
      'RC',
    ]);
    expect(items.every((item) => item.status === 'missing')).toBe(true);
  });

  it('says which kinds need an expiry date, so the form knows what to ask', async () => {
    const { portal } = await signedInDriver();

    const items = await checklistOf(portal);
    const byKind = Object.fromEntries(items.map((item) => [item.kind, item.expires]));

    expect(byKind.LICENCE).toBe(true);
    expect(byKind.INSURANCE).toBe(true);
    // A registration certificate does not lapse, so demanding a date would be
    // asking the driver to invent one.
    expect(byKind.RC).toBe(false);
  });
});

describe('uploading', () => {
  it('accepts a photo and marks the kind uploaded', async () => {
    const { portal } = await signedInDriver();

    const { body } = await upload(portal, 'LICENCE', { expiresOn: futureDate() }).expect(201);

    expect(body).toMatchObject({ kind: 'LICENCE', owner: 'DRIVER', status: 'uploaded' });
    expect(body.documentId).toEqual(expect.any(String));
  });

  it('files a vehicle document against the vehicle, not the driver', async () => {
    const { portal } = await signedInDriver();

    const { body } = await upload(portal, 'RC').expect(201);

    expect(body).toMatchObject({ kind: 'RC', owner: 'VEHICLE', status: 'uploaded' });
  });

  it('refuses a type that is neither a photo nor a PDF', async () => {
    const { portal } = await signedInDriver();

    const response = await portal
      .post('/v1/driver/documents')
      .field('kind', 'RC')
      .attach('file', Buffer.from('not a document'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      })
      .expect(422);

    expect(response.body.code).toBe('unsupported_type');
  });

  it('demands the expiry date on a kind that lapses', async () => {
    const { portal } = await signedInDriver();

    const response = await upload(portal, 'LICENCE').expect(422);

    expect(response.body.code).toBe('expiry_required');
  });

  it('refuses a document that has already expired', async () => {
    const { portal } = await signedInDriver();

    // AC-05.6 would refuse to verify it, so accepting the upload would leave
    // the driver waiting on a review that can only ever be refused.
    const response = await upload(portal, 'LICENCE', { expiresOn: '2020-01-01' }).expect(422);

    expect(response.body.code).toBe('already_expired');
  });

  it('does not ask for a kind that is not on the list', async () => {
    const { portal } = await signedInDriver();

    const response = await upload(portal, 'OTHER').expect(422);

    expect(response.body.code).toBe('unknown_kind');
  });

  it('needs a file, not just a kind', async () => {
    const { portal } = await signedInDriver();

    await portal.post('/v1/driver/documents').field('kind', 'RC').expect(400);
  });
});

describe('resubmitting after a rejection', () => {
  it('supersedes the rejected copy rather than overwriting it', async () => {
    const { portal, admin } = await signedInDriver();

    const first = await upload(portal, 'RC').expect(201);
    await admin
      .post(`/v1/admin/documents/${first.body.documentId}/reject`)
      .send({ reason: 'The registration number is not legible in this photo.' })
      .expect(200);

    const rejected = await checklistOf(portal);
    expect(rejected.find((item) => item.kind === 'RC')).toMatchObject({
      status: 'rejected',
      rejectionReason: 'The registration number is not legible in this photo.',
    });

    const second = await upload(portal, 'RC').expect(201);

    expect(second.body.status).toBe('uploaded');
    // A new row, so the rejected copy survives for the appeal (AC-05.5).
    expect(second.body.documentId).not.toBe(first.body.documentId);
  });
});

describe('the submission state', () => {
  it('stays PENDING until every mandatory document is in', async () => {
    const { portal, admin } = await signedInDriver();

    await upload(portal, 'LICENCE', { expiresOn: futureDate() }).expect(201);
    await upload(portal, 'RC').expect(201);

    const half = await portal.get('/v1/driver/me').expect(200);
    expect(half.body.status).toBe('pending');

    await upload(portal, 'INSURANCE', { expiresOn: futureDate() }).expect(201);
    await upload(portal, 'POLLUTION', { expiresOn: futureDate() }).expect(201);
    await upload(portal, 'PERMIT', { expiresOn: futureDate() }).expect(201);

    const full = await portal.get('/v1/driver/me').expect(200);
    expect(full.body.status).toBe('documents_submitted');

    // And the operator sees the same thing from their side.
    const drivers = await admin.get('/v1/admin/drivers?status=DOCUMENTS_SUBMITTED').expect(200);
    expect(drivers.body.items).toHaveLength(1);
  });
});

describe('reading a document back', () => {
  it('returns the bytes the driver sent', async () => {
    const { portal } = await signedInDriver();
    const uploaded = await upload(portal, 'RC').expect(201);

    const response = await portal
      .get(`/v1/driver/documents/${uploaded.body.documentId}/file`)
      .expect(200);

    expect(response.headers['content-type']).toContain('image/png');
    expect(Buffer.from(response.body)).toEqual(PNG);
  });

  it('**does not hand one driver another driver’s document**', async () => {
    const { portal: mine, admin } = await signedInDriver();
    const uploaded = await upload(mine, 'RC').expect(201);

    // A second driver, signed in on their own session.
    await admin.post('/v1/admin/drivers').send(OTHER_DRIVER).expect(201);
    const theirs = client();
    await theirs
      .post('/v1/auth/login')
      .send({ email: OTHER_DRIVER.email, password: inbox.passwordFor(OTHER_DRIVER.email) })
      .expect(200);

    // 404 rather than 403: whether that id exists is not their business.
    await theirs.get(`/v1/driver/documents/${uploaded.body.documentId}/file`).expect(404);
  });

  it('is behind the session, like every other driver read', async () => {
    await client().get('/v1/driver/documents').expect(401);
  });
});

describe('an operator reviewing it', () => {
  it('can see the file the driver sent, which is the whole point of a review', async () => {
    const { portal, admin } = await signedInDriver();
    const uploaded = await upload(portal, 'RC').expect(201);

    const response = await admin
      .get(`/v1/admin/documents/${uploaded.body.documentId}/file`)
      .expect(200);

    expect(response.headers['content-type']).toContain('image/png');
    expect(Buffer.from(response.body)).toEqual(PNG);
  });

  it('is told what kind of file it is without fetching it', async () => {
    const { portal, admin } = await signedInDriver();
    await upload(portal, 'RC').expect(201);

    const detail = await admin.get(`/v1/admin/drivers/${await driverIdOf(admin)}`).expect(200);
    const vehicleDocuments = detail.body.vehicleDocuments as Record<string, ChecklistRow[]>;
    const items = Object.values(vehicleDocuments).flat();

    // The review screen decides between an image and a PDF frame from this,
    // rather than fetching the bytes to find out.
    expect(items.find((item) => item.kind === 'RC')).toMatchObject({
      contentType: 'image/png',
      uploadedAt: expect.any(String),
    });
  });

  it('can verify what it has just looked at', async () => {
    const { portal, admin } = await signedInDriver();
    const uploaded = await upload(portal, 'LICENCE', { expiresOn: futureDate() }).expect(201);

    await admin.post(`/v1/admin/documents/${uploaded.body.documentId}/verify`).expect(200);

    const after = await checklistOf(portal);
    expect(after.find((item) => item.kind === 'LICENCE')?.status).toBe('verified');
  });

  it('says so plainly when the row is there but the bytes are not', async () => {
    const { admin } = await signedInDriver();

    // A document registered by hand, the way operations did it before drivers
    // could upload: a storage key pointing at nothing.
    const orphan = await admin
      .post('/v1/admin/documents')
      .send({
        kind: 'LICENCE',
        driverId: await driverIdOf(admin),
        storageKey: `${randomUUID()}/${randomUUID()}.jpg`,
        contentType: 'image/jpeg',
        byteSize: 1024,
      })
      .expect(201);

    await admin.get(`/v1/admin/documents/${orphan.body.id}/file`).expect(404);
  });
});
