import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';

import { type Agent, client, enrolAndVerify, signIn } from './helpers/admin';
import { captureMail, type MailInbox } from './helpers/mail';

/**
 * Assignment, installation and driver visibility (AC-22, AC-06, AC-07).
 *
 * The interesting cases are not the happy path. They are the ones that cost
 * money or trust when they slip: the same vehicle earning for two advertisers,
 * a wrap that nobody photographed going live, an installer signing off their
 * own work, and a driver being able to start tracking before any of it
 * happened.
 */

const ADVERTISER = {
  legalName: 'Zephyr Beverages Private Limited',
  brandName: 'Zephyr',
  billingEmail: 'accounts@zephyr.example',
};

const ADVERTISER_USER = { email: 'buyer@zephyr.example', fullName: 'Zephyr Buyer' };
const ADVERTISER_PASSWORD = 'advertiser-password-long-enough';

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

const CAMPAIGN = {
  name: 'Summer Sale',
  brandName: 'Zephyr',
  city: 'Bengaluru',
  vehicleType: 'CAB',
  startDate: '2026-09-01',
  endDate: '2026-09-30',
  zonePrimeKm: '4000',
  zoneSecondaryKm: '15000',
};

/** 1×1 PNG. Small enough to embed, real enough for the MIME check. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

const REASON = 'The rear panel photo shows a torn wrap along the lower edge.';

let reachable = false;
let admin: Agent;
let inbox: MailInbox;

beforeAll(async () => {
  reachable = await pingDatabase().then(
    () => true,
    () => false,
  );
  if (!reachable) {
    console.warn('\n  installation tests skipped: no database reachable at DATABASE_URL\n');
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
  advertiserAgent = null;
  await sequelize.query(
    `TRUNCATE users, user_sessions, user_invitations, audit_log, advertisers, campaigns,
     notifications, drivers, driver_consents, vehicles, campaign_vehicles, installations,
     installation_photos
     RESTART IDENTITY CASCADE`,
  );
  admin = await signIn();
});

describe('assigning a vehicle to a campaign (AC-22)', () => {
  it('turns the advertiser request into an assignment the driver can see', async () => {
    const { campaignId, vehicleId } = await approvedCampaignAndVehicle();

    const assigned = await admin
      .post(`/v1/admin/campaigns/${campaignId}/vehicles`)
      .send({ vehicleIds: [vehicleId] })
      .expect(201);

    expect(assigned.body).toHaveLength(1);
    expect(assigned.body[0]).toMatchObject({ status: 'ASSIGNED', vehicleId });
    // AC-06.1: the installation record exists from assignment, so there is
    // something for the appointment to hang off.
    expect(assigned.body[0].installation).toMatchObject({ status: 'SCHEDULED', photoCount: 0 });
  });

  /*
   * AC-22.6 and AC-16. This is the invariant a partial unique index exists to
   * protect: two advertisers billed for one kilometre is unrecoverable once
   * money has moved.
   */
  it('refuses a vehicle that is already live on another campaign', async () => {
    const { campaignId, vehicleId } = await approvedCampaignAndVehicle();
    const second = await approvedCampaign('Winter Sale');

    await admin
      .post(`/v1/admin/campaigns/${campaignId}/vehicles`)
      .send({ vehicleIds: [vehicleId] })
      .expect(201);

    const clash = await admin
      .post(`/v1/admin/campaigns/${second}/vehicles`)
      .send({ vehicleIds: [vehicleId] });

    expect(clash.status).toBe(409);
    expect(clash.body.message).toMatch(/already on another live campaign/i);
  });

  /* AC-22.2 and AC-22.3: a failing vehicle needs a stated reason, not a click. */
  it('refuses an unapproved vehicle unless a reason is given', async () => {
    const campaignId = await approvedCampaign();
    const driverId = await createDriver();
    const vehicleId = await createVehicle(driverId); // PENDING, not approved.

    const refused = await admin
      .post(`/v1/admin/campaigns/${campaignId}/vehicles`)
      .send({ vehicleIds: [vehicleId] });

    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/not approved/i);

    const override = await admin
      .post(`/v1/admin/campaigns/${campaignId}/vehicles`)
      .send({ vehicleIds: [vehicleId], overrideReason: 'Pilot vehicle, documents verified offline.' })
      .expect(201);

    expect(override.body[0].overrideReason).toMatch(/Pilot vehicle/);
  });

  it('reports assigned against installed and active, per AC-22.8', async () => {
    const { campaignId, vehicleId } = await approvedCampaignAndVehicle();
    await admin
      .post(`/v1/admin/campaigns/${campaignId}/vehicles`)
      .send({ vehicleIds: [vehicleId] })
      .expect(201);

    const list = await admin.get(`/v1/admin/campaigns/${campaignId}/vehicles`).expect(200);

    expect(list.body.summary).toMatchObject({ assigned: 1, active: 0 });
  });
});

