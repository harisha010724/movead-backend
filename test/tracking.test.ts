import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';
import { computeMissing } from '../src/modules/impressions/impressions.service';
import { loadBaselines, recomputeBaselines } from '../src/modules/traffic/traffic.service';

import { type Agent, client, enrolAndVerify, signIn } from './helpers/admin';
import { captureMail, type MailInbox } from './helpers/mail';

/**
 * The tracking pipeline end to end (AC-07 through AC-21).
 *
 * These are the tests that stand between a GPS trace and an invoice. The happy
 * path barely matters here; what matters is that a kilometre cannot be created
 * out of nothing, cannot be paid twice, cannot be paid at all before the
 * campaign is live, and is priced by where it was actually driven rather than
 * by where the journey happened to start.
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
  location: { city: 'Bengaluru', label: 'MG Road, Bengaluru', lat: 12.9756, lng: 77.6069 },
};

/** A second driver on the same platform, for the cases about not seeing them. */
const OTHER_DRIVER = {
  mobile: '9845099887',
  name: 'Priya Nair',
  email: 'priya.nair@example.com',
  location: { city: 'Bengaluru', label: 'Indiranagar, Bengaluru', lat: 12.9784, lng: 77.6408 },
};

type DriverProfile = typeof DRIVER;

/**
 * Two boxes with a gap between them, so a straight run north crosses Prime,
 * then unzoned ground, then Secondary — every classification in one journey.
 *
 *   13.010  ┌──────────┐  Secondary
 *   12.990  └──────────┘
 *                          (Network — nothing drawn)
 *   12.980  ┌──────────┐  Prime
 *   12.970  └──────────┘
 */
const PRIME_BOX = [
  { lat: 12.97, lng: 77.6 },
  { lat: 12.97, lng: 77.62 },
  { lat: 12.98, lng: 77.62 },
  { lat: 12.98, lng: 77.6 },
];

const SECONDARY_BOX = [
  { lat: 12.99, lng: 77.6 },
  { lat: 12.99, lng: 77.62 },
  { lat: 13.01, lng: 77.62 },
  { lat: 13.01, lng: 77.6 },
];

const CAMPAIGN = {
  name: 'Summer Sale',
  brandName: 'Zephyr',
  city: 'Bengaluru',
  vehicleType: 'CAB',
  startDate: '2026-09-01',
  endDate: '2026-09-30',
  zonePrimeKm: '4000',
  zoneSecondaryKm: '15000',
  zonePolygons: { prime: { path: PRIME_BOX }, secondary: { path: SECONDARY_BOX } },
};

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

let reachable = false;
let admin: Agent;
let inbox: MailInbox;
let advertiserAgent: Agent | null = null;
let reviewerAgent: Agent | null = null;

beforeAll(async () => {
  reachable = await pingDatabase().then(
    () => true,
    () => false,
  );
  if (!reachable) {
    console.warn('\n  tracking tests skipped: no database reachable at DATABASE_URL\n');
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
  reviewerAgent = null;
  await sequelize.query(
    `TRUNCATE users, user_sessions, user_invitations, audit_log, advertisers, campaigns,
     notifications, drivers, driver_consents, vehicles, campaign_vehicles, installations,
     installation_photos, tracking_sessions, gps_points, trip_segments, segment_impressions,
     speed_baselines
     RESTART IDENTITY CASCADE`,
  );
  admin = await signIn();
});

// -------------------------------------------------------------- starting up

describe('starting a session (AC-08)', () => {
  it('refuses a driver whose campaign is not live, and says which condition failed', async () => {
    const { driverId } = await assignedButNotInstalled();
    const driver = await signInDriver(driverId);

    const refused = await driver.post('/v1/driver/tracking/session').send({}).expect(409);

    // AC-08.3: not merely "no", but which condition is in the way. A driver
    // told only that they cannot start has nothing to act on.
    expect(refused.body.message).toMatch(/Advertisement installed/);
  });

  it('starts once every condition holds, and reports zero rather than nothing', async () => {
    const driver = await drivingDriver();

    const started = await driver.post('/v1/driver/tracking/session').send({}).expect(200);

    expect(started.body).toMatchObject({
      status: 'ACTIVE',
      verifiedKm: 0,
      pendingKm: 0,
      estimatedEarnings: '0.00',
    });
    expect(started.body.startedAt).toBeTruthy();
  });

  /*
   * AC-08.6 and AC-16.6. Enforced by a partial unique index, so this holds
   * under a race as well as under a sequential retry — but a second start is
   * far more often a phone that lost the response than a driver cheating, and
   * handing back the session they already have is the reading that lets the
   * phone recover.
   */
  it('hands back the running session rather than opening a second one', async () => {
    const driver = await drivingDriver();

    const first = await driver.post('/v1/driver/tracking/session').send({}).expect(200);
    const second = await driver.post('/v1/driver/tracking/session').send({}).expect(200);

    expect(second.body.id).toBe(first.body.id);

    expect(await countOf("SELECT count(*)::int AS n FROM tracking_sessions WHERE status = 'ACTIVE'")).toBe(1);
  });

  /*
   * AC-08.7 — a session begun in a basement car park keeps the moment the
   * driver pressed start, not the moment the signal came back. AC-08.5 makes
   * that moment the billing boundary, so moving it would silently unbill
   * however long the driver spent underground.
   */
  it('keeps the local start time of a session begun offline', async () => {
    const driver = await drivingDriver();
    const startedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();

    const started = await driver.post('/v1/driver/tracking/session').send({ startedAt }).expect(200);

    expect(new Date(String(started.body.startedAt)).getTime()).toBe(new Date(startedAt).getTime());
  });

  it('will not accept a start backdated beyond a day', async () => {
    const driver = await drivingDriver();
    const startedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    const refused = await driver
      .post('/v1/driver/tracking/session')
      .send({ startedAt })
      .expect(400);

    expect(refused.body.message).toMatch(/backdated/i);
  });
});

// ---------------------------------------------------------------- measuring

describe('measuring distance (AC-10, AC-12)', () => {
  it('measures from the points and ignores what the phone claims it travelled', async () => {
    const { driver, sessionId } = await runningSession();

    // Due north 0.009° inside the Prime box: about a kilometre, in four legs.
    const result = await upload(driver, sessionId, [
      fix({ lat: 12.9715, seconds: 0 }),
      fix({ lat: 12.974, seconds: 30 }),
      fix({ lat: 12.9765, seconds: 60 }),
      // The handset insists it went 500 km. AC-10.4: nobody asked it.
      fix({ lat: 12.979, seconds: 90, deviceDistanceM: 500_000 }),
    ]);

    expect(result.body.accepted).toBe(4);
    expect(result.body.verifiedKm).toBeCloseTo(0.8, 1);
  });

  it('is reproducible — the same points always give the same distance', async () => {
    const { driver, sessionId } = await runningSession();
    const run = straightRun();

    const once = await upload(driver, sessionId, run);

    // Wipe what was derived, keep what was measured, and derive it again. This
    // is what re-examining a disputed shift months later actually looks like,
    // and AC-12.6 is what makes it worth doing: the same fixes have to give
    // the same answer, or the audit trail settles nothing.
    await sequelize.query('TRUNCATE gps_points, trip_segments CASCADE');

    const twice = await upload(driver, sessionId, run);

    expect(twice.body.verifiedKm).toBe(once.body.verifiedKm);
    expect(twice.body.duplicates).toBe(0);
  });

  it('drops the distance across a hole in the trace rather than inventing it', async () => {
    const { driver, sessionId } = await runningSession();

    const result = await upload(driver, sessionId, [
      fix({ lat: 12.9715, seconds: 0 }),
      fix({ lat: 12.972, seconds: 20 }),
      // Ten minutes of nothing — a tunnel, a dead battery, a killed app. The
      // vehicle went somewhere; joining the ends would be guessing where.
      fix({ lat: 12.9785, seconds: 620 }),
      fix({ lat: 12.979, seconds: 640 }),
    ]);

    const straight = 0.055 + 0.055; // The two measurable legs, roughly.
    expect(result.body.verifiedKm).toBeLessThan(straight + 0.05);
    // Had it bridged the gap the answer would be nearer 0.8 km.
    expect(result.body.verifiedKm).toBeLessThan(0.3);
  });
});

describe('GPS quality (AC-11)', () => {
  it('holds a stretch driven on poor accuracy instead of paying it', async () => {
    const { driver, sessionId } = await runningSession();

    const result = await upload(driver, sessionId, [
      fix({ lat: 12.9715, seconds: 0 }),
      fix({ lat: 12.974, seconds: 30, accuracyM: 65 }),
      fix({ lat: 12.9765, seconds: 60, accuracyM: 65 }),
      fix({ lat: 12.979, seconds: 90 }),
    ]);

    // AC-11.4 — held, not discarded and not paid.
    expect(result.body.pendingKm).toBeGreaterThan(0);
    expect(result.body.verifiedKm).toBeLessThan(Number(result.body.pendingKm));

    const held = await segments("state = 'PENDING_REVIEW'");
    expect(held[0]?.flag_reason).toMatch(/accuracy/i);
    // AC-18.2: whatever a reviewer eventually decides, it carries no money now.
    expect(Number(held[0]?.driver_earning)).toBe(0);
  });

  it('throws away a fix too poor to mean anything, without breaking the chain', async () => {
    const { driver, sessionId } = await runningSession();

    await upload(driver, sessionId, [
      fix({ lat: 12.9715, seconds: 0 }),
      fix({ lat: 12.9999, seconds: 30, accuracyM: 400 }),
      fix({ lat: 12.9765, seconds: 60 }),
    ]);

    // AC-11.3: the wild fix contributes no distance of its own, and AC-12.3's
    // recorded choice is to measure across it rather than lose the journey.
    const rows = await segments('true');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bridged).toBe(true);
    expect(Number(rows[0]?.distance_km)).toBeCloseTo(0.556, 2);
  });

  it('holds movement no road vehicle could have made', async () => {
    const { driver, sessionId } = await runningSession();

    const result = await upload(driver, sessionId, [
      fix({ lat: 12.9715, seconds: 0 }),
      // 8 km in 10 seconds is 2,880 km/h.
      fix({ lat: 12.9435, seconds: 10 }),
    ]);

    expect(result.body.verifiedKm).toBe(0);
    const held = await segments("state = 'PENDING_REVIEW'");
    expect(held[0]?.flag_reason).toMatch(/not plausible/i);
  });

  it('holds a trace the operating system says is faked', async () => {
    const { driver, sessionId } = await runningSession();

    await upload(driver, sessionId, [
      fix({ lat: 12.9715, seconds: 0, isMock: true }),
      fix({ lat: 12.974, seconds: 30, isMock: true }),
    ]);

    const held = await segments("state = 'PENDING_REVIEW'");
    expect(held[0]?.flag_reason).toMatch(/mock location/i);
  });
});

