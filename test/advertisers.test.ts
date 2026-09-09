import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';

import { ADMIN, type Agent, client, signIn } from './helpers/admin';
import { captureMail, type MailInbox } from './helpers/mail';

/**
 * Advertiser accounts, their portal logins, and the boundary between the two
 * audiences.
 *
 * The boundary is the reason this file exists. One login page now serves both
 * portals, so the only thing keeping an advertiser out of the admin API is that
 * the session is stamped with an audience and every admin route checks it
 * (WEB-001). That is worth asserting rather than assuming.
 */

const ADVERTISER = {
  legalName: 'Zephyr Beverages Private Limited',
  brandName: 'Zephyr',
  billingEmail: 'accounts@zephyr.example',
};

const ADVERTISER_USER = {
  email: 'buyer@zephyr.example',
  fullName: 'Zephyr Buyer',
};

/** Chosen by the customer on the set-password page, never sent to them. */
const CHOSEN_PASSWORD = 'advertiser-password-long-enough';

let reachable = false;
let inbox: MailInbox;

beforeAll(async () => {
  reachable = await pingDatabase().then(
    () => true,
    () => false,
  );

  if (!reachable) {
    console.warn('\n  advertiser tests skipped: no database reachable at DATABASE_URL\n');
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
    'TRUNCATE users, user_sessions, audit_log, advertisers RESTART IDENTITY CASCADE',
  );
});

afterEach(() => {
  inbox?.restore();
});

/**
 * The whole of AC-32.2 as a customer experiences it: an admin creates the
 * account and its first login, MoveAd emails a link, and the customer follows
 * it and chooses a password. The token comes out of the email because that is
 * the only place it exists in usable form.
 */
async function onboardAdvertiser(admin: Agent): Promise<string> {
  const created = await admin
    .post('/v1/admin/advertisers')
    .send({ ...ADVERTISER, user: ADVERTISER_USER })
    .expect(201);

  await acceptInvitation(ADVERTISER_USER.email);
  return String(created.body.advertiser.id);
}

async function primaryUserId(admin: Agent): Promise<string> {
  const list = await admin.get('/v1/admin/advertisers').expect(200);
  return String(list.body[0].primaryUser.id);
}

async function acceptInvitation(email: string, password = CHOSEN_PASSWORD): Promise<void> {
  await client()
    .post(`/v1/invitations/${inbox.tokenFor(email)}/accept`)
    .send({ password })
    .expect(200);
}

describe('advertiser onboarding', () => {
  it('creates an account in ONBOARDING, not ACTIVE', async () => {
    const admin = await signIn();

    const response = await admin.post('/v1/admin/advertisers').send(ADVERTISER);

    expect(response.status).toBe(201);
    // An advertiser is not active because someone typed their name in. They
    // are active when their wallet is funded.
    expect(response.body.advertiser.status).toBe('ONBOARDING');
    expect(response.body.advertiser.brandName).toBe('Zephyr');
    // No contact was supplied, so there is nobody to invite yet.
    expect(response.body.user).toBeNull();
  });

  it('rejects a malformed GSTIN before it reaches the database', async () => {
    const admin = await signIn();

    const response = await admin
      .post('/v1/admin/advertisers')
      .send({ ...ADVERTISER, gstin: '29ABCDE' });

    expect(response.status).toBe(400);
  });

  it('refuses to create a login for an advertiser that does not exist', async () => {
    const admin = await signIn();

    const response = await admin
      .post('/v1/admin/advertisers/00000000-0000-4000-8000-000000000000/users')
      .send(ADVERTISER_USER);

    expect(response.status).toBe(404);
  });

  it('scopes the new user to the advertiser and grants only advertiser permissions', async () => {
    const admin = await signIn();
    const advertiserId = await onboardAdvertiser(admin);

    const portal = client();
    const login = await portal
      .post('/v1/auth/login')
      .send({ email: ADVERTISER_USER.email, password: CHOSEN_PASSWORD })
      .expect(200);

    const me = await portal.get('/v1/auth/me').expect(200);

    expect(me.body.advertiserId).toBe(advertiserId);
    expect(login.body.audience).toBe('advertiser');
    expect(me.body.roles).toEqual(['ADVERTISER']);
    expect(me.body.permissions).toContain('advertiser.campaign.create');
    // The admin catalogue must not leak across. These are the permissions that
    // approve kilometres and release money.
    expect(me.body.permissions).not.toContain('payout.release');
    expect(me.body.permissions).not.toContain('driver.approve');

    /*
     * The deployed portal is hosted on a different site from the API, so its
     * cookie cannot be relied on. Use a fresh client with no cookie jar and the
     * token returned by login: this is the exact credential the browser sends
     * on `/dashboard/advertiser`.
     */
    expect(typeof login.body.sessionToken).toBe('string');
    const bearerOnly = client().set(
      'Authorization',
      `Bearer ${String(login.body.sessionToken)}`,
    );

    const bearerMe = await bearerOnly.get('/v1/auth/me').expect(200);
    expect(bearerMe.body.advertiserId).toBe(advertiserId);

    // No campaign exists for this new advertiser, so 404 is the truthful
    // dashboard result. The important assertion is that authentication got
    // past the guard and the endpoint did not answer 401.
    const dashboard = await bearerOnly
      .get('/api/v1/dashboard/advertiser')
      .query({ from: '2026-09-09', to: '2026-09-09' });
    expect(dashboard.status).toBe(404);
  });
});