describe('installation evidence (AC-06)', () => {
  it('will not accept a submission until every required photo is present', async () => {
    const assignmentId = await assignedVehicle();

    const early = await admin.post(`/v1/admin/assignments/${assignmentId}/submit`);
    expect(early.status).toBe(400);
    expect(early.body.message).toMatch(/missing photos/i);

    // A cab needs four faces (AC-06.4). Three is still not enough.
    for (const angle of ['FRONT', 'REAR', 'LEFT']) {
      await uploadPhoto(assignmentId, angle);
    }

    expect((await admin.post(`/v1/admin/assignments/${assignmentId}/submit`)).status).toBe(400);

    await uploadPhoto(assignmentId, 'RIGHT');
    const submitted = await admin
      .post(`/v1/admin/assignments/${assignmentId}/submit`)
      .expect(200);

    expect(submitted.body.installation).toMatchObject({ status: 'SUBMITTED', photoCount: 4 });
  });

  /*
   * AC-06.10. Everything before this point is preparation; this is the moment
   * the vehicle is allowed to earn.
   */
  it('puts the vehicle live only on approval, and takes the campaign with it', async () => {
    const { assignmentId, campaignId } = await submittedInstallation();

    const before = await admin.get(`/v1/admin/campaigns/${campaignId}`).expect(200);
    expect(before.body.status).toBe('AWAITING_INSTALLATION');

    const approver = await secondAdmin();
    const approved = await approver
      .post(`/v1/admin/assignments/${assignmentId}/approve`)
      .expect(200);

    expect(approved.body.status).toBe('ACTIVE');
    expect(approved.body.installation.status).toBe('APPROVED');

    const after = await admin.get(`/v1/admin/campaigns/${campaignId}`).expect(200);
    expect(after.body.status).toBe('ACTIVE');
  });

  /* AC-06.12. Separation of duties, refused with a sentence rather than a 500. */
  it('will not let the account that installed the wrap approve it', async () => {
    const { assignmentId } = await submittedInstallation();

    const response = await admin.post(`/v1/admin/assignments/${assignmentId}/approve`);

    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/cannot approve/i);
  });

  /* AC-06.8 and AC-06.9: rejection carries a reason and the work can be redone. */
  it('sends a rejected installation back for correction', async () => {
    const { assignmentId } = await submittedInstallation();
    const approver = await secondAdmin();

    expect((await approver.post(`/v1/admin/assignments/${assignmentId}/reject`).send({})).status).toBe(
      400,
    );

    const rejected = await approver
      .post(`/v1/admin/assignments/${assignmentId}/reject`)
      .send({ reason: REASON })
      .expect(200);

    expect(rejected.body.installation).toMatchObject({
      status: 'REJECTED',
      rejectionReason: REASON,
    });

    // Re-uploading the offending angle reopens it rather than creating a
    // second installation, and clears the stale reason.
    await uploadPhoto(assignmentId, 'REAR');
    const requeued = await admin
      .post(`/v1/admin/assignments/${assignmentId}/submit`)
      .expect(200);

    expect(requeued.body.installation).toMatchObject({
      status: 'SUBMITTED',
      photoCount: 4,
      rejectionReason: null,
    });
  });

  it('lists what is waiting on a decision', async () => {
    await submittedInstallation();

    const queue = await admin.get('/v1/admin/installations').expect(200);

    expect(queue.body.items).toHaveLength(1);
    expect(queue.body.items[0].installation.status).toBe('SUBMITTED');
  });
});

