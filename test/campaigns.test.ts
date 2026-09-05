import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';
import type { VehicleStatus } from '../src/modules/drivers/drivers.model';

import { type Agent, client, signIn } from './helpers/admin';
import { captureMail, type MailInbox } from './helpers/mail';

const ADVERTISER = {
  legalName: 'Zephyr Beverages Private Limited',
  brandName: 'Zephyr',
  billingEmail: 'accounts@zephyr.example',
};

const ADVERTISER_USER = {
  email: 'buyer@zephyr.example',
  fullName: 'Zephyr Buyer',
};

const CHOSEN_PASSWORD = 'advertiser-password-long-enough';

/** 1×1 PNG. Small enough to embed, real enough for the MIME check. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

const DRAFT = {
  name: 'Summer Sale',
  brandName: 'Zephyr',
  city: 'Bengaluru',
  vehicleType: 'CAB',
  startDate: '2026-09-01',
  endDate: '2026-09-14',
  zonePrimeKm: '4000',
  zoneSecondaryKm: '15000',
  locations: [
    {
      id: 'loc_mg_road',
      placeId: 'ChIJbU60yXAWrjsR4E9-UejD3_g',
      label: 'MG Road, Bengaluru',
      lat: 12.9756,
      lng: 77.6069,
      tier: 'prime',
    },
  ],
};

let reachable = false;
let inbox: MailInbox;

beforeAll(async () => {
  reachable = await pingDatabase().then(
    () => true,
    () => false,
  );
  if (!reachable) {
    console.warn('\n  campaign tests skipped: no database reachable at DATABASE_URL\n');
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
    'TRUNCATE users, user_sessions, user_invitations, audit_log, advertisers, campaigns, notifications, drivers, vehicles RESTART IDENTITY CASCADE',
  );
});

afterEach(() => {
  inbox?.restore();
});

async function signInAdvertiser(): Promise<Agent> {
  const admin = await signIn();
  await admin.post('/v1/admin/advertisers').send({ ...ADVERTISER, user: ADVERTISER_USER }).expect(201);
  await client()
    .post(`/v1/invitations/${inbox.tokenFor(ADVERTISER_USER.email)}/accept`)
    .send({ password: CHOSEN_PASSWORD })
    .expect(200);

  const portal = client();
  await portal
    .post('/v1/auth/login')
    .send({ email: ADVERTISER_USER.email, password: CHOSEN_PASSWORD })
    .expect(200);
  return portal;
}

describe('advertiser campaigns', () => {
  it('submits a campaign for review and lists it back', async () => {
    const portal = await signInAdvertiser();

    const created = await portal.post('/v1/campaigns').send(DRAFT).expect(201);

    expect(created.body.status).toBe('PENDING_APPROVAL');
    expect(created.body.budget).toBe('50000.00');
    expect(created.body.remaining).toBe('50000.00');
    expect(created.body.zonePrime).toBe('20000.00');
    expect(created.body.zoneSecondary).toBe('30000.00');
    expect(created.body.zoneNetwork).toBe('0.00');
    expect(created.body.zonePrimeKm).toBe('4000.0');
    expect(created.body.zoneSecondaryKm).toBe('15000.0');
    expect(created.body.locations).toEqual(DRAFT.locations);
    expect(created.body.city).toBe('Bengaluru');

    const list = await portal.get('/v1/campaigns').expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].id).toBe(created.body.id);
    expect(list.body.items[0].name).toBe('Summer Sale');
  });

  it('stores a creative under the signed-in user and attaches it on submit', async () => {
    const portal = await signInAdvertiser();

    const uploaded = await portal
      .post('/v1/campaigns/creatives')
      .attach('file', PNG, { filename: 'wrap.png', contentType: 'image/png' })
      .expect(201);

    expect(uploaded.body.storageKey).toMatch(
      /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/i,
    );

    const created = await portal
      .post('/v1/campaigns')
      .send({ ...DRAFT, creativeKey: uploaded.body.storageKey })
      .expect(201);

    expect(created.body.creativeKey).toBe(uploaded.body.storageKey);

    const file = await portal
      .get(`/v1/campaigns/creatives/${uploaded.body.storageKey}`)
      .expect(200);
    expect(file.headers['content-type']).toMatch(/png/);
  });

  it('refuses a campaign shorter than seven days', async () => {
    const portal = await signInAdvertiser();

    const response = await portal.post('/v1/campaigns').send({
      ...DRAFT,
      startDate: '2026-09-01',
      endDate: '2026-09-03',
    });

    expect(response.status).toBe(400);
  });

  it('estimates reach from the published zone rates', async () => {
    const portal = await signInAdvertiser();

    const response = await portal.post('/v1/campaigns/estimate').send({
      city: 'Bengaluru',
      vehicleType: 'CAB',
      startDate: '2026-09-01',
      endDate: '2026-09-14',
      zonePrimeKm: '4000',
      zoneSecondaryKm: '15000',
    });

    expect(response.status).toBe(200);
    expect(Number(response.body.estimatedVehicles)).toBeGreaterThan(0);
    expect(response.body.estimatedSpend).toEqual({
      prime: '20000.00',
      secondary: '30000.00',
      network: '0.00',
      total: '50000.00',
    });
    expect(response.body.estimatedKm).toEqual({
      prime: 4000,
      secondary: 15000,
      network: 0,
    });
    expect(response.body.estimatedDays).toBe(14);
  });

  it('does not let an advertiser read another advertiser\'s campaigns', async () => {
    const admin = await signIn();
    await admin
      .post('/v1/admin/advertisers')
      .send({ ...ADVERTISER, user: ADVERTISER_USER })
      .expect(201);
    await client()
      .post(`/v1/invitations/${inbox.tokenFor(ADVERTISER_USER.email)}/accept`)
      .send({ password: CHOSEN_PASSWORD })
      .expect(200);

    const first = client();
    await first
      .post('/v1/auth/login')
      .send({ email: ADVERTISER_USER.email, password: CHOSEN_PASSWORD })
      .expect(200);
    await first.post('/v1/campaigns').send(DRAFT).expect(201);

    await admin.post('/v1/admin/advertisers').send({
      legalName: 'Other Co',
      brandName: 'Other',
      billingEmail: 'billing@other.example',
      user: { email: 'buyer@other.example', fullName: 'Other Buyer' },
    }).expect(201);
    await client()
      .post(`/v1/invitations/${inbox.tokenFor('buyer@other.example')}/accept`)
      .send({ password: CHOSEN_PASSWORD })
      .expect(200);

    const second = client();
    await second
      .post('/v1/auth/login')
      .send({ email: 'buyer@other.example', password: CHOSEN_PASSWORD })
      .expect(200);

    const list = await second.get('/v1/campaigns').expect(200);
    expect(list.body.total).toBe(0);
  });

  it('lists vehicles whose onboard pin sits in Prime or Secondary, without identity', async () => {
    const admin = await signIn();
    await admin
      .post('/v1/admin/drivers')
      .send({
        mobile: '9845012345',
        name: 'Rahul Kumar',
        email: 'rahul.kumar@example.com',
        location: {
          city: 'Bengaluru',
          label: 'MG Road, Bengaluru',
          lat: 12.9756,
          lng: 77.6069,
        },
        vehicle: { registrationNumber: 'KA01AB1234', category: 'CAB' },
      })
      .expect(201);

    await admin.post('/v1/admin/advertisers').send({ ...ADVERTISER, user: ADVERTISER_USER }).expect(201);
    await client()
      .post(`/v1/invitations/${inbox.tokenFor(ADVERTISER_USER.email)}/accept`)
      .send({ password: CHOSEN_PASSWORD })
      .expect(200);

    const portal = client();
    await portal
      .post('/v1/auth/login')
      .send({ email: ADVERTISER_USER.email, password: CHOSEN_PASSWORD })
      .expect(200);

    const inside = await portal.post('/v1/campaigns/available-vehicles').send({
      vehicleType: 'CAB',
      zonePolygons: {
        prime: {
          path: [
            { lat: 12.97, lng: 77.6 },
            { lat: 12.97, lng: 77.62 },
            { lat: 12.98, lng: 77.62 },
            { lat: 12.98, lng: 77.6 },
          ],
        },
      },
    });

    expect(inside.status).toBe(200);
    expect(inside.body.items).toHaveLength(1);
    expect(inside.body.items[0].zone).toBe('prime');
    expect(inside.body.items[0].vehicleType).toBe('CAB');
    expect(inside.body.items[0].areaLabel).toBe('MG Road, Bengaluru');
    expect(inside.body.items[0].publicRef).toMatch(/^VH-/);
    // The vehicle is named to the buyer; the person driving it is not.
    expect(inside.body.items[0].registrationNumber).toBe('KA01AB1234');
    expect(inside.body.items[0].driverName).toBeUndefined();
    expect(inside.body.primeCount).toBe(1);

    // Onboarded a moment ago and not yet approved, so the advertiser can see it
    // sitting in the zone but nothing counts it as inventory they can order.
    expect(inside.body.items[0].availability).toBe('pending');
    expect(inside.body.availableCount).toBe(0);

    const created = await portal
      .post('/v1/campaigns')
      .send({
        ...DRAFT,
        zonePolygons: {
          prime: {
            path: [
              { lat: 12.97, lng: 77.6 },
              { lat: 12.97, lng: 77.62 },
              { lat: 12.98, lng: 77.62 },
              { lat: 12.98, lng: 77.6 },
            ],
          },
        },
        requestedVehicleIds: [inside.body.items[0].id],
      })
      .expect(201);

    expect(created.body.requestedVehicleIds).toEqual([inside.body.items[0].id]);
    expect(created.body.vehicleCount).toBe(1);

    const fleet = await portal.get('/v1/vehicles/available').expect(200);
    expect(fleet.body.items).toHaveLength(1);
    expect(fleet.body.items[0].publicRef).toMatch(/^VH-/);
    expect(fleet.body.items[0].areaLabel).toBe('MG Road, Bengaluru');
    expect(fleet.body.items[0].lat).toBeCloseTo(12.9756);
    expect(fleet.body.items[0].lng).toBeCloseTo(77.6069);
    expect(fleet.body.items[0].registrationNumber).toBe('KA01AB1234');
    expect(fleet.body.items[0].driverName).toBeUndefined();
    expect(fleet.body.items[0].availability).toBe('pending');
    expect(fleet.body.cabCount).toBe(1);

    const cabsOnly = await portal
      .get('/v1/vehicles/available')
      .query({ vehicleType: 'CAB' })
      .expect(200);
    expect(cabsOnly.body.items).toHaveLength(1);
    const autosOnly = await portal
      .get('/v1/vehicles/available')
      .query({ vehicleType: 'AUTO' })
      .expect(200);
    expect(autosOnly.body.items).toHaveLength(0);

    const outside = await portal.post('/v1/campaigns/available-vehicles').send({
      vehicleType: 'CAB',
      zonePolygons: {
        secondary: {
          path: [
            { lat: 13.0, lng: 77.5 },
            { lat: 13.0, lng: 77.52 },
            { lat: 13.02, lng: 77.52 },
            { lat: 13.02, lng: 77.5 },
          ],
        },
      },
    });

    expect(outside.body.items).toHaveLength(0);
  });

  it('reports each vehicle as available, booked, or pending, and reveals identity to admin only', async () => {
    const admin = await signIn();
    await admin
      .post('/v1/admin/drivers')
      .send({
        mobile: '9845012345',
        name: 'Rahul Kumar',
        email: 'rahul.kumar@example.com',
        location: { city: 'Bengaluru', label: 'MG Road, Bengaluru', lat: 12.9756, lng: 77.6069 },
        vehicle: { registrationNumber: 'KA01AB1234', category: 'CAB' },
      })
      .expect(201);

    await admin
      .post('/v1/admin/advertisers')
      .send({ ...ADVERTISER, user: ADVERTISER_USER })
      .expect(201);
    await client()
      .post(`/v1/invitations/${inbox.tokenFor(ADVERTISER_USER.email)}/accept`)
      .send({ password: CHOSEN_PASSWORD })
      .expect(200);
    const portal = client();
    await portal
      .post('/v1/auth/login')
      .send({ email: ADVERTISER_USER.email, password: CHOSEN_PASSWORD })
      .expect(200);

    const zones = {
      vehicleType: 'CAB',
      zonePolygons: {
        prime: {
          path: [
            { lat: 12.97, lng: 77.6 },
            { lat: 12.97, lng: 77.62 },
            { lat: 12.98, lng: 77.62 },
            { lat: 12.98, lng: 77.6 },
          ],
        },
      },
    };

    /*
     * Driven through the model rather than the approval routes: the state
     * machine has its own suite, and what is under test here is only how each
     * resting state is reported to a buyer.
     */
    const { Vehicle } = await import('../src/modules/drivers/drivers.model.js');
    const set = async (status: VehicleStatus) => {
      await Vehicle.update({ status }, { where: { registrationNumber: 'KA01AB1234' } });
    };

    await set('AVAILABLE');
    const free = await portal.post('/v1/campaigns/available-vehicles').send(zones).expect(200);
    expect(free.body.items[0].availability).toBe('available');
    expect(free.body.availableCount).toBe(1);

    // The onboard pin travels with the row so the picker can map it beside the
    // outline it was matched against (AC-22.4a).
    expect(free.body.items[0].lat).toBeCloseTo(12.9756);
    expect(free.body.items[0].lng).toBeCloseTo(77.6069);

    await set('ACTIVE');
    const busy = await portal.post('/v1/campaigns/available-vehicles').send(zones).expect(200);
    // Still listed: an advertiser should see the area has supply, just not free
    // supply. Only the count of orderable vehicles drops.
    expect(busy.body.items).toHaveLength(1);
    expect(busy.body.items[0].availability).toBe('booked');
    expect(busy.body.availableCount).toBe(0);

    /*
     * Booked by a status set directly, with no assignment behind it. There is
     * genuinely no campaign to read an end date from, so the field is absent
     * rather than guessed — `installations.test.ts` covers the real booking.
     */
    expect(busy.body.items[0].bookedUntil).toBeUndefined();

    /*
     * The asymmetry that survives: an advertiser is told which vehicle, an
     * operator is also told who. AC-22.4 moved the plate across that line;
     * ADV-039 keeps the name on the operations side of it.
     */
    expect(busy.body.items[0].registrationNumber).toBe('KA01AB1234');
    expect(busy.body.items[0].driverName).toBeUndefined();

    const operator = await admin.post('/v1/admin/vehicles/in-zones').send(zones).expect(200);
    expect(operator.body.items[0].availability).toBe('booked');
    expect(operator.body.items[0].registrationNumber).toBe('KA01AB1234');
    expect(operator.body.items[0].driverName).toBe('Rahul Kumar');
  });

  it('returns one campaign and lets the advertiser edit it while it is in review', async () => {
    const portal = await signInAdvertiser();
    const created = await portal.post('/v1/campaigns').send(DRAFT).expect(201);

    const read = await portal.get(`/v1/campaigns/${created.body.id}`).expect(200);
    expect(read.body.name).toBe('Summer Sale');
    expect(read.body.zonePrimeKm).toBe('4000.0');

    const updated = await portal
      .patch(`/v1/campaigns/${created.body.id}`)
      .send({ ...DRAFT, name: 'Monsoon Sale', zonePrimeKm: '5000' })
      .expect(200);

    expect(updated.body.name).toBe('Monsoon Sale');
    expect(updated.body.zonePrimeKm).toBe('5000.0');
    expect(updated.body.budget).toBe('55000.00');
    expect(updated.body.status).toBe('PENDING_APPROVAL');
  });

  it('does not let an advertiser read or edit another advertiser\'s campaign', async () => {
    const admin = await signIn();
    await admin
      .post('/v1/admin/advertisers')
      .send({ ...ADVERTISER, user: ADVERTISER_USER })
      .expect(201);
    await client()
      .post(`/v1/invitations/${inbox.tokenFor(ADVERTISER_USER.email)}/accept`)
      .send({ password: CHOSEN_PASSWORD })
      .expect(200);

    const first = client();
    await first
      .post('/v1/auth/login')
      .send({ email: ADVERTISER_USER.email, password: CHOSEN_PASSWORD })
      .expect(200);
    const created = await first.post('/v1/campaigns').send(DRAFT).expect(201);

    await admin.post('/v1/admin/advertisers').send({
      legalName: 'Other Co',
      brandName: 'Other',
      billingEmail: 'billing@other.example',
      user: { email: 'reader@other.example', fullName: 'Other Reader' },
    }).expect(201);
    await client()
      .post(`/v1/invitations/${inbox.tokenFor('reader@other.example')}/accept`)
      .send({ password: CHOSEN_PASSWORD })
      .expect(200);

    const second = client();
    await second
      .post('/v1/auth/login')
      .send({ email: 'reader@other.example', password: CHOSEN_PASSWORD })
      .expect(200);

    await second.get(`/v1/campaigns/${created.body.id}`).expect(404);
    await second.patch(`/v1/campaigns/${created.body.id}`).send(DRAFT).expect(404);
  });

  it('refuses an edit after the campaign has been approved', async () => {
    const portal = await signInAdvertiser();
    const created = await portal.post('/v1/campaigns').send(DRAFT).expect(201);

    const { Campaign } = await import('../src/modules/campaigns/campaigns.model.js');
    await Campaign.update({ status: 'APPROVED' }, { where: { id: created.body.id } });

    const response = await portal
      .patch(`/v1/campaigns/${created.body.id}`)
      .send({ ...DRAFT, name: 'Too late' });

    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/no longer be edited/i);
  });
});

