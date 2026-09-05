import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';

import { pingDatabase, sequelize } from '../src/db/sequelize';
import { renderInvitationEmail } from '../src/modules/mail/mail.service';

import { type Agent, client, signIn } from './helpers/admin';
import { captureMail, failMail, type MailInbox } from './helpers/mail';

/**
 * Onboarding an advertiser, and the invitation that lets them in.
 *
 * The rule under test throughout is that MoveAd never transmits a credential it
 * chose. An admin can create an account and cause an email to be sent; nothing
 * an admin does produces a password the customer must use, and nothing in the
 * message is worth stealing beyond a link that expires and works once.
 */

const ADVERTISER = {
  legalName: 'Zephyr Beverages Private Limited',
  brandName: 'Zephyr',
  billingEmail: 'accounts@zephyr.example',
};

const CONTACT = { email: 'buyer@zephyr.example', fullName: 'Priya Buyer' };
const PASSWORD = 'a-password-they-chose-themselves';

let reachable = false;
let inbox: MailInbox;

beforeAll(async () => {
  reachable = await pingDatabase().then(
    () => true,
    () => false,
  );

  if (!reachable) {
    console.warn('\n  invitation tests skipped: no database reachable at DATABASE_URL\n');
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
    'TRUNCATE users, user_sessions, user_invitations, audit_log, advertisers RESTART IDENTITY CASCADE',
  );
});

afterEach(() => {
  inbox?.restore();
});

function onboard(admin: Agent, overrides: Record<string, unknown> = {}) {
  return admin.post('/v1/admin/advertisers').send({ ...ADVERTISER, user: CONTACT, ...overrides });
}

// ---------------------------------------------------------------- onboarding