describe('what the driver sees', () => {
  it('shows nothing before a campaign is assigned', async () => {
    const driver = await signInDriver((await approvedDriverWithVehicle()).driverId);

    const campaign = await driver.get('/v1/driver/campaign').expect(200);

    expect(campaign.body).toBeNull();
  });

  /*
   * AC-22.5 requires the driver to accept before installation begins, so the
   * campaign has to be visible from assignment. Installation gates tracking,
   * not visibility.
   */
  it('shows an assigned campaign before installation, marked as such', async () => {
    const { driverId } = await assignedVehicleWithDriver();
    const driver = await signInDriver(driverId);

    const campaign = await driver.get('/v1/driver/campaign').expect(200);

    expect(campaign.body).toMatchObject({
      name: CAMPAIGN.name,
      brandName: CAMPAIGN.brandName,
      status: 'assigned',
      payoutType: 'per_km',
    });
    expect(campaign.body.installation.status).toBe('SCHEDULED');
    // AC-15: the driver's rate card is their share, not the advertiser's.
    expect(campaign.body.rateCard.zones).toEqual([
      { zone: 'prime', label: 'Prime', ratePerKm: '3.00' },
      { zone: 'secondary', label: 'Secondary', ratePerKm: '1.20' },
      { zone: 'network', label: 'Network', ratePerKm: '0.60' },
    ]);
  });

  it('moves to installation_pending once the driver accepts', async () => {
    const { driverId } = await assignedVehicleWithDriver();
    const driver = await signInDriver(driverId);

    const campaign = await driver.get('/v1/driver/campaign').expect(200);
    await driver
      .post(`/v1/driver/assignments/${String(campaign.body.assignmentId)}/accept`)
      .expect(200);

    const after = await driver.get('/v1/driver/campaign').expect(200);
    expect(after.body.status).toBe('installation_pending');

    // Accepting twice is a conflict, not a silent no-op.
    expect(
      (await driver.post(`/v1/driver/assignments/${String(campaign.body.assignmentId)}/accept`))
        .status,
    ).toBe(409);
  });

  it('reads as active once the installation is approved', async () => {
    const { assignmentId, driverId } = await submittedInstallation();
    await (await secondAdmin()).post(`/v1/admin/assignments/${assignmentId}/approve`).expect(200);

    const driver = await signInDriver(driverId);
    const campaign = await driver.get('/v1/driver/campaign').expect(200);

    expect(campaign.body.status).toBe('active');
  });
});

/*
 * AC-22.4 — the advertiser picks vehicles and operations confirms them. The
 * driver used to see nothing at all in between, which for a campaign awaiting
 * review is days of their vehicle being spoken for silently.
 */
describe('what the driver sees before operations confirms', () => {
  it('shows the campaign as soon as the advertiser picks the vehicle', async () => {
    const { driverId } = await requestedCampaignForDriver();
    const driver = await signInDriver(driverId);

    const campaign = await driver.get('/v1/driver/campaign').expect(200);

    expect(campaign.body).toMatchObject({
      name: CAMPAIGN.name,
      brandName: CAMPAIGN.brandName,
      status: 'requested',
    });
    // Nothing has been assigned, so there is nothing to accept and no
    // installation to schedule. Both must read as absent rather than empty.
    expect(campaign.body.assignmentId).toBeNull();
    expect(campaign.body.installation).toBeNull();
  });

  /*
   * The whole risk of showing a request is that it looks like a booking. It
   * must not open any of the gates a booking opens.
   */
  it('does not let a request become a tracked kilometre', async () => {
    const { driverId } = await requestedCampaignForDriver();
    const driver = await signInDriver(driverId);

    const eligibility = await driver.get('/v1/driver/eligibility').expect(200);

    expect(eligibility.body.eligible).toBe(false);
    expect(
      checksOf(eligibility.body).find((check) => check.id === 'campaign_assigned')?.passed,
    ).toBe(false);
  });

  it('prefers a confirmed assignment over another advertiser’s request', async () => {
    const { campaignId, vehicleId, driverId } = await approvedCampaignAndVehicle();

    const advertiser = await advertiserPortal();
    await advertiser
      .post('/v1/campaigns')
      .send({ ...CAMPAIGN, name: 'Winter Sale', requestedVehicleIds: [vehicleId] })
      .expect(201);

    await admin
      .post(`/v1/admin/campaigns/${campaignId}/vehicles`)
      .send({ vehicleIds: [vehicleId] })
      .expect(201);

    const driver = await signInDriver(driverId);
    const campaign = await driver.get('/v1/driver/campaign').expect(200);

    // AC-22.6 allows one live campaign per vehicle. The request must not
    // displace the wrap the driver is actually carrying.
    expect(campaign.body).toMatchObject({ name: CAMPAIGN.name, status: 'assigned' });
  });

  it('does not re-offer a campaign the driver was taken off', async () => {
    const { campaignId, vehicleId, driverId } = await requestedCampaignForDriver();
    await admin.post(`/v1/admin/campaigns/${campaignId}/approve`).expect(200);

    const assigned = await admin
      .post(`/v1/admin/campaigns/${campaignId}/vehicles`)
      .send({ vehicleIds: [vehicleId] })
      .expect(201);

    await admin
      .post(`/v1/admin/assignments/${String(assigned.body[0].id)}/unassign`)
      .send({ reason: REASON })
      .expect(200);

    const driver = await signInDriver(driverId);

    // The vehicle is still in `requestedVehicleIds`; operations removing it is
    // a decision, and reading the request again would quietly reverse it.
    expect((await driver.get('/v1/driver/campaign').expect(200)).body).toBeNull();
  });
});