describe('admin campaign review', () => {
  async function submittedCampaign(): Promise<{ admin: Agent; portal: Agent; id: string }> {
    const admin = await signIn();
    await admin.post('/v1/admin/advertisers').send({ ...ADVERTISER, user: ADVERTISER_USER }).expect(201);
    await client()
      .post(`/v1/invitations/${inbox.tokenFor(ADVERTISER_USER.email)}/accept`)
      .send({ password: CHOSEN_PASSWORD })
      .expect(200);

    const portal = client();
    await portal
      .post('/v1/auth/login')
      .send({ email: ADVERTISER_USER.email, password: CHOSEN_PASSWORD })
      .expect(200);
    const created = await portal.post('/v1/campaigns').send(DRAFT).expect(201);
    return { admin, portal, id: created.body.id };
  }

  it('lists a submitted campaign and lets operations approve it', async () => {
    const { admin, id } = await submittedCampaign();

    const queue = await admin
      .get('/v1/admin/campaigns')
      .query({ status: 'PENDING_APPROVAL' })
      .expect(200);

    expect(queue.body.total).toBe(1);
    expect(queue.body.items[0].id).toBe(id);
    expect(queue.body.items[0].advertiser.brandName).toBe('Zephyr');
    expect(queue.body.items[0].status).toBe('PENDING_APPROVAL');

    const approved = await admin.post(`/v1/admin/campaigns/${id}/approve`).expect(200);
    expect(approved.body.status).toBe('APPROVED');

    const again = await admin.post(`/v1/admin/campaigns/${id}/approve`);
    expect(again.status).toBe(409);
  });

  it('notifies the signed-in admin when an advertiser submits a campaign', async () => {
    const { admin, id } = await submittedCampaign();

    const inbox = await admin.get('/v1/admin/notifications').expect(200);
    expect(inbox.body.unreadCount).toBe(1);
    expect(inbox.body.items[0].kind).toBe('CAMPAIGN');
    expect(inbox.body.items[0].title).toMatch(/awaiting review/i);
    expect(inbox.body.items[0].href).toBe('/campaign-review');
    expect(inbox.body.items[0].body).toMatch(/Summer Sale/);

    await admin.post(`/v1/admin/notifications/${inbox.body.items[0].id}/read`).expect(200);
    const after = await admin.get('/v1/admin/notifications').expect(200);
    expect(after.body.unreadCount).toBe(0);
    expect(after.body.items[0].readAt).toBeTruthy();

    await admin.post(`/v1/admin/campaigns/${id}/approve`).expect(200);
  });

  it('notifies the advertiser when operations approve a campaign', async () => {
    const { admin, portal, id } = await submittedCampaign();

    const before = await portal.get('/v1/notifications').expect(200);
    expect(before.body.unreadCount).toBe(0);

    await admin.post(`/v1/admin/campaigns/${id}/approve`).expect(200);

    const inbox = await portal.get('/v1/notifications').expect(200);
    expect(inbox.body.unreadCount).toBe(1);
    expect(inbox.body.items[0].kind).toBe('CAMPAIGN');
    expect(inbox.body.items[0].title).toMatch(/approved/i);
    expect(inbox.body.items[0].href).toBe('/campaigns');
    expect(inbox.body.items[0].body).toMatch(/Summer Sale/);

    await portal.post(`/v1/notifications/${inbox.body.items[0].id}/read`).expect(200);
    const after = await portal.get('/v1/notifications').expect(200);
    expect(after.body.unreadCount).toBe(0);
  });

  it('notifies the advertiser when operations reject a campaign', async () => {
    const { admin, portal, id } = await submittedCampaign();

    await admin
      .post(`/v1/admin/campaigns/${id}/reject`)
      .send({ reason: 'The wrap dimensions do not match the cab template.' })
      .expect(200);

    const inbox = await portal.get('/v1/notifications').expect(200);
    expect(inbox.body.unreadCount).toBe(1);
    expect(inbox.body.items[0].title).toMatch(/not approved/i);
    expect(inbox.body.items[0].body).toMatch(/wrap dimensions/);
    expect(inbox.body.items[0].href).toBe('/campaigns');
  });

  it('moves an approved campaign to installing once print is received', async () => {
    const { admin, portal, id } = await submittedCampaign();

    await admin.post(`/v1/admin/campaigns/${id}/print-ready`).expect(409);

    await admin.post(`/v1/admin/campaigns/${id}/approve`).expect(200);
    const ready = await admin.post(`/v1/admin/campaigns/${id}/print-ready`).expect(200);
    expect(ready.body.status).toBe('AWAITING_INSTALLATION');

    const again = await admin.post(`/v1/admin/campaigns/${id}/print-ready`);
    expect(again.status).toBe(409);

    const inbox = await portal.get('/v1/notifications').expect(200);
    expect(inbox.body.items[0].title).toMatch(/ready to install/i);
    expect(inbox.body.items[0].body).toMatch(/Summer Sale/);
  });

  /*
   * The stages cannot be skipped, and the last one cannot be reached at all
   * without vehicles.
   *
   * Nothing used to check the second part, so a campaign could be walked
   * review → print → installed with none assigned and would sit there reading
   * `ACTIVE`: live on nothing, unable to bill a kilometre, while the driver
   * whose vehicle the advertiser had asked for stayed on `Requested` waiting
   * on a step that had been skipped. The advertiser's screen was the only one
   * that thought the campaign was running. Going live is proved in
   * `installations.test.ts`, where a vehicle can be assigned to it.
   */
  it('will not make a campaign live before its stages, or on no vehicles', async () => {
    const { admin, id } = await submittedCampaign();

    await admin.post(`/v1/admin/campaigns/${id}/installed`).expect(409);

    await admin.post(`/v1/admin/campaigns/${id}/approve`).expect(200);
    await admin.post(`/v1/admin/campaigns/${id}/installed`).expect(409);
    await admin.post(`/v1/admin/campaigns/${id}/print-ready`).expect(200);

    const empty = await admin.post(`/v1/admin/campaigns/${id}/installed`).expect(409);
    expect(empty.body.message).toMatch(/no vehicle is assigned/i);

    // And it stayed where it was, rather than half-moving.
    const after = await admin.get(`/v1/admin/campaigns/${id}`).expect(200);
    expect(after.body.status).toBe('AWAITING_INSTALLATION');
  });

  it('rejects a campaign in review when a reason is given', async () => {
    const { admin, id } = await submittedCampaign();

    const short = await admin.post(`/v1/admin/campaigns/${id}/reject`).send({ reason: 'No' });
    expect(short.status).toBe(400);

    const rejected = await admin
      .post(`/v1/admin/campaigns/${id}/reject`)
      .send({ reason: 'The wrap dimensions do not match the cab template.' })
      .expect(200);

    expect(rejected.body.status).toBe('CANCELLED');
  });

  it('does not let an advertiser approve through the admin route', async () => {
    const portal = await signInAdvertiser();
    const created = await portal.post('/v1/campaigns').send(DRAFT).expect(201);
    await portal.post(`/v1/admin/campaigns/${created.body.id}/approve`).expect(401);
  });
});