describe('correcting an advertiser', () => {
  it('changes the details it was given and leaves the rest alone', async () => {
    const admin = await signIn();
    const created = await admin
      .post('/v1/admin/advertisers')
      .send({ ...ADVERTISER, gstin: '29AABCZ1234H1ZQ' })
      .expect(201);

    const response = await admin
      .patch(`/v1/admin/advertisers/${String(created.body.advertiser.id)}`)
      .send({ brandName: 'Zephyr Drinks', billingEmail: 'finance@zephyr.example' });

    expect(response.status).toBe(200);
    expect(response.body.brandName).toBe('Zephyr Drinks');
    expect(response.body.billingEmail).toBe('finance@zephyr.example');
    // Untouched by an update that never mentioned them.
    expect(response.body.legalName).toBe(ADVERTISER.legalName);
    expect(response.body.gstin).toBe('29AABCZ1234H1ZQ');
  });

  it('tells null and absent apart, so a tax identifier can be removed', async () => {
    const admin = await signIn();
    const created = await admin
      .post('/v1/admin/advertisers')
      .send({ ...ADVERTISER, gstin: '29AABCZ1234H1ZQ', pan: 'AABCZ1234H' })
      .expect(201);

    const id = String(created.body.advertiser.id);

    const cleared = await admin.patch(`/v1/admin/advertisers/${id}`).send({ gstin: null });

    expect(cleared.status).toBe(200);
    expect(cleared.body.gstin).toBeNull();
    // Absent from the same request, so it survived.
    expect(cleared.body.pan).toBe('AABCZ1234H');
  });

  it('rejects a malformed GSTIN on the way in, as creation does', async () => {
    const admin = await signIn();
    const created = await admin.post('/v1/admin/advertisers').send(ADVERTISER).expect(201);

    const response = await admin
      .patch(`/v1/admin/advertisers/${String(created.body.advertiser.id)}`)
      .send({ gstin: '29ABCDE' });

    expect(response.status).toBe(400);
  });

  it('keeps the primary user on the response, so the row stays whole', async () => {
    const admin = await signIn();
    const advertiserId = await onboardAdvertiser(admin);

    const response = await admin
      .patch(`/v1/admin/advertisers/${advertiserId}`)
      .send({ legalName: 'Zephyr Beverages India Private Limited' })
      .expect(200);

    expect(response.body.primaryUser.email).toBe(ADVERTISER_USER.email);
    // Accepted in onboardAdvertiser, so the invitation is spent.
    expect(response.body.primaryUser.status).toBe('ACTIVE');
  });

  it('records what changed, and nothing when nothing did', async () => {
    const admin = await signIn();
    const created = await admin.post('/v1/admin/advertisers').send(ADVERTISER).expect(201);
    const id = String(created.body.advertiser.id);

    await admin.patch(`/v1/admin/advertisers/${id}`).send({ brandName: 'Zephyr Drinks' }).expect(200);
    // Submitting the form unchanged is an ordinary thing to do, and must not
    // leave an entry claiming a correction was made.
    await admin.patch(`/v1/admin/advertisers/${id}`).send({ brandName: 'Zephyr Drinks' }).expect(200);

    const [entries] = await sequelize.query(
      `SELECT before, after FROM audit_log WHERE action = 'advertiser.updated'`,
    );

    expect(entries).toHaveLength(1);
    const entry = entries[0] as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(entry.before).toEqual({ brandName: 'Zephyr' });
    expect(entry.after).toEqual({ brandName: 'Zephyr Drinks' });
  });

  it('is a 404 for an advertiser that does not exist', async () => {
    const admin = await signIn();

    const response = await admin
      .patch('/v1/admin/advertisers/00000000-0000-4000-8000-000000000000')
      .send({ brandName: 'Nobody' });

    expect(response.status).toBe(404);
  });

  it('refuses an advertiser correcting their own organisation', async () => {
    const admin = await signIn();
    const advertiserId = await onboardAdvertiser(admin);

    const portal = client();
    await portal
      .post('/v1/auth/login')
      .send({ email: ADVERTISER_USER.email, password: CHOSEN_PASSWORD })
      .expect(200);

    const response = await portal
      .patch(`/v1/admin/advertisers/${advertiserId}`)
      .send({ brandName: 'Self Service' });

    expect(response.status).toBe(401);
  });
});

