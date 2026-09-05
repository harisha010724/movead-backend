import { timingSafeEqual } from 'node:crypto';

import jwt from 'jsonwebtoken';
import { UniqueConstraintError } from 'sequelize';

import { sequelize } from '../../db/sequelize';
import { config } from '../../shared/config';
import {
  ConflictError,
  ForbiddenError,
  LockedError,
  NotFoundError,
  UnauthenticatedError,
  UnprocessableError,
} from '../../shared/errors';
import { loggerFor } from '../../shared/logger';
import * as audit from '../audit/audit.service';
import * as invitations from '../invitations/invitations.service';
import * as mail from '../mail/mail.service';

import {
  burnPasswordTime,
  checkTotp,
  createSessionToken,
  createTotpEnrolment,
  decryptSecret,
  encryptSecret,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from './credentials';
import { type SessionAudience, type User, type UserSession } from './identity.model';
import * as repo from './identity.repository';

const log = loggerFor('identity');

/**
 * Admin and advertiser authentication.
 *
 * The shape of the login flow is set by architecture Part 12.1: email and
 * password, then mandatory TOTP for admin, then an httpOnly cookie. It is two
 * requests rather than one because the second factor cannot be collected until
 * the first has been accepted, and because a failed password must not reveal
 * whether the account has MFA configured.
 */

const MFA_CHALLENGE_AUDIENCE = 'movead-mfa';
const MFA_CHALLENGE_TTL_SECONDS = 300;

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  status: string;
  audience: SessionAudience;
  advertiserId: string | null;
  driverId: string | null;
  /** The advertiser's brand name, the driver's name, or the platform for staff. */
  organisationName: string;
  mfaEnabled: boolean;
  roles: string[];
  permissions: string[];
  lastLoginAt: string | null;
}

// ------------------------------------------------------------------ bootstrap

/**
 * Creates the first Super Admin. There is no other way in: no self-signup, no
 * seeded default password, no account that exists before someone asks for one.
 *
 * Two independent guards. The caller must present `ADMIN_BOOTSTRAP_TOKEN`, and
 * the platform must have no users at all — so the endpoint stops working the
 * moment it has been used, whether or not the token is later rotated.
 */
export async function bootstrapFirstAdmin(input: {
  token: string;
  email: string;
  fullName: string;
  password: string;
  ip: string | null;
}): Promise<AuthenticatedUser> {
  const expected = config.admin.bootstrapToken;
  if (!expected || !constantTimeEquals(input.token, expected)) {
    throw new ForbiddenError('Bootstrap token is not valid.');
  }

  if ((await repo.countUsers()) > 0) {
    throw new ConflictError(
      'The platform already has a user. Create further admins through POST /v1/admin/users.',
    );
  }

  const user = await sequelize.transaction(async (transaction) => {
    const created = await repo.createUser(
      {
        email: input.email,
        fullName: input.fullName,
        passwordHash: await hashPassword(input.password),
        status: 'ACTIVE',
      },
      transaction,
    );

    await repo.grantRole(created.id, 'SUPER_ADMIN', null, transaction);
    await audit.record(
      {
        action: 'admin.bootstrapped',
        entityType: 'user',
        entityId: created.id,
        after: { email: created.email, fullName: created.fullName },
        actorUserId: null,
        ip: input.ip,
      },
      transaction,
    );

    return created;
  });

  log.warn({ userId: user.id, email: user.email }, 'first super admin created');
  return describe(user);
}

/** Creating any admin after the first. Guarded by `user.create` on the route. */
export async function createStaffUser(input: {
  email: string;
  fullName: string;
  password: string;
  roleKey: string;
  createdBy: string;
  ip: string | null;
}): Promise<AuthenticatedUser> {
  const user = await sequelize.transaction(async (transaction) => {
    const created = await repo.createUser(
      {
        email: input.email,
        fullName: input.fullName,
        passwordHash: await hashPassword(input.password),
        status: 'ACTIVE',
      },
      transaction,
    );

    await repo.grantRole(created.id, input.roleKey, input.createdBy, transaction);
    await audit.record(
      {
        action: 'user.created',
        entityType: 'user',
        entityId: created.id,
        after: { email: created.email, fullName: created.fullName, role: input.roleKey },
        actorUserId: input.createdBy,
        ip: input.ip,
      },
      transaction,
    );

    return created;
  });

  return describe(user);
}

// ------------------------------------------------------- correcting a user

export interface UserChanges {
  fullName?: string;
  email?: string;
}