// ------------------------------------------------------- zones and the money

describe('zone classification and pricing (AC-13, AC-14, AC-15, AC-21)', () => {
  /*
   * The criterion the spec singles out as most likely to be got wrong. A run
   * due north from inside Prime to inside Secondary passes through unzoned
   * ground, and must come back as three priced pieces rather than one journey
   * priced by wherever it began.
   */
  it('splits a journey at the zone boundaries it crosses', async () => {
    const { driver, sessionId } = await runningSession();

    await upload(driver, sessionId, crossCity());

    const rows = await segments('true');
    expect(rows.map((row) => row.zone)).toEqual(['PRIME', 'NETWORK', 'SECONDARY']);

    // AC-21.5: the parts are the whole, not an approximation of it.
    const total = rows.reduce((sum, row) => sum + Number(row.distance_km), 0);
    expect(total).toBeCloseTo(2.78, 2);

    // 12.975 → 12.98 is Prime, 12.98 → 12.99 Network, 12.99 → 13.0 Secondary:
    // the cuts are at the polygon edges, not at either fix.
    expect(Number(rows[0]?.distance_km)).toBeCloseTo(0.556, 2);
    expect(Number(rows[1]?.distance_km)).toBeCloseTo(1.112, 2);
    expect(Number(rows[2]?.distance_km)).toBeCloseTo(1.112, 2);
  });

  it('charges each part at its own zone rate, and pays the driver 60% of it', async () => {
    const { driver, sessionId } = await runningSession();

    await upload(driver, sessionId, crossCity());

    const rows = await segments('true');
    const rates = Object.fromEntries(
      rows.map((row) => [row.zone, [row.advertiser_rate, row.driver_rate]]),
    );

    // AC-02.1 and AC-15.1, stamped onto the row at the time of travel.
    expect(rates.PRIME).toEqual(['5.0000', '3.0000']);
    expect(rates.SECONDARY).toEqual(['2.0000', '1.2000']);
    expect(rates.NETWORK).toEqual(['1.0000', '0.6000']);

    /*
     * AC-14.1 and AC-15.2: each side of the segment is distance times its own
     * rate, rounded once at ledger scale.
     *
     * The 60% share is exact in the rates and is asserted as such in
     * `rates.test.ts`. It is not asserted on the amounts here, because both
     * sides round independently to four places and the ratio of two rounded
     * figures is not the ratio of the figures — a distinction worth a paise on
     * a segment and nothing at all on an invoice.
     */
    for (const row of rows) {
      const km = Number(row.distance_km);
      expect(Number(row.advertiser_charge)).toBeCloseTo(km * Number(row.advertiser_rate), 4);
      expect(Number(row.driver_earning)).toBeCloseTo(km * Number(row.driver_rate), 4);
    }
  });

  it('rolls the segments up into the advertiser’s spend and the driver’s earnings', async () => {
    const { driver, sessionId, campaignId } = await runningSession();

    await upload(driver, sessionId, crossCity());

    // 0.556 Prime × ₹5 + 1.112 Network × ₹1 + 1.112 Secondary × ₹2 ≈ ₹6.11
    const earnings = await driver.get('/v1/driver/earnings').expect(200);
    expect(Number(earnings.body.todayEarnings)).toBeCloseTo(3.67, 1);
    expect(earnings.body.monthVerifiedKm).toBeCloseTo(2.8, 1);

    const advertiser = await advertiserPortal();
    const campaign = await advertiser.get(`/v1/campaigns/${campaignId}`).expect(200);
    expect(campaign.body.verifiedKm).toBeCloseTo(2.8, 1);
    expect(Number(campaign.body.spent)).toBeCloseTo(6.11, 1);

    // AC-00: every rupee above is a sum of rows that each name their own GPS.
    const rows = await segments('true');
    const spend = rows.reduce((sum, row) => sum + Number(row.advertiser_charge), 0);
    expect(spend).toBeCloseTo(Number(campaign.body.spent), 2);
  });
});

// --------------------------------------------------------- the hard invariants

describe('no billing before activation (AC-07)', () => {
  /*
   * AC-07.3 and AC-07.4: the conditions are checked on every batch, not
   * once when the session opened. A campaign paused at noon must stop costing
   * the advertiser at noon, not at whatever time the driver gets round to
   * pressing stop.
   */
  it('stops the meter the moment the campaign is paused mid-shift', async () => {
    const { driver, sessionId, campaignId } = await runningSession();

    const before = await upload(driver, sessionId, straightRun(0));
    expect(before.body.verifiedKm).toBeGreaterThan(0);

    await admin
      .post(`/v1/admin/campaigns/${campaignId}/pause`)
      .send({ reason: 'Holding the flight while the advertiser confirms the new artwork.' })
      .expect(200);

    const after = await upload(driver, sessionId, straightRun(600));

    // Nothing new was earned, and what was earned before the pause stands.
    expect(after.body.verifiedKm).toBe(before.body.verifiedKm);

    const parked = await segments("state = 'NON_BILLABLE'");
    expect(parked.length).toBeGreaterThan(0);
    expect(parked[0]?.flag_reason).toMatch(/Advertisement installed/);
  });

  /*
   * AC-07.6 and AC-07.7. Movement while a condition was false is recorded so
   * it can be explained, and filed where no review can release it — because
   * AC-07.7 says no override may ever make it billable, and a row sitting in
   * the review queue is exactly a row somebody can approve.
   */
  it('files ineligible movement where no reviewer can release it', async () => {
    const { driver, sessionId, campaignId } = await runningSession();

    await admin
      .post(`/v1/admin/campaigns/${campaignId}/pause`)
      .send({ reason: 'Holding the flight while the advertiser confirms the new artwork.' })
      .expect(200);

    // Poor accuracy too, which on a live campaign would mean "held for review".
    await upload(driver, sessionId, [
      fix({ lat: 12.9715, seconds: 0, accuracyM: 65 }),
      fix({ lat: 12.974, seconds: 30, accuracyM: 65 }),
    ]);

    const rows = await segments('true');
    expect(rows.map((row) => row.state)).toEqual(['NON_BILLABLE']);
    expect(Number(rows[0]?.advertiser_charge)).toBe(0);
    expect(Number(rows[0]?.driver_earning)).toBe(0);
  });
});