describe('correcting the contact', () => {
  /** Onboards without accepting, so the contact is still INVITED. */
  async function invite(admin: Agent): Promise<string> {
    const created = await admin
      .post('/v1/admin/advertisers')
      .send({ ...ADVERTISER, user: { ...ADVERTISER_USER, email: 'typo@zephyr.example' } })
      .expect(201);

    return String(created.body.user.id);
  }

  it('changes a name without touching anything else', async () => {
    const admin = await signIn();
    const userId = await invite(admin);
    inbox.clear();

    const response = await admin
      .patch(`/v1/admin/users/${userId}`)
      .send({ fullName: 'Zephyr Buyer-Smith' });

    expect(response.status).toBe(200);
    expect(response.body.fullName).toBe('Zephyr Buyer-Smith');
    expect(response.body.email).toBe('typo@zephyr.example');
    // A name is not a credential, so nobody needs telling.
    expect(response.body.emailChange).toBeNull();
    expect(inbox.messages).toHaveLength(0);
  });

  it('sends the invitation to the corrected address and kills the old link', async () => {
    const admin = await signIn();
    const userId = await invite(admin);
    const deadToken = inbox.tokenFor('typo@zephyr.example');

    const response = await admin
      .patch(`/v1/admin/users/${userId}`)
      .send({ email: ADVERTISER_USER.email })
      .expect(200);

    expect(response.body.emailChange).toMatchObject({
      previousEmail: 'typo@zephyr.example',
      invitationResent: true,
      delivered: true,
    });

    // The wrong mailbox is left holding something that does not work.
    const dead = await client().get(`/v1/invitations/${deadToken}`);
    expect(dead.status).toBe(422);
    expect(dead.body.code).toBe('invitation_superseded');

    // And the corrected one works, all the way to a session.
    await acceptInvitation(ADVERTISER_USER.email);
    await client()
      .post('/v1/auth/login')
      .send({ email: ADVERTISER_USER.email, password: CHOSEN_PASSWORD })
      .expect(200);
  });

  it('warns the address that is losing access, not the one gaining it', async () => {
    const admin = await signIn();
    await onboardAdvertiser(admin);
    const userId = await primaryUserId(admin);
    inbox.clear();

    await admin
      .patch(`/v1/admin/users/${userId}`)
      .send({ email: 'moved@zephyr.example' })
      .expect(200);

    // The new mailbox already knows — its owner asked for this. The old one is
    // the only party who might not, and is where a takeover would be noticed.
    const warning = inbox.to(ADVERTISER_USER.email);
    expect(warning.subject).toMatch(/sign-in address/i);
    expect(warning.text).toContain('moved@zephyr.example');
    expect(inbox.messages).toHaveLength(1);
  });

  it('ends every session when a live account moves address', async () => {
    const admin = await signIn();
    await onboardAdvertiser(admin);

    const portal = client();
    await portal
      .post('/v1/auth/login')
      .send({ email: ADVERTISER_USER.email, password: CHOSEN_PASSWORD })
      .expect(200);
    await portal.get('/v1/auth/me').expect(200);

    await admin
      .patch(`/v1/admin/users/${await primaryUserId(admin)}`)
      .send({ email: 'moved@zephyr.example' })
      .expect(200);

    // Whoever was signed in has to prove they still can.
    await portal.get('/v1/auth/me').expect(401);
  });

  it('leaves the password working under the new address', async () => {
    const admin = await signIn();
    await onboardAdvertiser(admin);

    await admin
      .patch(`/v1/admin/users/${await primaryUserId(admin)}`)
      .send({ email: 'moved@zephyr.example' })
      .expect(200);

    // Their password was never MoveAd's to change, so it still works.
    await client()
      .post('/v1/auth/login')
      .send({ email: 'moved@zephyr.example', password: CHOSEN_PASSWORD })
      .expect(200);

    await client()
      .post('/v1/auth/login')
      .send({ email: ADVERTISER_USER.email, password: CHOSEN_PASSWORD })
      .expect(401);
  });

  it('refuses an address that is already registered', async () => {
    const admin = await signIn();
    const userId = await invite(admin);

    // The signed-in admin's own address, which is a user like any other.
    const response = await admin.patch(`/v1/admin/users/${userId}`).send({ email: ADMIN.email });

    expect(response.status).toBe(409);
    // Named, so the dialog can put it under the input that caused it.
    expect(response.body.details.fields).toContain('email');
  });

  it('is a 404 for a user that does not exist', async () => {
    const admin = await signIn();

    const response = await admin
      .patch('/v1/admin/users/00000000-0000-4000-8000-000000000000')
      .send({ fullName: 'Nobody At All' });

    expect(response.status).toBe(404);
  });

  it('refuses an advertiser correcting anybody', async () => {
    const admin = await signIn();
    await onboardAdvertiser(admin);
    const userId = await primaryUserId(admin);

    const portal = client();
    await portal
      .post('/v1/auth/login')
      .send({ email: ADVERTISER_USER.email, password: CHOSEN_PASSWORD })
      .expect(200);

    const response = await portal.patch(`/v1/admin/users/${userId}`).send({ fullName: 'Self Made' });

    expect(response.status).toBe(401);
  });
});