export interface EmailChangeOutcome {
  previousEmail: string;
  /**
   * True when the account had not been used yet, so the change reissued the
   * invitation instead of moving a live login.
   */
  invitationResent: boolean;
  /** Whether the resulting message — the new invitation, or the warning to the
   * old address — actually left the building. */
  delivered: boolean;
}

export interface UpdatedUser {
  id: string;
  email: string;
  fullName: string;
  status: string;
  invitationExpiresAt: string | null;
  /** Null when the address was not touched. */
  emailChange: EmailChangeOutcome | null;
}

/**
 * Corrects a person's name, and where necessary the address they sign in with.
 *
 * The name is trivial. The address is not: it is half of their credential and
 * the destination of anything the platform sends them, so changing it is a
 * security event and is treated as one. What happens depends on whether the
 * account has ever been used.
 *
 * **Not yet accepted.** Nobody has signed in and the invitation went to an
 * address that turns out to be wrong — the whole point of this operation. The
 * old invitation is voided and a new one is sent to the corrected address, so
 * the wrong mailbox is left holding a dead link.
 *
 * **In use.** The password is untouched and still works, but every session
 * ends, and the *old* address is told what happened. That direction matters:
 * repointing an account is how a takeover is completed, and the mailbox losing
 * access is the only party who might not already know.
 *
 * A suspended account is refused outright. Changing how a disabled account
 * signs in has no visible effect and prepares one that does.
 */
export async function updateUserProfile(input: {
  userId: string;
  changes: UserChanges;
  actorUserId: string;
  actorName: string;
  ip: string | null;
}): Promise<UpdatedUser> {
  const user = await repo.findUserById(input.userId);
  if (!user) throw new NotFoundError('User');

  const before = { email: user.email, fullName: user.fullName };
  const emailChanging = input.changes.email !== undefined && input.changes.email !== user.email;

  if (emailChanging && user.status !== 'INVITED' && user.status !== 'ACTIVE') {
    throw new UnprocessableError(
      'account_not_editable',
      'Reinstate the account before changing the address it signs in with.',
    );
  }

  if (input.changes.fullName !== undefined) user.fullName = input.changes.fullName;
  if (emailChanging && input.changes.email !== undefined) user.email = input.changes.email;

  const nameChanged = user.fullName !== before.fullName;
  if (!nameChanged && !emailChanging) return describeUpdated(user, null);

  const wasInvited = user.status === 'INVITED';

  await user.save().catch((error: unknown) => {
    if (error instanceof UniqueConstraintError) {
      throw new ConflictError('That email address is already registered.', { fields: ['email'] });
    }
    throw error;
  });

  await audit.record({
    action: 'user.updated',
    entityType: 'user',
    entityId: user.id,
    before: emailChanging ? before : { fullName: before.fullName },
    after: emailChanging
      ? { email: user.email, fullName: user.fullName }
      : { fullName: user.fullName },
    actorUserId: input.actorUserId,
    ip: input.ip,
  });

  if (!emailChanging) return describeUpdated(user, null);

  const outcome = wasInvited
    ? await reinvite(user, before.email, input.actorUserId, input.actorName)
    : await warnPreviousAddress(user, before.email, input.actorName);

  return describeUpdated(user, outcome);
}

/** The invitation follows the address, so the wrong mailbox is left a dead link. */
async function reinvite(
  user: User,
  previousEmail: string,
  actorUserId: string,
  actorName: string,
): Promise<EmailChangeOutcome> {
  const issued = await invitations.issue({ userId: user.id, createdBy: actorUserId });

  const delivered = await invitations.deliver({
    user,
    token: issued.token,
    expiresAt: issued.expiresAt,
    invitedBy: actorName,
  });

  return { previousEmail, invitationResent: true, delivered };
}

async function warnPreviousAddress(
  user: User,
  previousEmail: string,
  actorName: string,
): Promise<EmailChangeOutcome> {
  // Sessions first. If the notice fails to send the account has still been
  // secured; the other order leaves a window open in the case that matters.
  await repo.revokeAllSessionsFor(user.id, 'email_changed');

  const delivered = await mail.sendEmailChanged({
    fullName: user.fullName,
    previousEmail,
    newEmail: user.email,
    organisation: (await repo.organisationNameFor(user.advertiserId)) ?? 'MoveAd',
    changedBy: actorName,
    supportEmail: config.mail.replyTo,
  });

  return { previousEmail, invitationResent: false, delivered };
}