/*
 * AC-04.5. Consent is the sixth condition, and unlike the other five it is not
 * an operational state the platform manages — it is the driver's answer, and
 * they can change it mid-shift. Withdrawing has to bite immediately and it has
 * to cost the advertiser a vehicle, because a campaign carrying a car nobody
 * may track is a campaign quietly not delivering.
 */
describe('withdrawing tracking consent mid-shift (AC-04.5)', () => {
  it('ends the running session and takes the driver off the campaign', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, straightRun(0));

    const withdrawn = await driver
      .put('/v1/driver/me/consent')
      .send({ granted: false })
      .expect(200);

    expect(withdrawn.body).toMatchObject({
      granted: false,
      trackingStopped: true,
      campaignsReleased: 1,
    });

    // Not merely reported as stopped — actually stopped, with a reason on the
    // row so the end is explicable months later.
    const session = await row<{ status: string; end_reason: string }>(
      `SELECT status, end_reason FROM tracking_sessions WHERE id = '${sessionId}'`,
    );
    expect(session.status).toBe('ENDED');
    expect(session.end_reason).toMatch(/consent/i);

    expect(await countOf(`SELECT COUNT(*)::int AS n FROM campaign_vehicles WHERE status = 'ACTIVE'`))
      .toBe(0);
  });

  /*
   * The line between a privacy control and a punishment. Consent covered the
   * collection at the time it happened; withdrawing it is not retrospective,
   * and wiping a driver's earnings because they asked to stop being followed
   * would make the control unusable by the people who need it most.
   */
  it('leaves the kilometres already earned alone', async () => {
    const { driver, sessionId } = await runningSession();
    const earned = await upload(driver, sessionId, straightRun(0));
    expect(earned.body.verifiedKm).toBeGreaterThan(0);

    await driver.put('/v1/driver/me/consent').send({ granted: false }).expect(200);

    const earnings = await driver.get('/v1/driver/earnings').expect(200);
    expect(Number(earnings.body.availableBalance)).toBeGreaterThan(0);
    expect(earnings.body.todayVerifiedKm).toBeGreaterThan(0);
    expect(
      await countOf(`SELECT COUNT(*)::int AS n FROM trip_segments WHERE state = 'BILLABLE'`),
    ).toBeGreaterThan(0);
  });

  it('refuses to reopen a session until consent comes back', async () => {
    const { driver } = await runningSession();
    await driver.put('/v1/driver/me/consent').send({ granted: false }).expect(200);

    await driver.post('/v1/driver/tracking/session').send({}).expect(409);
  });

  it('tells the driver why their campaign disappeared', async () => {
    const { driver } = await runningSession();
    await driver.put('/v1/driver/me/consent').send({ granted: false }).expect(200);

    // Newest first, on top of the assignment and installation messages this
    // driver already collected getting to a live campaign.
    const inbox = await driver.get('/v1/driver/notifications').expect(200);
    expect(String(inbox.body.items[0].body)).toMatch(/taken off your campaign/i);
  });
});

describe('offline sync (AC-19) and double billing (AC-16)', () => {
  /*
   * The phone deletes its buffer only after a 2xx, so a response lost on the
   * way back is re-sent in full. That is the normal case, not the edge case,
   * and it must not double a driver's earnings.
   */
  it('stores and bills a replayed batch exactly once', async () => {
    const { driver, sessionId } = await runningSession();
    const batch = straightRun();

    const first = await upload(driver, sessionId, batch);
    const again = await upload(driver, sessionId, batch);

    expect(first.body.duplicates).toBe(0);
    expect(again.body.duplicates).toBe(batch.length);
    expect(again.body.verifiedKm).toBe(first.body.verifiedKm);

    expect(await countOf('SELECT count(*)::int AS n FROM gps_points')).toBe(batch.length);
  });

  it('measures the pair spanning two batches, rather than losing it at the join', async () => {
    const { driver, sessionId } = await runningSession();
    const run = straightRun();

    await upload(driver, sessionId, run.slice(0, 2));
    const joined = await upload(driver, sessionId, run.slice(2));

    /*
     * The four fixes are three legs of ~0.28 km. Split across two uploads, the
     * middle leg belongs to neither batch — segmenting each arrival in
     * isolation would silently drop it and report 0.56 km. Invisible in a
     * demo, and a third of this driver's shift in production.
     */
    expect(joined.body.verifiedKm).toBeCloseTo(0.8, 1);
    expect(joined.body.verifiedKm).toBeGreaterThan(0.7);
  });

  it('keeps the capture time, so a late upload bills against when it happened', async () => {
    const { driver, sessionId } = await runningSession();
    const captured = new Date(Date.now() - 45 * 60 * 1000);

    await upload(driver, sessionId, straightRun(0, captured));

    const rows = await segments('true');
    const drift = Math.abs(new Date(rows[0]?.started_at ?? 0).getTime() - captured.getTime());
    expect(drift).toBeLessThan(60_000);
  });
});

describe('stopping (AC-08)', () => {
  it('ends the session and keeps what was earned in it', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, straightRun());

    const stopped = await driver.delete('/v1/driver/tracking/session').send({}).expect(200);
    expect(stopped.body.status).toBe('ENDED');
    expect(stopped.body.verifiedKm).toBeGreaterThan(0);

    expect((await driver.get('/v1/driver/tracking/session').expect(200)).body).toBeNull();

    // Stopping is not a withdrawal.
    const earnings = await driver.get('/v1/driver/earnings').expect(200);
    expect(Number(earnings.body.availableBalance)).toBeGreaterThan(0);
  });

  it('lets the driver start a fresh session once the last one is closed', async () => {
    const { driver } = await runningSession();

    await driver.delete('/v1/driver/tracking/session').send({}).expect(200);
    await driver.post('/v1/driver/tracking/session').send({}).expect(200);
  });
});

// --------------------------------------------------------- reading it back

/**
 * A day of trips (AC-23).
 *
 * This is the screen a driver opens when they disagree with a figure, so the
 * cases that matter are the ones about it agreeing with itself: the day total
 * matching the history row above it, the trips matching the total, and a shift
 * landing on the day it was driven rather than the day UTC filed it under.
 */
