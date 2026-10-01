import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';
import { setObjectStoreForTests, type ObjectStore, type StoredObject } from '../src/modules/storage';

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

const OTHER = {
  legalName: 'Other Brands Private Limited',
  brandName: 'Other',
  billingEmail: 'accounts@other.example',
};

const OTHER_USER = {
  email: 'buyer@other.example',
  fullName: 'Other Buyer',
};

const PASSWORD = 'advertiser-password-long-enough';

const DRAFT = {
  name: 'Summer Sale',
  brandName: 'Zephyr',
  city: 'Bengaluru',
  vehicleType: 'CAB',
  startDate: '2026-09-01',
  endDate: '2026-09-14',
  zonePrimeKm: '4000',
  zoneSecondaryKm: '15000',
};

class MemoryStore implements ObjectStore {
  private readonly files = new Map<string, StoredObject>();

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    this.files.set(key, { bytes, contentType });
  }

  async get(key: string): Promise<StoredObject | null> {
    return this.files.get(key) ?? null;
  }
}

let reachable = false;
let inbox: MailInbox;

beforeAll(async () => {
  reachable = await pingDatabase().then(
    () => true,
    () => false,
  );
  if (!reachable) {
    console.warn('\n  report tests skipped: no database reachable at DATABASE_URL\n');
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
  setObjectStoreForTests(new MemoryStore());
  await sequelize.query(
    'TRUNCATE users, user_sessions, user_invitations, audit_log, advertisers, campaigns, notifications, report_exports RESTART IDENTITY CASCADE',
  );
});

afterEach(() => {
  inbox?.restore();
  setObjectStoreForTests(undefined);
});

async function signInAdvertiser(
  advertiser = ADVERTISER,
  user = ADVERTISER_USER,
): Promise<Agent> {
  const admin = await signIn();
  await admin.post('/v1/admin/advertisers').send({ ...advertiser, user }).expect(201);
  await client()
    .post(`/v1/invitations/${inbox.tokenFor(user.email)}/accept`)
    .send({ password: PASSWORD })
    .expect(200);

  const portal = client();
  await portal.post('/v1/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);
  return portal;
}

describe('advertiser reports', () => {
  it('builds a proof pack and serves it from recent exports', async () => {
    const portal = await signInAdvertiser();
    const created = await portal.post('/v1/campaigns').send(DRAFT).expect(201);

    const exported = await portal
      .post('/v1/reports/export')
      .send({
        type: 'proof-pack',
        campaignId: created.body.id,
        from: '2026-09-01',
        to: '2026-09-14',
      })
      .expect(201);

    expect(exported.body.type).toBe('proof-pack');
    expect(exported.body.format).toBe('html');
    expect(exported.body.status).toBe('ready');
    expect(exported.body.campaignName).toBe('Summer Sale');
    expect(exported.body.fileName).toMatch(/MoveAd-proof-pack-summer-sale/);
    expect(exported.body.checksum).toMatch(/^[a-f0-9]{64}$/);

    const list = await portal.get('/v1/reports').expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].id).toBe(exported.body.id);

    const file = await portal.get(`/v1/reports/${exported.body.id}/download`).expect(200);
    expect(file.headers['content-type']).toMatch(/text\/html/);
    expect(file.headers['content-disposition']).toMatch(/attachment;/);
    expect(file.text).toContain('Summer Sale');
    expect(file.text).toContain('they do not change the charge');
  });

  it('exports the four CSVs with the documented headers', async () => {
    const portal = await signInAdvertiser();
    const created = await portal.post('/v1/campaigns').send(DRAFT).expect(201);

    const types = ['billing-statement', 'zone-summary', 'vehicle-summary', 'km-detail'] as const;
    const headers = {
      'billing-statement': 'line,campaign,period_from',
      'zone-summary': 'zone,verified_km,charged_inr,modelled_impressions',
      'vehicle-summary': 'vehicle,verified_km,prime_km',
      'km-detail': 'date_ist,started_at,ended_at,vehicle,zone',
    };

    for (const type of types) {
      const exported = await portal
        .post('/v1/reports/export')
        .send({
          type,
          campaignId: created.body.id,
          from: '2026-09-01',
          to: '2026-09-14',
          format: 'csv',
        })
        .expect(201);

      expect(exported.body.format).toBe('csv');
      const file = await portal.get(`/v1/reports/${exported.body.id}/download`).expect(200);
      expect(file.text.startsWith(headers[type])).toBe(true);
    }
  });

  it('does not find another advertiser’s campaign', async () => {
    const admin = await signIn();
    await admin.post('/v1/admin/advertisers').send({ ...ADVERTISER, user: ADVERTISER_USER }).expect(201);
    await client()
      .post(`/v1/invitations/${inbox.tokenFor(ADVERTISER_USER.email)}/accept`)
      .send({ password: PASSWORD })
      .expect(200);
    const owner = client();
    await owner.post('/v1/auth/login').send({ email: ADVERTISER_USER.email, password: PASSWORD }).expect(200);
    const created = await owner.post('/v1/campaigns').send(DRAFT).expect(201);

    await admin.post('/v1/admin/advertisers').send({ ...OTHER, user: OTHER_USER }).expect(201);
    await client()
      .post(`/v1/invitations/${inbox.tokenFor(OTHER_USER.email)}/accept`)
      .send({ password: PASSWORD })
      .expect(200);
    const other = client();
    await other.post('/v1/auth/login').send({ email: OTHER_USER.email, password: PASSWORD }).expect(200);

    await other
      .post('/v1/reports/export')
      .send({
        type: 'zone-summary',
        campaignId: created.body.id,
        from: '2026-09-01',
        to: '2026-09-14',
      })
      .expect(404);

    await other.get(`/v1/reports/${created.body.id}/download`).expect(404);
  });

  it('refuses a period that ends before it starts', async () => {
    const portal = await signInAdvertiser();
    const created = await portal.post('/v1/campaigns').send(DRAFT).expect(201);

    await portal
      .post('/v1/reports/export')
      .send({
        type: 'zone-summary',
        campaignId: created.body.id,
        from: '2026-09-14',
        to: '2026-09-01',
      })
      .expect(400);
  });
});