async function describeUpdated(
  user: User,
  emailChange: EmailChangeOutcome | null,
): Promise<UpdatedUser> {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
    invitationExpiresAt: await invitations.liveExpiryFor(user.id),
    emailChange,
  };
}

// ---------------------------------------------------------------------- login

/**
 * What the password step can produce.
 *
 * `authenticated` exists because architecture Part 12.1 makes TOTP mandatory
 * for admin and merely available to an advertiser. An advertiser without an
 * authenticator is signed in by the password alone; an admin never is,
 * whatever state their account is in.
 *
 * `audience` is on every branch because one login page serves both portals and
 * has to know where to send the browser next.
 */
export type LoginOutcome =
  | { status: 'mfa_required'; audience: SessionAudience; challengeToken: string }
  | { status: 'mfa_enrolment_required'; audience: SessionAudience; challengeToken: string }
  | { status: 'authenticated'; audience: SessionAudience; issued: SessionIssued };

/**
 * Email and password, with the lockout and the timing defence. Shared by the
 * portal login and the driver app's, because the guards around a password are
 * the part that must not differ between two doors into the same account.
 *
 * Returns the user on success; every failure throws.
 */
async function verifyCredentials(input: {
  email: string;
  password: string;
  ip: string | null;
}): Promise<User> {
  const user = await repo.findUserByEmail(input.email);

  if (!user) {
    // Hash something anyway. Returning in a millisecond for an unknown address
    // and in eighty for a known one is an account enumeration oracle.
    await burnPasswordTime(input.password);
    throw new UnauthenticatedError('Email or password is incorrect.');
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new LockedError('Too many failed attempts. Try again later.', {
      until: user.lockedUntil.toISOString(),
    });
  }

  if (!(await verifyPassword(user.passwordHash, input.password))) {
    await registerFailure(user, 'password', input.ip);
    throw new UnauthenticatedError('Email or password is incorrect.');
  }

  // Status is checked after the password so a suspended account cannot be
  // distinguished from a wrong one without knowing the password.
  if (user.status !== 'ACTIVE') {
    throw new ForbiddenError('This account is not active. Contact the platform team.');
  }

  return user;
}