describe('a day of trips', () => {
  it('groups the day into one trip per session, earliest first', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, straightRun());
    await driver.delete('/v1/driver/tracking/session').send({}).expect(200);

    const second = await driver.post('/v1/driver/tracking/session').send({}).expect(200);
    await upload(driver, String(second.body.id), straightRun());

    const day = await dayOf(driver, await istToday());
    const [first, next] = day.trips;

    expect(day.trips).toHaveLength(2);
    expect(day.trips.map((trip) => trip.sequence)).toEqual([1, 2]);
    expect(first?.id).toBe(sessionId);
    expect(new Date(String(first?.startedAt)).getTime()).toBeLessThan(
      new Date(String(next?.startedAt)).getTime(),
    );
  });

  /*
   * The whole point of the screen. A driver taps ₹82.40 and must not find
   * trips adding up to ₹79 — so the total is asserted against the history row
   * it was opened from, not against a figure recomputed here.
   */
  it('totals exactly what the earnings history claims for that day', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, crossCity());

    const today = await istToday();
    const earnings = await earningsOf(driver);
    const row = earnings.history.find((entry) => entry.date === today);

    const day = await dayOf(driver, today);

    expect(row).toBeTruthy();
    expect(day.totalEarnings).toBe(row?.earnings);
    expect(day.totalVerifiedKm).toBe(row?.verifiedKm);
    expect(day.totalEarnings).toBe(earnings.todayEarnings);
  });

  it('splits a trip by the zones it was actually driven through', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, crossCity());

    const day = await dayOf(driver, await istToday());
    const trip = day.trips[0];
    const parts = trip?.zoneBreakdown ?? [];

    expect(parts.map((part) => part.zone).sort()).toEqual(['network', 'prime', 'secondary']);

    const km = parts.reduce((sum, part) => sum + part.km, 0);
    expect(km).toBeCloseTo(Number(trip?.verifiedKm), 1);
  });

  /*
   * AC-11.4 and AC-18.2. The badge answers "is this final?", so a trip holding
   * anything reads as in review even though most of it cleared — and the money
   * beside it is only the part that did.
   */
  it('reads a mixed trip as in review, and shows only what cleared', async () => {
    const { driver, sessionId } = await runningSession();

    // A clean start and a ragged finish: the first pairs earn, the last are
    // held. A trace that goes bad throughout would hold everything and prove
    // nothing about the mixed case.
    await upload(driver, sessionId, [
      fix({ lat: 12.9715, seconds: 0 }),
      fix({ lat: 12.973, seconds: 30 }),
      fix({ lat: 12.9745, seconds: 60 }),
      fix({ lat: 12.976, seconds: 90, accuracyM: 65 }),
      fix({ lat: 12.9775, seconds: 120, accuracyM: 65 }),
    ]);

    const day = await dayOf(driver, await istToday());
    const trip = day.trips[0];

    expect(trip?.status).toBe('pending_review');
    expect(trip?.verifiedKm).toBeGreaterThan(0);

    // Held distance was driven but is not on the trip, and carries no money.
    const driven = (await segments('true')).reduce(
      (sum, segment) => sum + Number(segment.distance_km),
      0,
    );
    expect(trip?.verifiedKm).toBeLessThan(driven);
  });

  /*
   * The regression this feature was built on top of.
   *
   * 19:00 UTC is 00:30 the next morning in Bengaluru. Bucketing on the raw
   * timestamp files that shift under the previous date, so a driver finishing
   * at half past midnight opened today and was shown nothing. The segments are
   * moved directly rather than backdated through the pipeline, because the
   * assertion is about the SQL that buckets them and nothing else.
   */
  it('files a small-hours trip on the Indian day it was driven, not the UTC one', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, straightRun());

    await sequelize.query(
      `UPDATE trip_segments
          SET started_at = TIMESTAMPTZ '2026-03-10 19:00:00+00',
              ended_at   = TIMESTAMPTZ '2026-03-10 19:05:00+00'`,
    );

    const driven = await dayOf(driver, '2026-03-11');
    expect(driven.trips).toHaveLength(1);
    expect(driven.totalVerifiedKm).toBeGreaterThan(0);

    const utcDate = await dayOf(driver, '2026-03-10');
    expect(utcDate.trips).toEqual([]);

    // And the row the driver would have tapped to get there agrees.
    const earnings = await earningsOf(driver);
    expect(earnings.history.map((row) => row.date)).toContain('2026-03-11');
  });

  it('answers a day the driver did not work with an empty day, not an error', async () => {
    const driver = await drivingDriver();

    expect(await dayOf(driver, '2026-01-02')).toEqual({
      date: '2026-01-02',
      totalVerifiedKm: 0,
      totalEarnings: '0.00',
      trips: [],
    });
  });

  it('rejects a date that is not one', async () => {
    const driver = await drivingDriver();
    await driver.get('/v1/driver/earnings/days/yesterday').expect(400);
  });

  it('does not show one driver another driver’s trips', async () => {
    const first = await runningSession();
    await upload(first.driver, first.sessionId, crossCity());

    const second = await runningSession(OTHER_DRIVER);
    await upload(second.driver, second.sessionId, straightRun());

    const mine = await dayOf(second.driver, await istToday());

    expect(mine.trips).toHaveLength(1);
    expect(mine.trips[0]?.id).toBe(second.sessionId);
  });

  it('refuses a caller with no session at all', async () => {
    await client().get('/v1/driver/earnings/days/2026-01-02').expect(401);
  });
});

describe('a day of trips, read by operations', () => {
  it('shows an operator the same day the driver sees', async () => {
    const { driver, sessionId, driverId } = await runningSession();
    await upload(driver, sessionId, crossCity());

    const today = await istToday();
    const theirs = await dayOf(driver, today);
    const ours = await admin
      .get(`/v1/admin/drivers/${driverId}/trips`)
      .query({ date: today })
      .expect(200);

    expect(ours.body).toEqual(theirs);
  });

  /*
   * A typo must not answer with a plausible empty day. "Did this driver work
   * on Tuesday?" answered with silence is the one reply worse than an error.
   */
  it('says so when the id is not a driver', async () => {
    await admin
      .get(`/v1/admin/drivers/${randomUUID()}/trips`)
      .query({ date: '2026-01-02' })
      .expect(404);
  });

  it('is not open to the driver themselves', async () => {
    const { driver, driverId } = await runningSession();
    await driver.get(`/v1/admin/drivers/${driverId}/trips`).query({ date: '2026-01-02' }).expect(401);
  });
});

// ------------------------------------------------------------- the GPS audit

/**
 * AC-25. The screen a disputed invoice is settled on, entered the way the
 * dispute arrives: someone has a plate and a date, and wants to know what was
 * billed and why.
 */
describe('auditing a vehicle by its plate', () => {
  it('finds the day by the registration, however it was typed', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, crossCity());
    const today = await istToday();

    const day = await auditDay('ka 05-mn 9012', today);

    expect(day.vehicle.registrationNumber).toBe(PLATE);
    expect(day.trips).toHaveLength(1);
    expect(day.trips[0]?.id).toBe(sessionId);
  });

  /*
   * Exact, not a substring. `KA05MN9013` is a real second vehicle here, and an
   * audit that answers a four-digit fragment with someone else's kilometres is
   * worse than one that answers nothing.
   */
  it('will not settle for a partial plate', async () => {
    await runningSession();
    const today = await istToday();

    await auditRequest('KA05MN', today).expect(404);
    await auditRequest('KA05MN901', today).expect(404);
    await auditRequest('9012', today).expect(404);
  });

  it('says so when no vehicle carries that plate', async () => {
    await auditRequest('KA99XX0000', '2026-01-02').expect(404);
  });

  /*
   * The number the driver's own screen must never carry. Both sides of the
   * kilometre in one response is the entire reason this endpoint is separate
   * from the one the phone calls.
   */
  it('shows what the advertiser paid beside what the driver earned', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, crossCity());

    const day = await auditDay(PLATE, await istToday());

    expect(Number(day.totalCharge)).toBeGreaterThan(Number(day.totalEarnings));
    expect(Number(day.totalEarnings)).toBeGreaterThan(0);

    // And the driver's view of the same day still does not mention it.
    const theirs = await dayOf(driver, await istToday());
    expect(theirs).not.toHaveProperty('totalCharge');
  });

  it('keeps one vehicle’s day clear of another’s trips', async () => {
    const first = await runningSession();
    await upload(first.driver, first.sessionId, crossCity());

    const second = await runningSession(OTHER_DRIVER);
    await upload(second.driver, second.sessionId, straightRun());

    const day = await auditDay(PLATES[OTHER_DRIVER.email] ?? '', await istToday());

    expect(day.trips).toHaveLength(1);
    expect(day.trips[0]?.id).toBe(second.sessionId);
  });

  it('answers a day the vehicle did not work with an empty day', async () => {
    await runningSession();
    const day = await auditDay(PLATE, '2026-01-02');

    expect(day.trips).toEqual([]);
    expect(day.totalVerifiedKm).toBe(0);
    // Ledger scale, as every advertiser-side figure on the platform is.
    expect(day.totalCharge).toBe('0.0000');
  });

  it('is not open to a driver, or to an advertiser', async () => {
    const { driver } = await runningSession();
    await driver.get('/v1/admin/gps-audit/trips').query({ vehicleNumber: PLATE, date: '2026-01-02' }).expect(401);

    const advertiser = await advertiserPortal();
    await advertiser
      .get('/v1/admin/gps-audit/trips')
      .query({ vehicleNumber: PLATE, date: '2026-01-02' })
      .expect(401);
  });

  /*
   * `trip.audit` has been in the catalogue since the first migration with
   * nothing behind it. This is the test that it is now load-bearing rather
   * than decorative — revoked, the route has to close.
   */
  it('is closed to an operator without the audit permission', async () => {
    await withoutPermission('trip.audit', async () => {
      await auditRequest(PLATE, '2026-01-02').expect(403);
    });

    // Restored, so the failure above was the grant and not something else.
    await auditRequest(PLATE, '2026-01-02').expect(404);
  });
});