/*
 * AC-34.10 — what operations can do to a campaign that is already on the road.
 *
 * `PAUSED`, `STOPPED` and `COMPLETED` sat in the status enum from the first
 * migration and every client drew a badge for them, and nothing had ever
 * written one: a campaign could be started and never stopped, and its vehicles
 * stayed booked to it for good. The cases below are the ones that cost
 * somebody money — a driver still driving for a campaign that stopped paying,
 * and a vehicle nobody else can book.
 */
describe('a campaign that is already running', () => {
  /*
   * The campaign-level shortcut, which exists because AC-06's per-vehicle
   * photo record is not the only way operations works. It needs a vehicle
   * under it: "the wraps are on the vehicles" is not a statement that can be
   * made about none.
   */
  it('goes live from the campaign once a vehicle is actually on it', async () => {
    const { campaignId, driverId } = await assignedVehicleWithDriver();

    const live = await admin.post(`/v1/admin/campaigns/${campaignId}/installed`).expect(200);
    expect(live.body.status).toBe('ACTIVE');

    // And the driver hears it, which is the whole point of the campaign
    // reaching ACTIVE at all.
    const driver = await signInDriver(driverId);
    const inbox = await driver.get('/v1/driver/notifications').expect(200);
    const titles = (inbox.body as { items: { title: string }[] }).items.map((row) => row.title);
    expect(titles[0]).toBe('Your campaign is live');
  });

  it('stops the meter without undressing the vehicle', async () => {
    const { campaignId, driverId } = await liveCampaign();

    const paused = await admin
      .post(`/v1/admin/campaigns/${campaignId}/pause`)
      .send({ reason: 'The advertiser has asked us to hold until the new creative lands.' })
      .expect(200);
    expect(paused.body.status).toBe('PAUSED');

    const driver = await signInDriver(driverId);
    // The wrap is still on and the vehicle is still theirs; only the earning
    // has stopped, which is exactly what `paused` has to convey.
    expect((await driver.get('/v1/driver/campaign').expect(200)).body.status).toBe('paused');
    expect((await driver.get('/v1/driver/eligibility').expect(200)).body.eligible).toBe(false);
  });

  it('starts it again on the same vehicles', async () => {
    const { campaignId, driverId } = await pausedCampaign();

    await admin.post(`/v1/admin/campaigns/${campaignId}/resume`).expect(200);

    const driver = await signInDriver(driverId);
    const campaign = await driver.get('/v1/driver/campaign').expect(200);
    expect(campaign.body.status).toBe('active');
    expect((await driver.get('/v1/driver/eligibility').expect(200)).body.eligible).toBe(true);
  });

  /*
   * The reason is not paperwork. It is the only thing the advertiser is told
   * about why their flight stopped, and it goes into the audit line.
   */
  it('will not pause on a shrug', async () => {
    const { campaignId } = await liveCampaign();

    await admin.post(`/v1/admin/campaigns/${campaignId}/pause`).send({ reason: 'no' }).expect(400);
    await admin.post(`/v1/admin/campaigns/${campaignId}/pause`).send({}).expect(400);
  });

  it('refuses the transitions that are not available from here', async () => {
    const { campaignId } = await liveCampaign();

    // Already running.
    await admin.post(`/v1/admin/campaigns/${campaignId}/resume`).expect(409);
    // Long past review.
    await admin.post(`/v1/admin/campaigns/${campaignId}/approve`).expect(409);

    await admin
      .post(`/v1/admin/campaigns/${campaignId}/pause`)
      .send({ reason: 'Holding while the advertiser confirms the new artwork.' })
      .expect(200);
    // Pausing twice is a conflict, not a silent no-op.
    await admin
      .post(`/v1/admin/campaigns/${campaignId}/pause`)
      .send({ reason: 'Holding while the advertiser confirms the new artwork.' })
      .expect(409);
  });

  /*
   * The one that costs real money. Availability is read from the assignment,
   * not from `vehicles.status` (AC-22.4a), so a finished campaign that leaves
   * its assignments live holds those vehicles booked to it forever and no
   * other advertiser can ever be sold them.
   */
  it('frees the vehicles when the campaign finishes', async () => {
    const { campaignId } = await liveCampaign();
    const advertiser = await advertiserPortal();

    expect((await advertiser.get('/v1/vehicles/available').expect(200)).body.items[0]).toMatchObject(
      { availability: 'booked' },
    );

    await admin.post(`/v1/admin/campaigns/${campaignId}/complete`).expect(200);

    const fleet = await advertiser.get('/v1/vehicles/available').expect(200);
    expect(fleet.body.items[0].availability).toBe('available');
    expect(fleet.body.items[0].bookedUntil).toBeUndefined();
  });

  it('frees them when it is stopped early too', async () => {
    const { campaignId } = await liveCampaign();

    await admin
      .post(`/v1/admin/campaigns/${campaignId}/stop`)
      .send({ reason: 'The advertiser has run out of wallet balance for this flight.' })
      .expect(200);

    const advertiser = await advertiserPortal();
    expect((await advertiser.get('/v1/vehicles/available').expect(200)).body.items[0]).toMatchObject(
      { availability: 'available' },
    );
  });

  /*
   * Releasing the vehicle is what would otherwise make the campaign vanish
   * from the driver's phone mid-shift, which is a poor way to find out your
   * earnings have stopped.
   */
  it('leaves the driver a closing view rather than an empty screen', async () => {
    const { campaignId, driverId } = await liveCampaign();

    await admin.post(`/v1/admin/campaigns/${campaignId}/complete`).expect(200);

    const driver = await signInDriver(driverId);
    const campaign = await driver.get('/v1/driver/campaign').expect(200);
    expect(campaign.body).toMatchObject({ name: CAMPAIGN.name, status: 'completed' });
    // And it cannot be driven for.
    expect((await driver.get('/v1/driver/eligibility').expect(200)).body.eligible).toBe(false);
  });

  it('does not dress a withdrawal up as a completion', async () => {
    const { driverId, assignmentId } = await liveCampaign();

    await admin
      .post(`/v1/admin/assignments/${assignmentId}/unassign`)
      .send({ reason: 'The driver has taken the vehicle off the road for repairs.' })
      .expect(200);

    /*
     * Unassigning a live vehicle also ends the assignment, so the closing view
     * has to look past the assignment to the campaign: this one is still
     * running for everybody else, and showing it would tell a driver who was
     * taken off that they are still on it (AC-22.7).
     */
    const driver = await signInDriver(driverId);
    expect((await driver.get('/v1/driver/campaign').expect(200)).body).toBeNull();
  });
});