export async function login(input: {
  email: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<LoginOutcome> {
  const user = await verifyCredentials(input);
  const audience = user.audience;

  // The build-time escape hatch. Deliberately ahead of the `totpEnabledAt`
  // check: an account enrolled by an earlier run would otherwise still be asked
  // for a code, which is precisely the prompt this is meant to remove. The
  // secret stays on the row untouched, so re-enabling the flag restores the
  // second factor without anyone re-enrolling.
  if (audience === 'admin' && !config.totp.adminRequired) {
    return {
      status: 'authenticated',
      audience,
      issued: await issueSession(user, { ip: input.ip, userAgent: input.userAgent }),
    };
  }

  if (user.totpEnabledAt) {
    return { status: 'mfa_required', audience, challengeToken: issueMfaChallenge(user.id) };
  }

  // Admin MFA is mandatory, so an unenrolled admin is sent to enrol rather than
  // let through. An advertiser has no such requirement and is signed in here.
  if (audience === 'admin') {
    return {
      status: 'mfa_enrolment_required',
      audience,
      challengeToken: issueMfaChallenge(user.id),
    };
  }

  return {
    status: 'authenticated',
    audience,
    issued: await issueSession(user, { ip: input.ip, userAgent: input.userAgent }),
  };
}

/**
 * Step two of first login. Generates the secret and stores it encrypted but
 * *not* enabled — enrolment only completes when a code proves the authenticator
 * actually holds it, so a half-finished enrolment cannot lock anyone out.
 */
export async function beginTotpEnrolment(challengeToken: string): Promise<{
  secret: string;
  otpauthUri: string;
}> {
  const user = await userFromChallenge(challengeToken);

  if (user.totpEnabledAt) {
    throw new ConflictError('This account already has an authenticator configured.');
  }

  const enrolment = createTotpEnrolment(user.email);
  user.totpSecretEnc = encryptSecret(enrolment.secret);
  await user.save();

  return enrolment;
}

export interface SessionIssued {
  token: string;
  session: UserSession;
  user: AuthenticatedUser;
}

/** Step three: the code. On success the session cookie is issued. */
export async function verifyMfaAndCreateSession(input: {
  challengeToken: string;
  code: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<SessionIssued> {
  const user = await userFromChallenge(input.challengeToken);

  if (!user.totpSecretEnc) {
    throw new UnprocessableError(
      'mfa_enrolment_required',
      'Set up an authenticator app before signing in.',
    );
  }

  if (!(await checkTotp(decryptSecret(user.totpSecretEnc), input.code))) {
    await registerFailure(user, 'totp', input.ip);
    throw new UnauthenticatedError('That code is not valid.');
  }

  const firstUse = user.totpEnabledAt === null;

  if (firstUse) {
    // Enrolment completes here rather than at `mfa/enrol`, so a secret that was
    // generated but never proven cannot lock anyone out of their own account.
    user.totpEnabledAt = new Date();
    await user.save();

    await audit.record({
      action: 'user.mfa_enrolled',
      entityType: 'user',
      entityId: user.id,
      actorUserId: user.id,
      ip: input.ip,
    });
  }

  return issueSession(user, { ip: input.ip, userAgent: input.userAgent });
}

/**
 * The last step of every successful sign-in, whichever route reached it: clear
 * the failure counters, stamp the login, and create the server-side session.
 */
async function issueSession(
  user: User,
  context: { ip: string | null; userAgent: string | null },
): Promise<SessionIssued> {
  const now = new Date();

  user.lastLoginAt = now;
  user.failedAttempts = 0;
  user.lockedUntil = null;
  await user.save();

  const { token, hash } = createSessionToken();
  const session = await repo.createSession({
    userId: user.id,
    tokenHash: hash,
    audience: user.audience,
    expiresAt: new Date(now.getTime() + config.session.absoluteHours * 3_600_000),
    ip: context.ip,
    userAgent: context.userAgent,
  });

  await audit.record({
    action: 'user.logged_in',
    entityType: 'user',
    entityId: user.id,
    after: { sessionId: session.id, audience: session.audience },
    actorUserId: user.id,
    ip: context.ip,
  });

  return { token, session, user: await describe(user) };
}

// ------------------------------------------------- driver mobile identity

/**
 * The driver app's credentials.
 *
 * Two tokens rather than one cookie. The access token is a signed JWT the app
 * holds in memory for fifteen minutes; the refresh token is opaque, lives in
 * the Keystore, and rotates every time it is used. A device compromise at rest
 * therefore yields a refresh token that stops working the moment the real
 * device next refreshes, and nothing that is usable for longer than that.
 */
export interface MobileTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

export interface MobileSignIn {
  tokens: MobileTokens;
  user: AuthenticatedUser;
}

/**
 * Sign-in for the driver app, with the emailed username and password.
 *
 * Only driver accounts. An advertiser or admin with valid credentials is
 * refused here rather than handed a token the API would reject on every
 * subsequent call — WEB-001 applies to the app as much as to the portals, and
 * a refusal that names the reason is easier to act on than a silent 401 loop.
 */
export async function driverMobileLogin(input: {
  email: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<MobileSignIn> {
  const user = await verifyCredentials(input);

  if (user.audience !== 'driver') {
    throw new ForbiddenError('This app is for drivers. Use the web portal for that account.');
  }

  /*
   * Unreachable today: nothing enrols a driver in TOTP, and admin is the only
   * audience for which it is mandatory. It is here so that the day a driver
   * does have an authenticator, the app refuses rather than quietly skipping
   * the factor — a second factor the mobile client cannot collect must not
   * become a second factor the mobile client is exempt from.
   */
  if (user.totpEnabledAt) {
    throw new UnprocessableError(
      'mfa_not_supported',
      'This account uses an authenticator app. Sign in on the driver web portal.',
    );
  }

  return issueMobileSession(user, { ip: input.ip, userAgent: input.userAgent });
}

/**
 * Exchanges a refresh token for a new pair, rotating it in the process.
 *
 * The old token stops working here, so a stolen copy is good for one use at
 * most and only until the real device refreshes. Replaying a rotated token
 * fails the hash lookup and reads as an ordinary expiry; distinguishing theft
 * from a dropped response needs a token-family history this does not keep.
 */
export async function refreshDriverMobileSession(
  refreshToken: string,
  context: { ip: string | null },
): Promise<MobileTokens> {
  const session = await repo.findLiveSession(hashSessionToken(refreshToken));

  if (!session || session.client !== 'mobile' || session.audience !== 'driver') {
    throw new UnauthenticatedError('Sign in again.');
  }

  const now = new Date();

  if (session.expiresAt <= now) {
    await repo.revokeSession(session.id, 'expired');
    throw new UnauthenticatedError('Sign in again.');
  }

  const user = await repo.findUserById(session.userId);
  if (!user || user.status !== 'ACTIVE') {
    await repo.revokeSession(session.id, 'user_not_active');
    throw new UnauthenticatedError('Sign in again.');
  }

  const { token, hash } = createSessionToken();
  const expiresAt = new Date(now.getTime() + config.jwt.refreshTtlSeconds * 1000);
  await repo.rotateSessionToken(session.id, hash, expiresAt, now);

  log.debug({ userId: user.id, sessionId: session.id, ip: context.ip }, 'driver token refreshed');

  return {
    accessToken: signDriverAccessToken(user.id, session.id),
    refreshToken: token,
    expiresIn: config.jwt.accessTtlSeconds,
  };
}

async function issueMobileSession(
  user: User,
  context: { ip: string | null; userAgent: string | null },
): Promise<MobileSignIn> {
  const now = new Date();

  user.lastLoginAt = now;
  user.failedAttempts = 0;
  user.lockedUntil = null;
  await user.save();

  const { token, hash } = createSessionToken();
  const session = await repo.createSession({
    userId: user.id,
    tokenHash: hash,
    audience: 'driver',
    client: 'mobile',
    // The refresh token's life, not the portal's twelve hours. A driver whose
    // app is open through a shift and reopened the next morning is the normal
    // case, not a session that has overstayed.
    expiresAt: new Date(now.getTime() + config.jwt.refreshTtlSeconds * 1000),
    ip: context.ip,
    userAgent: context.userAgent,
  });

  await audit.record({
    action: 'user.logged_in',
    entityType: 'user',
    entityId: user.id,
    after: { sessionId: session.id, audience: session.audience, client: 'mobile' },
    actorUserId: user.id,
    ip: context.ip,
  });

  return {
    tokens: {
      accessToken: signDriverAccessToken(user.id, session.id),
      refreshToken: token,
      expiresIn: config.jwt.accessTtlSeconds,
    },
    user: await describe(user),
  };
}

/**
 * The access token names the session it belongs to rather than carrying the
 * user's roles, so revoking the session still takes effect on the next request
 * instead of at expiry. That costs the same lookup the cookie already does.
 */
function signDriverAccessToken(userId: string, sessionId: string): string {
  return jwt.sign({ sub: userId, sid: sessionId }, config.jwt.accessSecret, {
    issuer: config.jwt.issuer,
    audience: config.jwt.audience.driver,
    expiresIn: config.jwt.accessTtlSeconds,
  });
}

/**
 * Validates a bearer access token. The mirror of `authenticate` for the app.
 *
 * The signature only proves the token was minted here; whether the session
 * behind it is still alive is a database question, and asking it is what makes
 * "sign this driver out now" mean now.
 */
export async function authenticateBearer(
  accessToken: string,
  audience: SessionAudience,
): Promise<ActiveSession> {
  // Only the driver app has tokens. Presenting one to an admin route is not a
  // permission problem to be reported, it is a door that does not exist.
  if (audience !== 'driver') throw new UnauthenticatedError();

  let payload: jwt.JwtPayload;

  try {
    payload = jwt.verify(accessToken, config.jwt.accessSecret, {
      issuer: config.jwt.issuer,
      audience: config.jwt.audience.driver,
    }) as jwt.JwtPayload;
  } catch {
    throw new UnauthenticatedError('Your session has ended. Sign in again.');
  }

  const sessionId = typeof payload.sid === 'string' ? payload.sid : null;
  if (!sessionId) throw new UnauthenticatedError();

  const session = await repo.findLiveSessionById(sessionId);
  if (!session || session.audience !== 'driver') throw new UnauthenticatedError();

  return liveSession(session, new Date());
}

// -------------------------------------------------------------- session usage

export interface ActiveSession {
  session: UserSession;
  user: AuthenticatedUser;
}

/**
 * Validates the cookie on every request. Server-side rather than a
 * self-contained token, which is what makes "sign this admin out now" and
 * "suspend this account now" take effect immediately rather than at expiry.
 */
export async function authenticate(
  token: string,
  audience: SessionAudience,
): Promise<ActiveSession> {
  const session = await repo.findLiveSession(hashSessionToken(token));
  if (!session) throw new UnauthenticatedError();

  // WEB-001: an advertiser session presented to an admin endpoint is rejected
  // here, before any permission is looked at.
  if (session.audience !== audience) throw new UnauthenticatedError();

  // A refresh token is not a credential for the API. Without this, the value
  // the app stores on disk for sixty days would also open every driver route,
  // which is the entire property the short access token exists to provide.
  if (session.client !== 'web') throw new UnauthenticatedError();

  return liveSession(session, new Date());
}

/**
 * The checks every session passes on every request, whichever way it arrived.
 *
 * Idle timeout is the one rule that does not apply to both. It exists for a
 * browser left open on an unattended desk; a phone in a driver's pocket is not
 * that, and enforcing it there would end a session mid-shift on the strength
 * of a quiet hour.
 */
async function liveSession(session: UserSession, now: Date): Promise<ActiveSession> {
  if (session.expiresAt <= now) {
    await repo.revokeSession(session.id, 'expired');
    throw new UnauthenticatedError('Your session has ended. Sign in again.');
  }

  if (session.client === 'web') {
    const idleMinutes =
      session.audience === 'admin'
        ? config.session.adminIdleMinutes
        : config.session.advertiserIdleMinutes;

    if (now.getTime() - session.lastSeenAt.getTime() > idleMinutes * 60_000) {
      await repo.revokeSession(session.id, 'idle_timeout');
      throw new UnauthenticatedError('You were signed out after a period of inactivity.');
    }
  }

  const user = await repo.findUserById(session.userId);
  if (!user || user.status !== 'ACTIVE') {
    await repo.revokeSession(session.id, 'user_not_active');
    throw new UnauthenticatedError();
  }

  // Sliding expiry, written at most once a minute. Updating on every request
  // would turn a read-heavy dashboard into a write-heavy one for no benefit.
  if (now.getTime() - session.lastSeenAt.getTime() > 60_000) {
    await repo.touchSession(session.id, now);
    session.lastSeenAt = now;
  }

  return { session, user: await describe(user) };
}

export async function logout(sessionId: string, userId: string, ip: string | null): Promise<void> {
  await repo.revokeSession(sessionId, 'signed_out');
  await audit.record({
    action: 'user.logged_out',
    entityType: 'user',
    entityId: userId,
    actorUserId: userId,
    ip,
  });
}

// -------------------------------------------------------------------- helpers

const PLATFORM_NAME = 'MoveAd Operations';

async function describe(user: User): Promise<AuthenticatedUser> {
  const [roles, permissions, organisation] = await Promise.all([
    repo.roleKeysFor(user.id),
    repo.permissionsFor(user.id),
    repo.organisationNameFor(user.advertiserId),
  ]);

  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
    audience: user.audience,
    advertiserId: user.advertiserId,
    driverId: user.driverId,
    organisationName: organisation ?? (user.driverId ? user.fullName : PLATFORM_NAME),
    mfaEnabled: user.totpEnabledAt !== null,
    roles,
    permissions,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}

function issueMfaChallenge(userId: string): string {
  return jwt.sign({ sub: userId, purpose: 'mfa' }, config.jwt.accessSecret, {
    issuer: config.jwt.issuer,
    audience: MFA_CHALLENGE_AUDIENCE,
    expiresIn: MFA_CHALLENGE_TTL_SECONDS,
  });
}

async function userFromChallenge(token: string): Promise<User> {
  let payload: jwt.JwtPayload;

  try {
    payload = jwt.verify(token, config.jwt.accessSecret, {
      issuer: config.jwt.issuer,
      audience: MFA_CHALLENGE_AUDIENCE,
    }) as jwt.JwtPayload;
  } catch {
    throw new UnauthenticatedError('That sign-in attempt expired. Start again.');
  }

  const user = payload.sub ? await repo.findUserById(payload.sub) : null;
  if (!user || user.status !== 'ACTIVE') throw new UnauthenticatedError();

  return user;
}

/**
 * Counts a wrong password or a wrong code against the same budget, because an
 * attacker who has the password still only gets a handful of guesses at the
 * second factor.
 */
async function registerFailure(
  user: User,
  factor: 'password' | 'totp',
  ip: string | null,
): Promise<void> {
  user.failedAttempts += 1;

  const locked = user.failedAttempts >= config.login.maxAttempts;
  if (locked) {
    user.lockedUntil = new Date(Date.now() + config.login.lockMinutes * 60_000);
    user.failedAttempts = 0;
  }

  await user.save();

  await audit.record({
    action: locked ? 'user.locked_out' : 'user.login_failed',
    entityType: 'user',
    entityId: user.id,
    after: { factor },
    actorUserId: null,
    ip,
  });
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