describe('opening up one trip', () => {
  /*
   * The payoff of AC-21.8, and the reason this endpoint returns geometry at
   * all. `crossCity` is a single pair of fixes running north through Prime,
   * unzoned ground and Secondary — one journey the pricing pipeline cut into
   * three. Drawn as one line it would be a lie about where the money came
   * from; drawn as three it is the answer to the dispute.
   */
  it('splits the line at every zone it crossed', async () => {
    const trip = await drivenAcrossTheCity();

    expect(trip.legs.map((leg) => leg.zone)).toEqual(['prime', 'network', 'secondary']);
    expect(trip.legs.map((leg) => leg.state)).toEqual(Array(3).fill('BILLABLE'));
  });

  /*
   * The clipped coordinates are not stored — a split pair keeps one pair of
   * fixes and a distance per part — so the crossings are reconstructed by
   * walking that straight line. The run is due north at a fixed longitude
   * through boxes that end at 12.98 and 12.99, so the reconstruction is
   * checkable against the boundaries themselves rather than against itself.
   */
  it('puts the boundary crossings where the boundaries actually are', async () => {
    const [prime, network, secondary] = (await drivenAcrossTheCity()).legs;

    expect(prime?.path.at(0)?.lat).toBeCloseTo(12.975, 4);
    expect(prime?.path.at(-1)?.lat).toBeCloseTo(12.98, 4);

    expect(network?.path.at(0)?.lat).toBeCloseTo(12.98, 4);
    expect(network?.path.at(-1)?.lat).toBeCloseTo(12.99, 4);

    expect(secondary?.path.at(0)?.lat).toBeCloseTo(12.99, 4);
    expect(secondary?.path.at(-1)?.lat).toBeCloseTo(13.0, 4);
  });

  it('carries the rate and the money that each stretch produced', async () => {
    const trip = await drivenAcrossTheCity();
    const [prime, network] = trip.legs;

    // AC-14: Prime is worth more than unzoned ground, which is the whole
    // reason the split matters to anybody.
    expect(Number(prime?.advertiserRate)).toBeGreaterThan(Number(network?.advertiserRate));
    expect(Number(prime?.driverRate)).toBeLessThan(Number(prime?.advertiserRate));

    const charged = trip.legs.reduce((total, leg) => total + Number(leg.advertiserCharge), 0);
    expect(charged).toBeCloseTo(Number(trip.advertiserCharge), 2);

    const driven = trip.legs.reduce((total, leg) => total + leg.distanceKm, 0);
    expect(driven).toBeCloseTo(trip.distanceKm, 1);
  });

  /*
   * A run is a claim about the journey, not a row per GPS pair. Four fixes up
   * one box is three pairs saying the same thing, and an auditor asked to read
   * three identical rows has been given work instead of an answer.
   */
  it('merges consecutive segments that say the same thing', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, straightRun());

    const trip = await auditTrip(sessionId);
    const [only] = trip.legs;

    expect(trip.legs).toHaveLength(1);
    expect(only?.zone).toBe('prime');
    expect(only?.segments).toBe(3);
    expect(only?.path).toHaveLength(4);
  });

  /*
   * Held distance is the thing under dispute, so it must stay separate from
   * the cleared distance beside it rather than being merged into one run.
   */
  it('keeps held distance apart from what cleared, with the reason', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, [
      fix({ lat: 12.9715, seconds: 0 }),
      fix({ lat: 12.973, seconds: 30 }),
      fix({ lat: 12.9745, seconds: 60, accuracyM: 65 }),
      fix({ lat: 12.976, seconds: 90, accuracyM: 65 }),
    ]);

    const trip = await auditTrip(sessionId);
    const held = trip.legs.filter((leg) => leg.state === 'PENDING_REVIEW');

    expect(trip.legs.length).toBeGreaterThan(1);
    expect(held.length).toBeGreaterThan(0);
    expect(held[0]?.flagReason).toBeTruthy();
    expect(held.every((leg) => Number(leg.driverEarning) === 0)).toBe(true);
  });

  it('names the vehicle, the campaign and the driver it belongs to', async () => {
    const trip = await drivenAcrossTheCity();

    expect(trip.vehicleRegistration).toBe(PLATE);
    expect(trip.campaignName).toBe(CAMPAIGN.name);
    expect(trip.driverName).toBe(DRIVER.name);
  });

  it('says so when the trip does not exist', async () => {
    await admin.get(`/v1/admin/gps-audit/trips/${randomUUID()}`).expect(404);
  });

  it('is closed to an operator without the audit permission', async () => {
    const { sessionId } = await runningSession();
    await withoutPermission('trip.audit', async () => {
      await admin.get(`/v1/admin/gps-audit/trips/${sessionId}`).expect(403);
    });
  });
});

describe('the driver looking at their own trip (AC-24)', () => {
  it('draws the same line the audit screen does, split by zone', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, crossCity());

    const [mine, audited] = await Promise.all([
      ownTrip(driver, sessionId),
      auditTrip(sessionId),
    ]);

    expect(mine.legs.map((leg) => leg.zone)).toEqual(['prime', 'network', 'secondary']);
    expect(mine.legs.map((leg) => leg.path)).toEqual(audited.legs.map((leg) => leg.path));
  });

  /*
   * The whole point of the separate endpoint. An operator settling a dispute
   * sees both sides of the money; the driver sees their own. A field added to
   * the audit leg later must not reach a phone, so this asserts on the shape
   * rather than on three named absences.
   */
  it('tells the driver nothing about what the advertiser was charged', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, crossCity());

    const trip = await ownTrip(driver, sessionId);
    const leaked = Object.keys(trip.legs[0] ?? {}).filter((key) =>
      key.toLowerCase().includes('advertiser'),
    );

    expect(leaked).toEqual([]);
    expect(Object.keys(trip)).not.toContain('advertiserCharge');
  });

  it('totals to the same trip the day list showed', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, straightRun());

    const day = await dayOf(driver, await istToday());
    const listed = day.trips.find((trip) => trip.id === sessionId);
    const opened = await ownTrip(driver, sessionId);

    expect(opened.verifiedKm).toBe(listed?.verifiedKm);
    expect(opened.earnings).toBe(listed?.earnings);
    expect(opened.status).toBe(listed?.status);
  });

  /*
   * A driver whose map shows further than their paid distance is owed the
   * difference and the reason for it, so held ground is returned and marked
   * rather than dropped from the line.
   */
  it('shows held ground on the map, earning nothing, with the reason', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, [
      fix({ lat: 12.9715, seconds: 0 }),
      fix({ lat: 12.973, seconds: 30 }),
      fix({ lat: 12.9745, seconds: 60, accuracyM: 65 }),
      fix({ lat: 12.976, seconds: 90, accuracyM: 65 }),
    ]);

    const trip = await ownTrip(driver, sessionId);
    const held = trip.legs.filter((leg) => leg.state === 'PENDING_REVIEW');

    expect(held.length).toBeGreaterThan(0);
    expect(held[0]?.flagReason).toBeTruthy();
    expect(held.every((leg) => Number(leg.earnings) === 0)).toBe(true);

    const drawn = trip.legs.reduce((total, leg) => total + leg.distanceKm, 0);
    expect(drawn).toBeGreaterThan(trip.verifiedKm);
  });

  /*
   * The one that matters. Two drivers, and the second asks for the first's
   * session id — which they could only have guessed, but guessing must not be
   * rewarded either.
   */
  it("will not open another driver's trip", async () => {
    const mine = await runningSession();
    await upload(mine.driver, mine.sessionId, straightRun());
    const stranger = await runningSession(OTHER_DRIVER);

    await stranger.driver.get(`/v1/driver/trips/${mine.sessionId}`).expect(404);
  });

  it('answers a trip that does not exist the same way', async () => {
    const driver = await drivingDriver();
    await driver.get(`/v1/driver/trips/${randomUUID()}`).expect(404);
  });

  it('refuses an id that is not one', async () => {
    const driver = await drivingDriver();
    await driver.get('/v1/driver/trips/not-a-uuid').expect(400);
  });

  it('is closed to a caller who is not signed in', async () => {
    const { sessionId } = await runningSession();
    await client().get(`/v1/driver/trips/${sessionId}`).expect(401);
  });
});

/**
 * The feed behind the earnings history.
 *
 * The history used to be a list of dates, and a driver looking for a drive
 * they remembered had to guess which date it was under. This lists the drives
 * themselves, which is what they were looking for.
 *
 * It sums the same segments as the day list, so the cases that matter are
 * again the ones about it agreeing with itself — plus the two the day list
 * never had to answer: what happens to a trip that earned nothing, and what
 * happens when the feed is longer than one page.
 */