/*
 * The channel itself. `notifyDriver` had been writing rows addressed to
 * `driver_id` since assignment was built, and the read side only ever queried
 * `user_id` — so every notification a driver had ever been sent was
 * unreadable, and the phone had no way at all to hear about a change the
 * driver did not cause.
 */
describe('the driver’s inbox', () => {
  interface InboxRow {
    title: string;
    body: string;
    kind: string;
    readAt: string | null;
  }

  async function inboxOf(driverId: string): Promise<{ items: InboxRow[]; unreadCount: number }> {
    const driver = await signInDriver(driverId);
    const response = await driver.get('/v1/driver/notifications').expect(200);
    return response.body as { items: InboxRow[]; unreadCount: number };
  }

  it('carries every status change operations makes', async () => {
    const { campaignId, driverId } = await liveCampaign();

    await admin
      .post(`/v1/admin/campaigns/${campaignId}/pause`)
      .send({ reason: 'Holding the flight while the advertiser tops up their wallet.' })
      .expect(200);
    await admin.post(`/v1/admin/campaigns/${campaignId}/resume`).expect(200);
    await admin.post(`/v1/admin/campaigns/${campaignId}/complete`).expect(200);

    const inbox = await inboxOf(driverId);

    // Newest first, and nothing lost in between. Print-ready is absent because
    // it happens before any vehicle is assigned, so there was no driver to
    // tell at the time.
    expect(inbox.items.map((row) => row.title)).toEqual([
      'Campaign finished',
      'Campaign is running again',
      'Campaign paused',
      'Your campaign is live',
      'New campaign assigned',
    ]);
    expect(inbox.unreadCount).toBe(5);
    expect(inbox.items[0]).toMatchObject({ kind: 'CAMPAIGN', readAt: null });
  });

  it('is the driver’s own, not the inbox of whoever else was told', async () => {
    const { campaignId, driverId } = await liveCampaign();
    await admin
      .post(`/v1/admin/campaigns/${campaignId}/pause`)
      .send({ reason: 'Holding the flight while the advertiser tops up their wallet.' })
      .expect(200);

    const bodies = (await inboxOf(driverId)).items.map((row) => row.body);

    // The advertiser is told why. The driver is told what it means for them,
    // and is not handed operations' correspondence with the customer.
    expect(bodies.some((body) => body.includes('tops up their wallet'))).toBe(false);
    expect(bodies[0]).toMatch(/kilometres are not counting/);
  });

  it('clears the badge and keeps it cleared', async () => {
    const { driverId } = await assignedVehicleWithDriver();
    const driver = await signInDriver(driverId);

    expect((await driver.get('/v1/driver/notifications').expect(200)).body.unreadCount).toBe(1);

    await driver.post('/v1/driver/notifications/read-all').expect(200);

    const after = await driver.get('/v1/driver/notifications').expect(200);
    expect(after.body.unreadCount).toBe(0);
    expect(after.body.items[0].readAt).toEqual(expect.any(String));
  });

  it('will not open a notification addressed to somebody else', async () => {
    const { driverId } = await liveCampaign();

    // Staff were notified when the campaign was submitted. The driver holds a
    // valid session, so the only thing standing between them and that row is
    // the inbox being keyed on who they are rather than on the route.
    const staffInbox = await admin.get('/v1/admin/notifications').expect(200);
    const someoneElses = String(staffInbox.body.items[0].id);

    const driver = await signInDriver(driverId);
    await driver.post(`/v1/driver/notifications/${someoneElses}/read`).expect(404);
  });
});