describe('onboarding an advertiser with its first login', () => {
  it('creates the organisation and the contact in one call', async () => {
    const admin = await signIn();

    const response = await onboard(admin);

    expect(response.status).toBe(201);
    expect(response.body.advertiser.brandName).toBe('Zephyr');
    expect(response.body.user.email).toBe(CONTACT.email);
    // INVITED, not ACTIVE: there is no password yet, so there is nothing to
    // sign in with even though the row exists.
    expect(response.body.user.status).toBe('INVITED');
    expect(response.body.invitationEmailed).toBe(true);
  });

  it('leaves nothing behind when the email is already registered', async () => {
    const admin = await signIn();
    await onboard(admin).expect(201);

    const clash = await onboard(admin, { legalName: 'Another Company Private Limited' });
    expect(clash.status).toBe(409);
    // Named, so the dialog can put the message under the input that caused it.
    expect(clash.body.details.fields).toContain('email');

    // The second advertiser must not exist. If it does, the two inserts are not
    // in one transaction and the admin is left with an organisation nobody can
    // sign in to — and no obvious way to finish it.
    const list = await admin.get('/v1/admin/advertisers').expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('creates the advertiser alone when no contact is given', async () => {
    const admin = await signIn();

    const response = await admin.post('/v1/admin/advertisers').send(ADVERTISER).expect(201);

    expect(response.body.user).toBeNull();
    expect(response.body.invitationEmailed).toBe(false);
    expect(inbox.messages).toHaveLength(0);
  });

  it('reports the account as created when the mail server is down', async () => {
    const admin = await signIn();
    const restore = failMail();

    try {
      const response = await onboard(admin);

      // The account and the invitation are committed. Rolling them back because
      // SMTP was unreachable would lose everything the admin typed over a fault
      // that a Resend button fixes.
      expect(response.status).toBe(201);
      expect(response.body.user.status).toBe('INVITED');
      expect(response.body.invitationEmailed).toBe(false);
    } finally {
      restore();
    }
  });

  it('shows the contact and the outstanding invitation in the list', async () => {
    const admin = await signIn();
    await onboard(admin).expect(201);

    const list = await admin.get('/v1/admin/advertisers').expect(200);

    expect(list.body[0].primaryUser.email).toBe(CONTACT.email);
    expect(list.body[0].primaryUser.status).toBe('INVITED');
    expect(list.body[0].primaryUser.invitationExpiresAt).toBeTruthy();
  });
});

// --------------------------------------------------------------------- email

describe('the invitation email', () => {
  it('carries the portal, the username and a working link — and no password', async () => {
    const admin = await signIn();
    await onboard(admin).expect(201);

    const message = inbox.to(CONTACT.email);

    expect(message.subject).toContain('Zephyr');
    // The three things the customer needs, and the reason this email exists.
    expect(message.html).toContain(CONTACT.email);
    expect(message.html).toContain('http://localhost:5173');
    expect(message.html).toMatch(/\/invitation\/[A-Za-z0-9_-]{20,}/);
    // Named, so the first message a customer gets is from a person.
    expect(message.html).toContain('Ops Admin');
  });

  it('sends a plain-text alternative as well as HTML', async () => {
    const admin = await signIn();
    await onboard(admin).expect(201);

    const message = inbox.to(CONTACT.email);

    // Not decoration: a message with no text part scores as spam, and some
    // corporate gateways strip HTML outright.
    expect(message.text.length).toBeGreaterThan(200);
    expect(message.text).toContain(CONTACT.email);
    expect(message.text).not.toContain('<div');
  });

  it('escapes a brand name rather than putting it into the document raw', () => {
    const rendered = renderInvitationEmail({
      fullName: 'Priya Buyer',
      email: 'buyer@zephyr.example',
      organisation: '<script>alert(1)</script>',
      acceptUrl: 'http://localhost:5173/invitation/abc',
      portalUrl: 'http://localhost:5173',
      expiresInHours: 72,
      invitedBy: 'Ops Admin',
    });

    // The brand name is typed into an admin form, so it is untrusted input
    // reaching a document — and nobody is watching a console when a customer
    // opens their mail.
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });
});

// ------------------------------------------------------------------ accepting

describe('accepting an invitation', () => {
  async function invited(): Promise<{ admin: Agent; token: string }> {
    const admin = await signIn();
    await onboard(admin).expect(201);
    return { admin, token: inbox.tokenFor(CONTACT.email) };
  }

  it('describes the invitation so the page can greet them', async () => {
    const { token } = await invited();

    const response = await client().get(`/v1/invitations/${token}`).expect(200);

    expect(response.body.email).toBe(CONTACT.email);
    expect(response.body.fullName).toBe(CONTACT.fullName);
    expect(response.body.organisation).toBe('Zephyr');
  });

  it('needs no session, because the whole point is that they have no password', async () => {
    const { token } = await invited();

    // No cookie on this agent at all.
    await client().get(`/v1/invitations/${token}`).expect(200);
  });

  it('sets the password and activates the account', async () => {
    const { token } = await invited();

    const response = await client()
      .post(`/v1/invitations/${token}/accept`)
      .send({ password: PASSWORD })
      .expect(200);

    expect(response.body.audience).toBe('advertiser');

    // The password now works, which is the only proof that matters.
    const portal = client();
    const login = await portal
      .post('/v1/auth/login')
      .send({ email: CONTACT.email, password: PASSWORD })
      .expect(200);

    expect(login.body.status).toBe('authenticated');
    expect(login.body.audience).toBe('advertiser');
  });

  it('cannot be signed into before the invitation is accepted', async () => {
    await invited();

    const attempt = await client()
      .post('/v1/auth/login')
      .send({ email: CONTACT.email, password: PASSWORD });

    // 401, not 403: the password is wrong because nobody has set one. The row
    // holds randomness no human has seen, so an INVITED account is not a
    // guessable account.
    expect(attempt.status).toBe(401);
  });

  it('refuses a short password', async () => {
    const { token } = await invited();

    const response = await client().post(`/v1/invitations/${token}/accept`).send({ password: 'abc' });

    expect(response.status).toBe(400);
  });

  it('works exactly once', async () => {
    const { token } = await invited();
    await client().post(`/v1/invitations/${token}/accept`).send({ password: PASSWORD }).expect(200);

    const again = await client()
      .post(`/v1/invitations/${token}/accept`)
      .send({ password: 'a-completely-different-password' });

    expect(again.status).toBe(422);
    expect(again.body.code).toBe('invitation_used');

    // And the second password did not take.
    await client()
      .post('/v1/auth/login')
      .send({ email: CONTACT.email, password: PASSWORD })
      .expect(200);
  });

  it('refuses a token that was never issued', async () => {
    await invited();

    const response = await client().get('/v1/invitations/not-a-real-token-but-long-enough-to-pass');

    expect(response.status).toBe(404);
  });

  it('refuses an expired invitation with a code the page can act on', async () => {
    const { token } = await invited();

    await sequelize.query("UPDATE user_invitations SET expires_at = now() - interval '1 hour'");

    const response = await client().get(`/v1/invitations/${token}`);

    expect(response.status).toBe(422);
    // Distinct from used and from superseded, because each needs a different
    // sentence in front of a customer.
    expect(response.body.code).toBe('invitation_expired');
  });
});

// ------------------------------------------------------------------ resending

describe('resending an invitation', () => {
  it('issues a new link and emails it', async () => {
    const admin = await signIn();
    const created = await onboard(admin).expect(201);
    const first = inbox.tokenFor(CONTACT.email);

    const response = await admin
      .post(`/v1/admin/users/${String(created.body.user.id)}/resend-invitation`)
      .expect(200);

    expect(response.body.delivered).toBe(true);
    expect(inbox.messages).toHaveLength(2);

    const second = inbox.tokenFor(CONTACT.email);
    expect(second).not.toBe(first);
  });

  it('kills the previous link', async () => {
    const admin = await signIn();
    const created = await onboard(admin).expect(201);
    const first = inbox.tokenFor(CONTACT.email);

    await admin
      .post(`/v1/admin/users/${String(created.body.user.id)}/resend-invitation`)
      .expect(200);

    const stale = await client().get(`/v1/invitations/${first}`);

    // The usual reason to resend is a suspicion the first went astray, so one
    // that keeps working defeats the point. The message says a newer email
    // exists rather than that the link is broken.
    expect(stale.status).toBe(422);
    expect(stale.body.code).toBe('invitation_superseded');

    // The replacement works.
    await client().get(`/v1/invitations/${inbox.tokenFor(CONTACT.email)}`).expect(200);
  });

  it('is refused without permission', async () => {
    const admin = await signIn();
    const created = await onboard(admin).expect(201);

    const anonymous = await client().post(
      `/v1/admin/users/${String(created.body.user.id)}/resend-invitation`,
    );

    expect(anonymous.status).toBe(401);
  });

  it('refuses a user that does not exist', async () => {
    const admin = await signIn();

    const response = await admin.post(
      '/v1/admin/users/00000000-0000-4000-8000-000000000000/resend-invitation',
    );

    expect(response.status).toBe(404);
  });
});

// --------------------------------------------------------------------- audit

describe('the trail', () => {
  it('records who invited them and that they accepted for themselves', async () => {
    const admin = await signIn();
    await onboard(admin).expect(201);
    await client()
      .post(`/v1/invitations/${inbox.tokenFor(CONTACT.email)}/accept`)
      .send({ password: PASSWORD })
      .expect(200);

    const rows = await sequelize.query<{ action: string; actor_user_id: string | null }>(
      "SELECT action, actor_user_id FROM audit_log WHERE action LIKE '%invit%' ORDER BY id",
      { type: 'SELECT' as never },
    );

    const invited = rows.find((row) => row.action === 'advertiser.user_invited');
    const accepted = rows.find((row) => row.action === 'user.invitation_accepted');

    // The admin invited them, and is named for it (AC-31.5).
    expect(invited?.actor_user_id).toBeTruthy();
    // Nobody was signed in when the password was set. Attributing that to the
    // admin would be a lie about who acted.
    expect(accepted).toBeDefined();
    expect(accepted?.actor_user_id).toBeNull();
  });
});