describe('the trip feed behind the earnings history', () => {
  it('names each trip by the campaign it was carrying', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, straightRun());

    const { trips } = await feed(driver);

    expect(trips).toHaveLength(1);
    expect(trips[0]?.id).toBe(sessionId);
    expect(trips[0]?.campaignName).toBe(CAMPAIGN.name);
  });

  it('puts the most recent trip first', async () => {
    const { driver } = await runningSession();
    const [older, newer] = await twoTrips(driver);

    const { trips } = await feed(driver);

    expect(trips.map((trip) => trip.id)).toEqual([newer, older]);
  });

  /*
   * The figure in the feed and the figure in the day list are the same money
   * read two ways, so a driver who opens one after the other must not find
   * them disagreeing about a trip they both name.
   */
  it('agrees with the day list about the same trip', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, crossCity());

    const day = await dayOf(driver, await istToday());
    const listed = day.trips.find((trip) => trip.id === sessionId);
    const fed = (await feed(driver)).trips.find((trip) => trip.id === sessionId);

    expect(fed?.verifiedKm).toBe(listed?.verifiedKm);
    expect(fed?.earnings).toBe(listed?.earnings);
    expect(fed?.status).toBe(listed?.status);
  });

  /*
   * A shift that is still being checked is a shift the driver drove. Dropping
   * it until it clears is how someone comes to believe the app lost a morning,
   * so it is listed, marked, and paying nothing yet.
   */
  it('keeps a trip that is still under review, earning nothing yet', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, underReview());

    const { trips } = await feed(driver);

    expect(trips.map((trip) => trip.id)).toContain(sessionId);
    expect(trips[0]?.status).toBe('pending_review');
    expect(trips[0]?.verifiedKm).toBe(0);
    expect(Number(trips[0]?.earnings)).toBe(0);
  });

  /*
   * Paged on the trip's own start time, not an offset. The feed grows at the
   * top while it is being scrolled, and an offset would hand the phone the
   * same trip twice the moment a new one landed between two pages.
   */
  it('pages on the trip start time, without repeating a trip', async () => {
    const { driver } = await runningSession();
    const [older, newer] = await twoTrips(driver);

    const first = await feed(driver, { limit: 1 });
    expect(first.trips.map((trip) => trip.id)).toEqual([newer]);
    expect(first.nextBefore).toBe(first.trips[0]?.startedAt);

    const second = await feed(driver, { limit: 1, before: String(first.nextBefore) });
    expect(second.trips.map((trip) => trip.id)).toEqual([older]);
  });

  it('stops offering a cursor at the end of the feed', async () => {
    const { driver } = await runningSession();
    await twoTrips(driver);

    const { trips, nextBefore } = await feed(driver, { limit: 20 });

    expect(trips).toHaveLength(2);
    expect(nextBefore).toBeNull();
  });

  it("shows a driver none of another driver's trips", async () => {
    const mine = await runningSession();
    await upload(mine.driver, mine.sessionId, straightRun());
    const stranger = await runningSession(OTHER_DRIVER);

    const { trips } = await feed(stranger.driver);

    expect(trips).toEqual([]);
  });

  it('refuses a page larger than it will serve', async () => {
    const driver = await drivingDriver();
    await driver.get('/v1/driver/trips?limit=500').expect(400);
  });

  it('is closed to a caller who is not signed in', async () => {
    await client().get('/v1/driver/trips').expect(401);
  });
});

// ------------------------------------------------------- the fleet as sensor

/**
 * The same trace that produced the invoice, read a second way.
 *
 * Nothing here bills. The point is that a shift already carries a measurement
 * of the roads it was driven on, and that the platform can have it without
 * buying a traffic feed — which is the asset the impression model is built on.
 */
describe('learning what a road looks like when it is clear', () => {
  /** Where `straightRun` drives: 12.97–12.98 N at 77.61 E is one cell. */
  const DRIVEN_CELL = '1297:7761';

  it('turns a shift into a baseline for the cell it was driven in', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, straightRun());

    const result = await recomputeBaselines();

    // One cell, and at least one hour of it — the run is 90 seconds, so it
    // lands in one hour of the week unless it happens to straddle the turn.
    expect(result.cells).toBe(1);
    expect(result.cellHours).toBeGreaterThanOrEqual(1);

    const rows = (await sequelize.query(
      `SELECT grid_key, free_flow_kmh, sample_count
         FROM speed_baselines
        WHERE hour_of_week IS NULL`,
      { type: 'SELECT' },
    )) as { grid_key: string; free_flow_kmh: string; sample_count: number }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]?.grid_key).toBe(DRIVEN_CELL);

    // Four fixes, three pairs, three observations — and about 33 km/h, which
    // is 278 m of latitude every 30 seconds.
    expect(rows[0]?.sample_count).toBe(3);
    expect(Number(rows[0]?.free_flow_kmh)).toBeGreaterThan(30);
    expect(Number(rows[0]?.free_flow_kmh)).toBeLessThan(37);
  });

  /**
   * The measurement is stored; what it is allowed to claim is decided on read.
   * Three observations is a fact about one vehicle, not a description of a
   * road, and the ladder says so by falling through to the zone default.
   */
  it('will not let three observations describe a road', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, straightRun());
    await recomputeBaselines();

    const lookup = await loadBaselines([DRIVEN_CELL]);

    expect(lookup.for(DRIVEN_CELL, 40, 'PRIME')).toMatchObject({
      source: 'ZONE_DEFAULT',
      sampleCount: 0,
    });
  });

  /** Every job on the queue has to survive a retry. */
  it('is safe to run twice', async () => {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, straightRun());

    const first = await recomputeBaselines();
    const second = await recomputeBaselines();

    expect(second).toEqual(first);
  });

  it('learns nothing from a day nobody drove', async () => {
    expect(await recomputeBaselines()).toEqual({ cells: 0, cellHours: 0 });
  });
});

/**
 * The same segments a third way: as an audience.
 *
 * These figures are modelled, not measured, and nothing bills off them. What
 * has to hold is that they attach only to driving the platform was willing to
 * charge for, that they carry the evidence they were derived from, and that
 * the job producing them can be run again without producing them twice.
 */
describe('expressing a shift as an audience', () => {
  /**
   * Four fixes, so three pairs. The last fix is too inaccurate to bill
   * without review, which holds the pair that reaches it.
   */
  async function aShiftWithOneHeldPair(): Promise<void> {
    const { driver, sessionId } = await runningSession();
    await upload(driver, sessionId, [
      fix({ lat: 12.9715, seconds: 0 }),
      fix({ lat: 12.973, seconds: 30 }),
      fix({ lat: 12.9745, seconds: 60 }),
      fix({ lat: 12.976, seconds: 90, accuracyM: 65 }),
    ]);

    await recomputeBaselines();
  }

  it('gives the billable kilometres an audience and the held ones none', async () => {
    await aShiftWithOneHeldPair();

    expect(await computeMissing()).toMatchObject({ computed: 2 });

    expect(
      await countOf("SELECT count(*)::int AS n FROM trip_segments WHERE state = 'PENDING_REVIEW'"),
    ).toBe(1);

    const rows = (await sequelize.query(
      `SELECT s.state, si.impressions
         FROM segment_impressions si
         JOIN trip_segments s ON s.id = si.segment_id`,
      { type: 'SELECT' },
    )) as { state: string; impressions: string }[];

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.state === 'BILLABLE')).toBe(true);
    expect(rows.every((row) => Number(row.impressions) > 0)).toBe(true);
  });

  /**
   * A figure resting on a per-zone default is a weaker claim than one resting
   * on thousands of observations, and the row has to say which it is. Three
   * segments is nowhere near enough to describe a road, so every figure here
   * should admit to being a default.
   */
  it('records which rung of the baseline ladder each figure rests on', async () => {
    await aShiftWithOneHeldPair();
    await computeMissing();

    const rows = (await sequelize.query(
      `SELECT baseline_source, baseline_kmh, observed_kmh, model_version
         FROM segment_impressions`,
      { type: 'SELECT' },
    )) as {
      baseline_source: string;
      baseline_kmh: string;
      observed_kmh: string;
      model_version: string;
    }[];

    expect(rows.every((row) => row.baseline_source === 'ZONE_DEFAULT')).toBe(true);
    expect(rows.every((row) => Number(row.baseline_kmh) === 34)).toBe(true);
    expect(rows.every((row) => row.model_version === 'v1.0.0')).toBe(true);

    /*
     * Derived from the segment's own distance and duration: 167 m every 30
     * seconds is 20 km/h. Every one of these fixes reported `speedMps: 11`,
     * which is 40 km/h — so a model reading the handset would have doubled the
     * speed, halved the congestion, and under-counted the audience. The
     * pipeline refuses that number when checking for fraud; the impression
     * model has to refuse it for the same reason.
     */
    expect(rows.every((row) => Number(row.observed_kmh) > 18)).toBe(true);
    expect(rows.every((row) => Number(row.observed_kmh) < 22)).toBe(true);
  });

  it('does not count a kilometre twice when it runs again', async () => {
    await aShiftWithOneHeldPair();

    expect(await computeMissing()).toMatchObject({ computed: 2 });
    expect(await computeMissing()).toMatchObject({ computed: 0 });

    expect(await countOf('SELECT count(*)::int AS n FROM segment_impressions')).toBe(2);
  });

  it('has nothing to say about a day nobody drove', async () => {
    expect(await computeMissing()).toMatchObject({ computed: 0 });
  });
});

/**
 * The advertiser's side of the same segments.
 *
 * The admin audit of this driving exposes both halves of the money and sits
 * behind its own permission for that reason. This is its mirror: the same
 * kilometres, the audience modelled from them, and nothing at all about the
 * person who drove them.
 */
