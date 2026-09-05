import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';

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
  await sequelize.query(
    `TRUNCATE users, user_sessions, user_invitations, audit_log, advertisers, campaigns,
     notifications, drivers, driver_consents, vehicles, campaign_vehicles, installations,
     installation_photos, tracking_sessions, gps_points, trip_segments
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

    // AC-08.3: not merely "no", but which of the five is in the way. A driver
    // told only that they cannot start has nothing to act on.
    expect(refused.body.message).toMatch(/Installation verified/);
    expect(refused.body.message).toMatch(/Campaign active/);
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
   * AC-07.3 and AC-07.4: the six conditions are checked on every batch, not
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
    expect(parked[0]?.flag_reason).toMatch(/Campaign active/);
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

// ------------------------------------------------------------------ fixtures

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

async function runningSession(): Promise<{
  driver: Agent;
  sessionId: string;
  campaignId: string;
  driverId: string;
}> {
  const { driverId, campaignId } = await liveCampaign();
  const driver = await signInDriver(driverId);
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

async function liveCampaign(): Promise<{ campaignId: string; driverId: string }> {
  const context = await assignedButNotInstalled();

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

async function assignedButNotInstalled(): Promise<{
  assignmentId: string;
  campaignId: string;
  driverId: string;
}> {
  const { driverId, vehicleId } = await approvedDriverWithVehicle();
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

  await admin.post(`/v1/admin/campaigns/${campaignId}/installed`).expect(200);

  return { assignmentId: String(assigned.body[0].id), campaignId, driverId };
}

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

async function approvedDriverWithVehicle(): Promise<{ driverId: string; vehicleId: string }> {
  const driver = await admin.post('/v1/admin/drivers').send(DRIVER).expect(201);
  const driverId = String(driver.body.driver.id);

  const vehicle = await admin
    .post(`/v1/admin/drivers/${driverId}/vehicles`)
    .send({ registrationNumber: 'KA05MN9012', category: 'CAB' })
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
async function signInDriver(_driverId: string): Promise<Agent> {
  const agent = client();
  await agent
    .post('/v1/auth/login')
    .send({ email: DRIVER.email, password: inbox.passwordFor(DRIVER.email) })
    .expect(200);
  await agent.put('/v1/driver/me/consent').send({ granted: true }).expect(200);
  return agent;
}