/*
 * AC-07. The six conditions, and the rule that every unmet one is reported
 * rather than only the first (UI-036.3) — a driver who fixes one thing and is
 * then told about the next will stop trusting the screen.
 */
describe('tracking eligibility (AC-07)', () => {
  it('blocks tracking and names every unmet condition', async () => {
    const driver = await signInDriver((await approvedDriverWithVehicle()).driverId);

    const eligibility = await driver.get('/v1/driver/eligibility').expect(200);

    expect(eligibility.body.eligible).toBe(false);
    const failed = checksOf(eligibility.body).filter((check) => !check.passed);
    expect(failed.map((check) => check.id)).toEqual([
      'campaign_assigned',
      'ad_installed',
      'installation_verified',
      'campaign_active',
    ]);
    for (const check of failed) {
      expect(check.remedy).toBeTruthy();
    }
  });

  it('still blocks tracking while the wrap is only assigned', async () => {
    const { driverId } = await assignedVehicleWithDriver();
    const driver = await signInDriver(driverId);

    const eligibility = await driver.get('/v1/driver/eligibility').expect(200);

    expect(eligibility.body.eligible).toBe(false);
    expect(byId(checksOf(eligibility.body), 'campaign_assigned').passed).toBe(true);
    expect(byId(checksOf(eligibility.body), 'installation_verified').passed).toBe(false);
  });

  it('unlocks only after the installation is approved', async () => {
    const { assignmentId, driverId } = await submittedInstallation();
    await (await secondAdmin()).post(`/v1/admin/assignments/${assignmentId}/approve`).expect(200);

    const driver = await signInDriver(driverId);
    const eligibility = await driver.get('/v1/driver/eligibility').expect(200);

    expect(eligibility.body.eligible).toBe(true);
    expect(checksOf(eligibility.body).every((check) => check.passed)).toBe(true);
  });
});

/**
 * AC-22.4c. A buyer told only "Booked" has to ring someone to find out when
 * that stops being true. The assignment holding the vehicle belongs to a
 * campaign with an end date, so the answer already exists in the system.
 */