describe('what the advertiser is shown', () => {
  async function aDrivenCampaign(): Promise<{ advertiser: Agent; campaignId: string }> {
    const { driver, sessionId, campaignId } = await runningSession();
    await upload(driver, sessionId, straightRun());
    await recomputeBaselines();
    await computeMissing();

    return { advertiser: await advertiserPortal(), campaignId };
  }

  it('reports the audience beside the distance it was derived from', async () => {
    const { advertiser, campaignId } = await aDrivenCampaign();

    const { body } = await advertiser.get(`/v1/campaigns/${campaignId}/impressions`).expect(200);

    expect(body).toMatchObject({ campaignId, modelVersion: 'v1.0.0' });

    // Never the audience alone: the kilometres are what the contract is
    // written in, and the impressions are the modelled translation of them.
    expect(body.verifiedKm).toBeGreaterThan(0);
    expect(body.impressions).toBeGreaterThan(0);
    expect(Number(body.cpm)).toBeGreaterThan(0);

    expect(body.byZone).toHaveLength(1);
    expect(body.byZone[0]).toMatchObject({ zone: 'prime' });
    expect(body.byDay).toHaveLength(1);
  });

  /**
   * The claim no competitor renting a traffic feed can make: not just how big
   * the audience was, but how much of that number is measurement. Three
   * observations of one cell is not a measured road, so this campaign's
   * figures should own up to resting entirely on a default.
   */
  it('says how much of the figure rests on measurement', async () => {
    const { advertiser, campaignId } = await aDrivenCampaign();

    const { body } = await advertiser.get(`/v1/campaigns/${campaignId}/impressions`).expect(200);
    const mix = body.baselineMix as { cellHour: number; cell: number; zoneDefault: number };

    expect(mix.cellHour + mix.cell + mix.zoneDefault).toBeCloseTo(1, 4);
    expect(mix.zoneDefault).toBe(1);
  });

  /**
   * Asserted against the serialised body rather than against named fields,
   * because the failure being guarded is a field nobody meant to add.
   */
  it('carries nothing about the driver or what they earned', async () => {
    const { advertiser, campaignId } = await aDrivenCampaign();

    const { body } = await advertiser.get(`/v1/campaigns/${campaignId}/impressions`).expect(200);
    const raw = JSON.stringify(body);

    expect(raw).not.toContain(DRIVER.name);
    expect(raw).not.toContain(DRIVER.mobile);
    expect(raw).not.toMatch(/driver/i);
  });

  it('shows its working for a day', async () => {
    const { advertiser, campaignId } = await aDrivenCampaign();
    const today = await istToday();

    const { body } = await advertiser
      .get(`/v1/campaigns/${campaignId}/impressions/days/${today}`)
      .expect(200);

    expect(body).toMatchObject({ campaignId, date: today });
    expect(body.working).toMatchObject({
      jamDensity: 150,
      occupantsPerVehicle: 1.5,
      lineOfSightShare: 0.3,
      wrapQuality: 0.85,
    });

    // The two speeds the congestion was read from, so the density claim can be
    // checked by hand rather than taken on trust.
    expect(body.working.medianObservedKmh).toBeGreaterThan(30);
    expect(body.working.medianBaselineKmh).toBe(34);
  });

  it('answers a day the campaign did not run with zeroes rather than nothing', async () => {
    const { advertiser, campaignId } = await aDrivenCampaign();

    const { body } = await advertiser
      .get(`/v1/campaigns/${campaignId}/impressions/days/2026-01-01`)
      .expect(200);

    expect(body).toMatchObject({ impressions: 0, verifiedKm: 0, cpm: '0.00' });
    expect(body.byZone).toEqual([]);
  });

  /** Not theirs is not found, rather than forbidden. */
  it('does not answer for a campaign the advertiser does not own', async () => {
    await aDrivenCampaign();
    const advertiser = await advertiserPortal();

    await advertiser.get(`/v1/campaigns/${randomUUID()}/impressions`).expect(404);
  });

  it('refuses an id that is not one', async () => {
    const advertiser = await advertiserPortal();
    await advertiser.get('/v1/campaigns/not-a-uuid/impressions').expect(400);
  });

  it('is closed to a caller who is not signed in', async () => {
    const { campaignId } = await aDrivenCampaign();
    await client().get(`/v1/campaigns/${campaignId}/impressions`).expect(401);
  });
});

// ------------------------------------------------------------------ fixtures

/**
 * Today in Asia/Kolkata, asked of Postgres.
 *
 * Computing it in Node would make the test agree with the code for the wrong
 * reason on a machine that happens to run in IST, and disagree on CI, which
 * does not.
 */
async function istToday(): Promise<string> {
  const today = await row<{ date: string }>(
    `SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS date`,
  );
  return today.date;
}

interface DayBody {
  date: string;
  totalVerifiedKm: number;
  totalEarnings: string;
  trips: {
    id: string;
    sequence: number;
    startedAt: string;
    endedAt: string;
    verifiedKm: number;
    earnings: string;
    status: string;
    zoneBreakdown: { zone: string; km: number; earnings: string }[] | null;
  }[];
}

interface EarningsBody {
  todayVerifiedKm: number;
  todayEarnings: string;
  history: { date: string; verifiedKm: number; earnings: string }[];
}

async function dayOf(driver: Agent, date: string): Promise<DayBody> {
  const response = await driver.get(`/v1/driver/earnings/days/${date}`).expect(200);
  return response.body as DayBody;
}

async function earningsOf(driver: Agent): Promise<EarningsBody> {
  const response = await driver.get('/v1/driver/earnings').expect(200);
  return response.body as EarningsBody;
}

interface AuditDayBody extends DayBody {
  vehicle: { id: string; registrationNumber: string };
  totalCharge: string;
}

interface TripDetailBody {
  id: string;
  vehicleRegistration: string;
  campaignName: string;
  driverName: string;
  distanceKm: number;
  advertiserCharge: string;
  driverEarning: string;
  legs: {
    zone: string;
    state: string;
    flagReason: string | null;
    distanceKm: number;
    advertiserRate: string;
    driverRate: string;
    advertiserCharge: string;
    driverEarning: string;
    segments: number;
    path: { lat: number; lng: number }[];
  }[];
}

function auditRequest(vehicleNumber: string, date: string) {
  return admin.get('/v1/admin/gps-audit/trips').query({ vehicleNumber, date });
}

async function auditDay(vehicleNumber: string, date: string): Promise<AuditDayBody> {
  const response = await auditRequest(vehicleNumber, date).expect(200);
  return response.body as AuditDayBody;
}

async function auditTrip(sessionId: string): Promise<TripDetailBody> {
  const response = await admin.get(`/v1/admin/gps-audit/trips/${sessionId}`).expect(200);
  return response.body as TripDetailBody;
}

interface DriverTripBody {
  id: string;
  campaignName: string;
  verifiedKm: number;
  earnings: string;
  status: string;
  legs: {
    zone: string;
    state: string;
    flagReason: string | null;
    distanceKm: number;
    earnings: string;
    path: { lat: number; lng: number }[];
  }[];
}

async function ownTrip(driver: Agent, sessionId: string): Promise<DriverTripBody> {
  const response = await driver.get(`/v1/driver/trips/${sessionId}`).expect(200);
  return response.body as DriverTripBody;
}

interface TripFeedBody {
  trips: {
    id: string;
    campaignName: string;
    startedAt: string;
    endedAt: string;
    verifiedKm: number;
    earnings: string;
    status: string;
  }[];
  nextBefore: string | null;
}

async function feed(
  driver: Agent,
  query: { limit?: number; before?: string } = {},
): Promise<TripFeedBody> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.before !== undefined) params.set('before', query.before);

  const suffix = params.toString();
  const response = await driver.get(`/v1/driver/trips${suffix ? `?${suffix}` : ''}`).expect(200);
  return response.body as TripFeedBody;
}

/**
 * Two finished trips for one driver, ten minutes apart, returned oldest first.
 *
 * Separated in time on purpose: the feed orders on start time, and two runs
 * uploaded in the same millisecond would let a broken `ORDER BY` pass.
 */
async function twoTrips(driver: Agent): Promise<[string, string]> {
  const older = await nextSession(driver);
  await upload(driver, older, straightRun());

  const newer = await nextSession(driver);
  await upload(driver, newer, straightRun(600));

  return [older, newer];
}

/** Closes whatever session is open and starts the next one. */
async function nextSession(driver: Agent): Promise<string> {
  await driver.delete('/v1/driver/tracking/session').send({}).expect(200);
  const started = await driver.post('/v1/driver/tracking/session').send({}).expect(200);
  return String(started.body.id);
}