describe('advertiser sign-in', () => {
  it('issues a session from the password alone, because advertiser TOTP is optional', async () => {
    const admin = await signIn();
    await onboardAdvertiser(admin);

    const portal = client();
    const response = await portal
      .post('/v1/auth/login')
      .send({ email: ADVERTISER_USER.email, password: CHOSEN_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('authenticated');
    expect(response.body.audience).toBe('advertiser');

    // Named for the audience, so an admin and an advertiser session can coexist
    // in one browser without overwriting each other.
    const cookie = String((response.headers['set-cookie'] as unknown as string[])[0]);
    expect(cookie).toContain('movead_advertiser_session=');
    expect(cookie).toContain('HttpOnly');
  });

  it('reports the audience so the shared login page knows where to send the browser', async () => {
    const admin = await signIn();
    await onboardAdvertiser(admin);

    const advertiserLogin = await client()
      .post('/v1/auth/login')
      .send({ email: ADVERTISER_USER.email, password: CHOSEN_PASSWORD });

    expect(advertiserLogin.body.audience).toBe('advertiser');
    expect(advertiserLogin.body).not.toHaveProperty('challengeToken');
  });
});

describe('audience isolation (WEB-001)', () => {
  it('refuses an advertiser session on an admin endpoint', async () => {
    const admin = await signIn();
    await onboardAdvertiser(admin);

    const portal = client();
    await portal
      .post('/v1/auth/login')
      .send({ email: ADVERTISER_USER.email, password: CHOSEN_PASSWORD })
      .expect(200);

    // Signed in, and holding a real session — just not this portal's.
    await portal.get('/v1/auth/me').expect(200);

    const drivers = await portal.get('/v1/admin/drivers');

    // 401, not 403: rejected at the audience check before any permission is
    // read, so the endpoint does not even admit to being a thing they lack
    // permission for.
    expect(drivers.status).toBe(401);
  });

  it('refuses an advertiser session presented under the admin cookie name', async () => {
    const admin = await signIn();
    await onboardAdvertiser(admin);

    const portal = client();
    const login = await portal
      .post('/v1/auth/login')
      .send({ email: ADVERTISER_USER.email, password: CHOSEN_PASSWORD })
      .expect(200);

    const raw = String((login.headers['set-cookie'] as unknown as string[])[0]);
    const value = raw.slice(raw.indexOf('=') + 1, raw.indexOf(';'));

    // Renaming the cookie does not change what the session is stamped with.
    const response = await client()
      .get('/v1/admin/drivers')
      .set('Cookie', `movead_admin_session=${value}`);

    expect(response.status).toBe(401);
  });

  it('refuses an advertiser creating an advertiser', async () => {
    const admin = await signIn();
    await onboardAdvertiser(admin);

    const portal = client();
    await portal
      .post('/v1/auth/login')
      .send({ email: ADVERTISER_USER.email, password: CHOSEN_PASSWORD })
      .expect(200);

    const response = await portal.post('/v1/admin/advertisers').send(ADVERTISER);

    expect(response.status).toBe(401);
  });
});