describe('when a booked vehicle comes free', () => {
  const ZONES = {
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
   * The assignment is what makes a vehicle booked, and this is the case that
   * proves it: assignment leaves `vehicles.status` on `APPROVED`, because
   * nothing in the codebase ever writes `ASSIGNED` to it. Availability read
   * from the status alone offered this vehicle to the next advertiser as free,
   * who then had the assignment refused by the unique index behind AC-22.6.
   */
  it('reports the end date of the campaign holding it', async () => {
    const { vehicleId } = await assignedVehicleWithDriver();
    const advertiser = await advertiserPortal();

    const listed = await advertiser.post('/v1/campaigns/available-vehicles').send(ZONES).expect(200);

    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({
      availability: 'booked',
      bookedUntil: CAMPAIGN.endDate,
    });
    expect(listed.body.availableCount).toBe(0);

    const { Vehicle } = await import('../src/modules/drivers/drivers.model.js');
    const row = await Vehicle.findByPk(vehicleId);
    expect(row?.status).toBe('APPROVED');
  });

  it('says nothing about a free vehicle, which is not waiting on anything', async () => {
    await approvedDriverWithVehicle();
    const advertiser = await advertiserPortal();

    const listed = await advertiser.post('/v1/campaigns/available-vehicles').send(ZONES).expect(200);

    expect(listed.body.items[0].availability).toBe('available');
    expect(listed.body.items[0].bookedUntil).toBeUndefined();
  });

  /* The same field on the fleet browse, so the two screens cannot disagree. */
  it('answers the same on the fleet browse as in the zone picker', async () => {
    await assignedVehicleWithDriver();
    const advertiser = await advertiserPortal();

    const fleet = await advertiser.get('/v1/vehicles/available').expect(200);

    expect(fleet.body.items[0]).toMatchObject({
      availability: 'booked',
      bookedUntil: CAMPAIGN.endDate,
    });
  });

  it('tells the operator the same date it tells the buyer', async () => {
    await assignedVehicleWithDriver();

    const operator = await admin.post('/v1/admin/vehicles/in-zones').send(ZONES).expect(200);

    expect(operator.body.items[0].bookedUntil).toBe(CAMPAIGN.endDate);
  });

  /*
   * Unassigning ends the hold. The vehicle returns to the pool, and a date
   * left behind on the row would have a buyer waiting for a day that no longer
   * means anything.
   */
  it('drops the date once the vehicle is unassigned', async () => {
    const { assignmentId } = await assignedVehicleWithDriver();
    await admin
      .post(`/v1/admin/assignments/${assignmentId}/unassign`)
      .send({ reason: REASON })
      .expect(200);

    const advertiser = await advertiserPortal();
    const listed = await advertiser.post('/v1/campaigns/available-vehicles').send(ZONES).expect(200);

    expect(listed.body.items[0].bookedUntil).toBeUndefined();
    expect(listed.body.items[0].availability).not.toBe('booked');
  });
});

// --- Helpers --------------------------------------------------------------

interface Check {
  id: string;
  label: string;
  passed: boolean;
  remedy: string | null;
}

/** Supertest hands back `any`; narrow it once here rather than at every use. */
function checksOf(body: unknown): Check[] {
  return (body as { checks: Check[] }).checks;
}

function byId(checks: Check[], id: string): Check {
  const found = checks.find((check) => check.id === id);
  if (!found) throw new Error(`No eligibility check ${id}`);
  return found;
}

async function signInAdvertiser(): Promise<Agent> {
  await admin
    .post('/v1/admin/advertisers')
    .send({ ...ADVERTISER, user: ADVERTISER_USER })
    .expect(201);

  await client()
    .post(`/v1/invitations/${inbox.tokenFor(ADVERTISER_USER.email)}/accept`)
    .send({ password: ADVERTISER_PASSWORD })
    .expect(200);

  const portal = client();
  await portal
    .post('/v1/auth/login')
    .send({ email: ADVERTISER_USER.email, password: ADVERTISER_PASSWORD })
    .expect(200);

  return portal;
}

/** A campaign the admin has approved, so vehicles may be assigned to it. */
async function approvedCampaign(name = CAMPAIGN.name): Promise<string> {
  const advertiser = await advertiserPortal();
  const created = await advertiser
    .post('/v1/campaigns')
    .send({ ...CAMPAIGN, name })
    .expect(201);

  const id = String(created.body.id);
  await admin.post(`/v1/admin/campaigns/${id}/approve`).expect(200);
  await admin.post(`/v1/admin/campaigns/${id}/print-ready`).expect(200);
  return id;
}

let advertiserAgent: Agent | null = null;

/** One advertiser per test, reused across campaigns in that test. */
async function advertiserPortal(): Promise<Agent> {
  advertiserAgent ??= await signInAdvertiser();
  return advertiserAgent;
}

/**
 * A campaign whose advertiser picked this driver's vehicle, still awaiting
 * review. Deliberately not approved: this is the state the driver could not
 * see at all before.
 */
async function requestedCampaignForDriver(): Promise<{
  campaignId: string;
  vehicleId: string;
  driverId: string;
}> {
  const { driverId, vehicleId } = await approvedDriverWithVehicle();
  const advertiser = await advertiserPortal();

  const created = await advertiser
    .post('/v1/campaigns')
    .send({ ...CAMPAIGN, requestedVehicleIds: [vehicleId] })
    .expect(201);

  return { campaignId: String(created.body.id), vehicleId, driverId };
}

async function approvedCampaignAndVehicle(): Promise<{
  campaignId: string;
  vehicleId: string;
  driverId: string;
}> {
  const campaignId = await approvedCampaign();
  const { driverId, vehicleId } = await approvedDriverWithVehicle();
  return { campaignId, vehicleId, driverId };
}

async function assignedVehicle(): Promise<string> {
  return (await assignedVehicleWithDriver()).assignmentId;
}

async function assignedVehicleWithDriver(): Promise<{
  assignmentId: string;
  campaignId: string;
  driverId: string;
  vehicleId: string;
}> {
  const { campaignId, vehicleId, driverId } = await approvedCampaignAndVehicle();
  const assigned = await admin
    .post(`/v1/admin/campaigns/${campaignId}/vehicles`)
    .send({ vehicleIds: [vehicleId] })
    .expect(201);

  return { assignmentId: String(assigned.body[0].id), campaignId, driverId, vehicleId };
}

/**
 * A campaign live on a wrapped vehicle: the only state pause, stop and
 * complete can be reached from, and the state the driver is earning in.
 */
async function liveCampaign(): Promise<{
  assignmentId: string;
  campaignId: string;
  driverId: string;
  vehicleId: string;
}> {
  const context = await submittedInstallation();
  await (await secondAdmin())
    .post(`/v1/admin/assignments/${context.assignmentId}/approve`)
    .expect(200);
  return context;
}

async function pausedCampaign(): Promise<{ campaignId: string; driverId: string }> {
  const live = await liveCampaign();
  await admin
    .post(`/v1/admin/campaigns/${live.campaignId}/pause`)
    .send({ reason: 'Holding the flight while the advertiser confirms the new artwork.' })
    .expect(200);
  return live;
}

async function submittedInstallation(): Promise<{
  assignmentId: string;
  campaignId: string;
  driverId: string;
  vehicleId: string;
}> {
  const context = await assignedVehicleWithDriver();

  for (const angle of ['FRONT', 'REAR', 'LEFT', 'RIGHT']) {
    await uploadPhoto(context.assignmentId, angle);
  }
  await admin.post(`/v1/admin/assignments/${context.assignmentId}/submit`).expect(200);

  return context;
}

async function uploadPhoto(assignmentId: string, angle: string) {
  const response = await admin
    .post(`/v1/admin/assignments/${assignmentId}/photos?angle=${angle}`)
    .attach('file', PNG, { filename: `${angle.toLowerCase()}.png`, contentType: 'image/png' });

  if (response.status !== 201) {
    throw new Error(`Upload ${angle} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response;
}

/** AC-06.12 needs a second named account to do the approving. */
async function secondAdmin(): Promise<Agent> {
  const email = 'reviewer@movead.in';
  const password = 'reviewer-password-long-enough';

  await admin
    .post('/v1/admin/users')
    .send({ email, fullName: 'Install Reviewer', password, roleKey: 'SUPER_ADMIN' })
    .expect(201);

  const agent = client();
  await enrolAndVerify(agent, email, password);
  return agent;
}

async function createDriver(): Promise<string> {
  const response = await admin.post('/v1/admin/drivers').send(DRIVER).expect(201);
  return String(response.body.driver.id);
}

async function createVehicle(driverId: string): Promise<string> {
  const response = await admin
    .post(`/v1/admin/drivers/${driverId}/vehicles`)
    .send({ registrationNumber: 'KA05MN9012', category: 'CAB' })
    .expect(201);
  return String(response.body.id);
}

/** A driver and vehicle both approved, which is where AC-22 assignment starts. */
async function approvedDriverWithVehicle(): Promise<{ driverId: string; vehicleId: string }> {
  const driverId = await createDriver();
  const vehicleId = await createVehicle(driverId);

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

/**
 * Onboarding emails the driver a username and password; that is the only copy.
 *
 * Consent is granted here rather than in each case because AC-04.5 made it the
 * sixth eligibility condition, and every case in this file is about one of the
 * other five. Withholding it would make them all fail for the wrong reason.
 * The consent gate itself is proved in `driver-profile.test.ts`.
 */
async function signInDriver(_driverId: string): Promise<Agent> {
  const agent = client();
  await agent
    .post('/v1/auth/login')
    .send({ email: DRIVER.email, password: inbox.passwordFor(DRIVER.email) })
    .expect(200);
  await agent.put('/v1/driver/me/consent').send({ granted: true }).expect(200);
  return agent;
}