/** One session north through Prime, unzoned ground and Secondary. */
async function drivenAcrossTheCity(): Promise<TripDetailBody> {
  const { driver, sessionId } = await runningSession();
  await upload(driver, sessionId, crossCity());
  return auditTrip(sessionId);
}

/**
 * Runs the body with a permission taken off SUPER_ADMIN, then puts it back.
 *
 * Roles are seeded by migration and survive the truncation between tests, so
 * the grant has to be restored by hand however the assertion goes — otherwise
 * one failing expectation silently disarms every later test in the file.
 */
async function withoutPermission(key: string, body: () => Promise<void>): Promise<void> {
  const revoke = `DELETE FROM role_permissions
                   WHERE permission_key = :key
                     AND role_id = (SELECT id FROM roles WHERE key = 'SUPER_ADMIN')`;
  const grant = `INSERT INTO role_permissions (role_id, permission_key)
                 SELECT id, :key FROM roles WHERE key = 'SUPER_ADMIN'
                 ON CONFLICT DO NOTHING`;

  await sequelize.query(revoke, { replacements: { key } });
  try {
    await body();
  } finally {
    await sequelize.query(grant, { replacements: { key } });
  }
}

/** A fix on the northbound line through both boxes, at 77.61. */
function fix(input: {
  lat: number;
  seconds: number;
  accuracyM?: number;
  isMock?: boolean;
  deviceDistanceM?: number;
  from?: Date;
}) {
  const base = input.from ?? new Date(Date.now() - 30 * 60 * 1000);
  return {
    clientPointId: randomUUID(),
    recordedAt: new Date(base.getTime() + input.seconds * 1000).toISOString(),
    lat: input.lat,
    lon: 77.61,
    accuracyM: input.accuracyM ?? 8,
    speedMps: 11,
    headingDeg: 0,
    isMock: input.isMock ?? false,
    ...(input.deviceDistanceM === undefined ? {} : { deviceDistanceM: input.deviceDistanceM }),
  };
}

/**
 * Two fixes spanning both boxes and the unzoned ground between them: one pair
 * that has to come back as three priced parts.
 *
 * 2.8 km in 110 seconds is 91 km/h — quick for Bengaluru, and deliberately
 * inside the plausible limit, because a journey held for review as impossible
 * would prove nothing about how it was priced.
 */
function crossCity() {
  return [fix({ lat: 12.975, seconds: 0 }), fix({ lat: 13.0, seconds: 110 })];
}

/**
 * The same climb, every fix too coarse to price on. Nothing here is billable,
 * so the whole trip lands in review — which is the state the feed has to keep
 * showing rather than quietly drop.
 */
function underReview() {
  return [12.9715, 12.974, 12.9765, 12.979].map((lat, index) =>
    fix({ lat, seconds: index * 30, accuracyM: 65 }),
  );
}

/** Four fixes climbing through the Prime box: about 0.8 km, all billable. */
function straightRun(offsetSeconds = 0, from?: Date) {
  return [12.9715, 12.974, 12.9765, 12.979].map((lat, index) =>
    fix({ lat, seconds: offsetSeconds + index * 30, ...(from ? { from } : {}) }),
  );
}

async function upload(driver: Agent, sessionId: string, points: unknown[]) {
  const response = await driver.post('/v1/driver/tracking/points').send({ sessionId, points });
  if (response.status !== 200) {
    throw new Error(`Upload failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response;
}

interface SegmentRow {
  zone: string;
  state: string;
  distance_km: string;
  advertiser_rate: string;
  driver_rate: string;
  advertiser_charge: string;
  driver_earning: string;
  bridged: boolean;
  flag_reason: string | null;
  started_at: string;
}

async function countOf(sql: string): Promise<number> {
  const rows = (await sequelize.query(sql, { type: 'SELECT' })) as { n: number }[];
  return rows[0]?.n ?? 0;
}

async function row<T>(sql: string): Promise<T> {
  const rows = (await sequelize.query(sql, { type: 'SELECT' })) as T[];
  const first = rows[0];
  if (!first) throw new Error(`No rows for ${sql}`);
  return first;
}

async function segments(where: string): Promise<SegmentRow[]> {
  return (await sequelize.query(
    `SELECT * FROM trip_segments WHERE ${where} ORDER BY started_at, part_index`,
    { type: 'SELECT' },
  )) as SegmentRow[];
}

/** A driver who has passed every AC-07 condition and can legally start. */
async function drivingDriver(): Promise<Agent> {
  const { driverId } = await liveCampaign();
  return signInDriver(driverId);
}

async function runningSession(who: DriverProfile = DRIVER): Promise<{
  driver: Agent;
  sessionId: string;
  campaignId: string;
  driverId: string;
}> {
  const { driverId, campaignId } = await liveCampaign(who);
  const driver = await signInDriver(driverId, who);
  const started = await driver.post('/v1/driver/tracking/session').send({}).expect(200);
  return { driver, sessionId: String(started.body.id), campaignId, driverId };
}

async function advertiserPortal(): Promise<Agent> {
  advertiserAgent ??= await signInAdvertiser();
  return advertiserAgent;
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

async function liveCampaign(
  who: DriverProfile = DRIVER,
): Promise<{ campaignId: string; driverId: string }> {
  const context = await assignedButNotInstalled(who);

  for (const angle of ['FRONT', 'REAR', 'LEFT', 'RIGHT']) {
    await admin
      .post(`/v1/admin/assignments/${context.assignmentId}/photos?angle=${angle}`)
      .attach('file', PNG, { filename: `${angle.toLowerCase()}.png`, contentType: 'image/png' })
      .expect(201);
  }
  await admin.post(`/v1/admin/assignments/${context.assignmentId}/submit`).expect(200);
  await (await secondAdmin())
    .post(`/v1/admin/assignments/${context.assignmentId}/approve`)
    .expect(200);

  return context;
}

async function assignedButNotInstalled(who: DriverProfile = DRIVER): Promise<{
  assignmentId: string;
  campaignId: string;
  driverId: string;
}> {
  const { driverId, vehicleId } = await approvedDriverWithVehicle(who);
  const advertiser = await advertiserPortal();

  const created = await advertiser
    .post('/v1/campaigns')
    .send({ ...CAMPAIGN, requestedVehicleIds: [vehicleId] })
    .expect(201);

  const campaignId = String(created.body.id);
  await admin.post(`/v1/admin/campaigns/${campaignId}/approve`).expect(200);
  await admin.post(`/v1/admin/campaigns/${campaignId}/print-ready`).expect(200);

  const assigned = await admin
    .post(`/v1/admin/campaigns/${campaignId}/vehicles`)
    .send({ vehicleIds: [vehicleId] })
    .expect(201);

  // Deliberately stops short of marking the campaign installed, which is now
  // the thing that puts the vehicle on the road.
  return { assignmentId: String(assigned.body[0].id), campaignId, driverId };
}

/** Cached: a test that brings up two campaigns must not enrol this twice. */
async function secondAdmin(): Promise<Agent> {
  reviewerAgent ??= await enrolReviewer();
  return reviewerAgent;
}

async function enrolReviewer(): Promise<Agent> {
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

const PLATES: Record<string, string> = {
  [DRIVER.email]: 'KA05MN9012',
  [OTHER_DRIVER.email]: 'KA05MN9013',
};

/** The plate the audit tests type in. */
const PLATE = PLATES[DRIVER.email] ?? '';

async function approvedDriverWithVehicle(
  who: DriverProfile = DRIVER,
): Promise<{ driverId: string; vehicleId: string }> {
  const driver = await admin.post('/v1/admin/drivers').send(who).expect(201);
  const driverId = String(driver.body.driver.id);

  const vehicle = await admin
    .post(`/v1/admin/drivers/${driverId}/vehicles`)
    .send({ registrationNumber: PLATES[who.email], category: 'CAB' })
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

/**
 * Consent is granted on the way in. It is the sixth AC-07 condition, and every
 * case here is about one of the other five or about what happens after they
 * all hold; leaving it off would fail them all for a reason none of them is
 * testing. `driver-profile.test.ts` proves the gate itself bites.
 */
async function signInDriver(_driverId: string, who: DriverProfile = DRIVER): Promise<Agent> {
  const agent = client();
  await agent
    .post('/v1/auth/login')
    .send({ email: who.email, password: inbox.passwordFor(who.email) })
    .expect(200);
  await agent.put('/v1/driver/me/consent').send({ granted: true }).expect(200);
  return agent;
}
