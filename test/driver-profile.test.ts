import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';

import { type Agent, client, signIn } from './helpers/admin';
import { captureMail, type MailInbox } from './helpers/mail';

/**
 * The half of AC-04 that lives on the driver's own phone: their address, their
 * payout details, and their consent to be tracked (UI-013, AC-04.3 – AC-04.6).
 *
 * Two things here are worth more attention than the rest. Payout details are
 * the only field on this API a thief would want, so the tests care about what
 * leaves the server rather than about what a screen chooses to render. And
 * withdrawing consent is not a preference — AC-04.5 makes it stop tracking and
 * take the driver off live campaigns, which costs an advertiser a vehicle, so
 * the consequences are asserted rather than assumed.
 */

const DRIVER = {
  mobile: '9845012345',
  name: 'Rahul Kumar',
  email: 'rahul.kumar@example.com',
  location: { city: 'Bengaluru', label: 'MG Road, Bengaluru', lat: 12.9756, lng: 77.6069 },
};

const ADDRESS = {
  line1: '14, 3rd Cross, Koramangala 5th Block',
  line2: null,
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560095',
};

const BANK = {
  method: 'BANK' as const,
  accountName: 'Rahul Kumar',
  accountNumber: '123456789012',
  ifsc: 'HDFC0001234',
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
    console.warn('\n  driver profile tests skipped: no database reachable at DATABASE_URL\n');
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

describe('the driver editing their own record (UI-013)', () => {
  it('saves a name and an address, and reads them back after a fresh sign-in', async () => {
    const driver = await onboardedDriver();

    const saved = await driver
      .patch('/v1/driver/me')
      .send({ name: 'Rahul K Kumar', address: ADDRESS })
      .expect(200);

    expect(saved.body.name).toBe('Rahul K Kumar');
    expect(saved.body.address).toMatchObject(ADDRESS);

    // UI-013.8 — persisted, not held in the screen that typed it.
    const again = await (await signInDriver()).get('/v1/driver/me').expect(200);
    expect(again.body.address).toMatchObject(ADDRESS);
  });

  /*
   * UI-013.5. A driver who can change their own email can move their account
   * to a mailbox nobody audited, and the mobile is how operations reaches them.
   * Both are corrections, and corrections belong to admin.
   */
  it('will not let the driver change their own email or mobile', async () => {
    const driver = await onboardedDriver();

    await driver.patch('/v1/driver/me').send({ email: 'someone.else@example.com' }).expect(400);
    await driver.patch('/v1/driver/me').send({ mobile: '9845099999' }).expect(400);

    const profile = await driver.get('/v1/driver/me').expect(200);
    expect(profile.body.email).toBe(DRIVER.email);
    expect(profile.body.mobile).toBe(DRIVER.mobile);
  });

  it('refuses an address whose PIN code is not one', async () => {
    const driver = await onboardedDriver();

    await driver
      .patch('/v1/driver/me')
      .send({ address: { ...ADDRESS, pincode: '05609' } })
      .expect(400);

    expect((await driver.get('/v1/driver/me').expect(200)).body.address).toBeNull();
  });

  it('rejects an empty body rather than reporting a save that changed nothing', async () => {
    const driver = await onboardedDriver();
    await driver.patch('/v1/driver/me').send({}).expect(400);
  });
});

describe('payout details (AC-04.1, AC-04.6)', () => {
  it('validates the IFSC and the account number before storing either', async () => {
    const driver = await onboardedDriver();

    await driver
      .patch('/v1/driver/me')
      .send({ payout: { ...BANK, ifsc: 'HDFC1001234' } })
      .expect(400);
    await driver
      .patch('/v1/driver/me')
      .send({ payout: { ...BANK, accountNumber: '12345' } })
      .expect(400);
    await driver
      .patch('/v1/driver/me')
      .send({ payout: { method: 'UPI', upiId: 'not-a-upi-id' } })
      .expect(400);

    expect((await driver.get('/v1/driver/me').expect(200)).body.payout).toBeNull();
  });

  /*
   * The test is about the payload, not the screen. A field the response
   * carries in full is not masked however the client chooses to draw it.
   */
  it('never returns the account number with the profile', async () => {
    const driver = await onboardedDriver();
    await driver.patch('/v1/driver/me').send({ payout: BANK }).expect(200);

    const profile = await driver.get('/v1/driver/me').expect(200);

    expect(profile.body.payout).toMatchObject({
      method: 'BANK',
      accountName: 'Rahul Kumar',
      ifsc: 'HDFC0001234',
    });
    expect(profile.body.payout.accountNumberMasked).toBe('\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u20229012');
    expect(JSON.stringify(profile.body)).not.toContain(BANK.accountNumber);
  });

  it('returns it in full only when asked for it explicitly', async () => {
    const driver = await onboardedDriver();
    await driver.patch('/v1/driver/me').send({ payout: BANK }).expect(200);

    const revealed = await driver.post('/v1/driver/me/payout/reveal').expect(200);
    expect(revealed.body).toMatchObject(BANK);
  });

  it('lower-cases nothing and upper-cases the IFSC, because banks are fussy', async () => {
    const driver = await onboardedDriver();
    await driver
      .patch('/v1/driver/me')
      .send({ payout: { ...BANK, ifsc: 'hdfc0001234' } })
      .expect(200);

    expect((await driver.post('/v1/driver/me/payout/reveal').expect(200)).body.ifsc).toBe(
      'HDFC0001234',
    );
  });

  /*
   * Switching method has to clear the old one. A stale bank account left
   * behind a UPI id is money going to an account the driver has stopped using,
   * and the database check constraint cannot catch it because both halves are
   * individually valid.
   */
  it('replaces payout details wholesale rather than merging them', async () => {
    const driver = await onboardedDriver();
    await driver.patch('/v1/driver/me').send({ payout: BANK }).expect(200);

    await driver
      .patch('/v1/driver/me')
      .send({ payout: { method: 'UPI', upiId: 'rahul@okhdfcbank' } })
      .expect(200);

    const revealed = await driver.post('/v1/driver/me/payout/reveal').expect(200);
    expect(revealed.body).toEqual({ method: 'UPI', upiId: 'rahul@okhdfcbank' });

    const stored = await row<{ bank_account_number: string | null; payout_method: string }>(
      'SELECT bank_account_number, payout_method FROM drivers LIMIT 1',
    );
    expect(stored.bank_account_number).toBeNull();
    expect(stored.payout_method).toBe('UPI');
  });

  it('masks a UPI id without hiding which bank it is', async () => {
    const driver = await onboardedDriver();
    await driver
      .patch('/v1/driver/me')
      .send({ payout: { method: 'UPI', upiId: 'rahul@okhdfcbank' } })
      .expect(200);

    const profile = await driver.get('/v1/driver/me').expect(200);
    expect(profile.body.payout.upiIdMasked).toMatch(/^ra\u2022+@okhdfcbank$/);
  });

  it('keeps the account number out of the audit trail as well', async () => {
    const driver = await onboardedDriver();
    await driver.patch('/v1/driver/me').send({ payout: BANK }).expect(200);

    const entries = await sequelize.query(
      `SELECT before, after FROM audit_log WHERE action = 'driver.profile_updated'`,
      { type: 'SELECT' },
    );

    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain(BANK.accountNumber);
  });
});

describe('the profile photo (UI-013.6)', () => {
  it('accepts an image and then serves it back', async () => {
    const driver = await onboardedDriver();

    const saved = await driver
      .post('/v1/driver/me/photo')
      .attach('file', PNG, { filename: 'me.png', contentType: 'image/png' })
      .expect(200);

    expect(saved.body.photoUrl).toBe('/v1/driver/me/photo');

    const served = await driver.get('/v1/driver/me/photo').expect(200);
    expect(served.headers['content-type']).toContain('image/png');
    expect(served.body).toEqual(PNG);
  });

  it('answers 404 before one has been sent, rather than an empty 200', async () => {
    const driver = await onboardedDriver();

    expect((await driver.get('/v1/driver/me').expect(200)).body.photoUrl).toBeNull();
    await driver.get('/v1/driver/me/photo').expect(404);
  });

  it('refuses a PDF, which documents accept and an avatar cannot', async () => {
    const driver = await onboardedDriver();

    await driver
      .post('/v1/driver/me/photo')
      .attach('file', Buffer.from('%PDF-1.4'), {
        filename: 'me.pdf',
        contentType: 'application/pdf',
      })
      .expect(422);
  });
});

describe('consent to location tracking (AC-04.3, AC-04.4)', () => {
  it('serves the disclosure with a version, so the record can name what was agreed', async () => {
    const driver = await onboardedDriver();

    const response = await driver.get('/v1/driver/me/consent').expect(200);

    expect(response.body.disclosure.version).toBeTruthy();
    expect(response.body.disclosure.points.length).toBeGreaterThan(3);
    expect(response.body.current).toEqual({
      granted: false,
      recordedAt: null,
      policyVersion: null,
    });
  });

  it('starts withheld — silence is not consent', async () => {
    const driver = await onboardedDriver();
    expect((await driver.get('/v1/driver/me').expect(200)).body.consent.locationTracking).toEqual({
      granted: false,
      recordedAt: null,
      policyVersion: null,
    });
  });

  it('records the version agreed to, and the moment', async () => {
    const driver = await onboardedDriver();
    const granted = await driver.put('/v1/driver/me/consent').send({ granted: true }).expect(200);

    expect(granted.body.granted).toBe(true);
    expect(granted.body.policyVersion).toBeTruthy();
    expect(Date.parse(String(granted.body.recordedAt))).toBeLessThanOrEqual(Date.now());
  });

  /*
   * The point of an append-only log. A boolean answers "do they consent now?";
   * only the history answers "were they consenting on the day we billed that
   * kilometre?", and that is the question a regulator asks.
   */
  it('keeps every answer rather than overwriting the last one', async () => {
    const driver = await onboardedDriver();

    await driver.put('/v1/driver/me/consent').send({ granted: true }).expect(200);
    await driver.put('/v1/driver/me/consent').send({ granted: false }).expect(200);
    await driver.put('/v1/driver/me/consent').send({ granted: true }).expect(200);

    const response = await driver.get('/v1/driver/me/consent').expect(200);
    expect(response.body.history).toHaveLength(3);
    expect(response.body.history.map((entry: { granted: boolean }) => entry.granted)).toEqual([
      true,
      false,
      true,
    ]);
    expect(response.body.current.granted).toBe(true);
  });

  it('is attributable afterwards', async () => {
    const driver = await onboardedDriver();
    await driver.put('/v1/driver/me/consent').send({ granted: true }).expect(200);

    const entries = await sequelize.query(
      `SELECT action FROM audit_log WHERE action LIKE 'driver.consent%'`,
      { type: 'SELECT' },
    );
    expect(entries).toEqual([{ action: 'driver.consent_granted' }]);
  });
});

describe('withdrawing consent (AC-04.5)', () => {
  it('is the sixth thing that has to be true before a kilometre can be billed', async () => {
    const driver = await onboardedDriver();

    const before = await driver.get('/v1/driver/tracking/eligibility').expect(200);
    const check = checkOf(before.body, 'tracking_consent');
    expect(check.passed).toBe(false);
    expect(check.remedy).toContain('Settings');

    await driver.put('/v1/driver/me/consent').send({ granted: true }).expect(200);

    const after = await driver.get('/v1/driver/tracking/eligibility').expect(200);
    expect(checkOf(after.body, 'tracking_consent').passed).toBe(true);
  });

  it('refuses to start tracking without it, from the server rather than the button', async () => {
    const driver = await onboardedDriver();
    await driver.post('/v1/driver/tracking/session').send({}).expect(409);
  });

  /*
   * The consequences of withdrawing — a session ended, a campaign released —
   * need a driver who has both, which is thirty lines of assignment and
   * installation setup. They are proved in `tracking.test.ts`, where that
   * setup already exists. What belongs here is the quiet case.
   */
  it('says nothing happened when nothing was running', async () => {
    const driver = await onboardedDriver();
    await driver.put('/v1/driver/me/consent').send({ granted: true }).expect(200);

    const withdrawn = await driver
      .put('/v1/driver/me/consent')
      .send({ granted: false })
      .expect(200);

    expect(withdrawn.body).toMatchObject({
      granted: false,
      trackingStopped: false,
      campaignsReleased: 0,
    });

    // No notification either. A message about a non-event trains the driver to
    // ignore the ones that matter.
    const inboxRows = await driver.get('/v1/driver/notifications').expect(200);
    expect(inboxRows.body.items).toHaveLength(0);
  });
});

// --- helpers ---------------------------------------------------------------

async function onboardedDriver(): Promise<Agent> {
  await admin.post('/v1/admin/drivers').send(DRIVER).expect(201);
  return signInDriver();
}

async function signInDriver(): Promise<Agent> {
  const agent = client();
  await agent
    .post('/v1/auth/login')
    .send({ email: DRIVER.email, password: inbox.passwordFor(DRIVER.email) })
    .expect(200);
  return agent;
}

interface Check {
  id: string;
  passed: boolean;
  remedy: string | null;
}

function checkOf(body: unknown, id: string): Check {
  const checks = (body as { checks: Check[] }).checks;
  const found = checks.find((check) => check.id === id);
  if (!found) throw new Error(`No eligibility check ${id}`);
  return found;
}

async function row<T>(sql: string): Promise<T> {
  const rows = (await sequelize.query(sql, { type: 'SELECT' })) as T[];
  const first = rows[0];
  if (!first) throw new Error(`No rows for ${sql}`);
  return first;
}
