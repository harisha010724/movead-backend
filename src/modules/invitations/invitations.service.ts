import { createHash, randomBytes } from 'node:crypto';

import { Op, type Transaction } from 'sequelize';

import { sequelize } from '../../db/sequelize';
import { config } from '../../shared/config';
import { NotFoundError, UnprocessableError } from '../../shared/errors';
import * as audit from '../audit/audit.service';
import { generateLoginPassword, hashPassword } from '../identity/credentials';
import { User } from '../identity/identity.model';
import * as identityRepo from '../identity/identity.repository';
import * as mail from '../mail/mail.service';

import { UserInvitation } from './invitations.model';

/**
 * Invitations: how an advertiser who has never had a password gets one.
 *
 * Advertiser accounts never receive a credential MoveAd chose. An admin
 * creates the account; the platform sends a link; the customer picks the
 * password. Migration 009 has the full argument.
 *
 * Drivers are the exception: onboarding emails a generated username and
 * password so they can sign in at once. Resend for a driver user rotates that
 * password and sends it again — it does not issue a set-password token.
 *
 * Invitation tokens are 256 bits of randomness and stored only as a SHA-256
 * digest. They are never logged and never returned by any endpoint that could
 * be reached without the mailbox.
 */

export interface IssuedInvitation {
  token: string;
  expiresAt: Date;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issues a fresh invitation, superseding any that is still live.
 *
 * Superseding matters for the resend case: the usual reason to resend is a
 * suspicion that the first message went somewhere it should not have, and an
 * invitation that stays valid after a replacement was sent defeats the point.
 * A partial unique index enforces the same thing at the database level.
 */
export async function issue(
  input: { userId: string; createdBy: string | null },
  transaction?: Transaction,
): Promise<IssuedInvitation> {
  const run = async (tx: Transaction): Promise<IssuedInvitation> => {
    await UserInvitation.update(
      { revokedAt: new Date() },
      {
        where: { userId: input.userId, acceptedAt: { [Op.is]: null }, revokedAt: { [Op.is]: null } },
        transaction: tx,
      },
    );

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + config.invitations.ttlHours * 3_600_000);

    await UserInvitation.create(
      {
        userId: input.userId,
        tokenHash: hashToken(token),
        expiresAt,
        acceptedAt: null,
        revokedAt: null,
        createdBy: input.createdBy,
      },
      { transaction: tx },
    );

    return { token, expiresAt };
  };

  return transaction ? run(transaction) : sequelize.transaction(run);
}

/** When this user's outstanding invitation lapses, or null if there is none live. */
export async function liveExpiryFor(userId: string): Promise<string | null> {
  const invitation = await UserInvitation.findOne({
    where: { userId, acceptedAt: { [Op.is]: null }, revokedAt: { [Op.is]: null } },
  });

  return invitation?.expiresAt.toISOString() ?? null;
}

type PortalUser = { advertiserId: string | null; driverId?: string | null };

/** The portal an invitation should land on, which follows the account's audience. */
export function acceptUrlFor(user: PortalUser, token: string): string {
  if (user.driverId) return `${config.portals.driver}/invitation/${token}`;
  // Staff still set their password on the advertiser tree, then sign in at
  // `/admin/login`. The page is public and one copy is enough.
  return `${config.portals.advertiser}/invitation/${token}`;
}

export function portalUrlFor(user: PortalUser): string {
  if (user.driverId) return config.portals.driver;
  return user.advertiserId === null ? config.portals.admin : config.portals.advertiser;
}

export interface InvitationDetail {
  email: string;
  fullName: string;
  /** The advertiser's brand name, "MoveAd Driver", or null for staff. */
  organisation: string | null;
  expiresAt: string;
  audience: 'admin' | 'advertiser' | 'driver';
}

/**
 * Resolves a token for the set-password page, which needs to greet the person
 * and show which address they are about to secure.
 *
 * Each failure gets its own code, because they need different sentences. "This
 * link has expired, ask for another" and "you have already set your password,
 * just sign in" are both dead ends, and telling someone the wrong one sends
 * them to support for no reason.
 */
export async function describe(token: string): Promise<InvitationDetail> {
  const { invitation, user } = await resolve(token);

  return {
    email: user.email,
    fullName: user.fullName,
    organisation: user.driverId
      ? 'MoveAd Driver'
      : await identityRepo.organisationNameFor(user.advertiserId),
    expiresAt: invitation.expiresAt.toISOString(),
    audience: user.audience,
  };
}

/**
 * Sets the password the invitation was issued for and activates the account.
 *
 * No session is created here. The caller has just chosen a password and the
 * portal signs in with it immediately, which reuses the login path that already
 * exists — including its lockout, its audience stamping and its cookie naming —
 * rather than growing a second way to mint a session on a public endpoint.
 */
export async function accept(input: {
  token: string;
  password: string;
  ip: string | null;
}): Promise<{ email: string; audience: 'admin' | 'advertiser' | 'driver' }> {
  const { invitation, user } = await resolve(input.token);
  const passwordHash = await hashPassword(input.password);

  await sequelize.transaction(async (transaction) => {
    /*
     * Claim the invitation with a conditional update rather than a read
     * followed by a write. Two tabs submitting the same link at once would
     * otherwise both pass the check above; here the second updates no rows.
     */
    const [claimed] = await UserInvitation.update(
      { acceptedAt: new Date() },
      {
        where: { id: invitation.id, acceptedAt: { [Op.is]: null }, revokedAt: { [Op.is]: null } },
        transaction,
      },
    );

    if (claimed === 0) {
      throw new UnprocessableError(
        'invitation_used',
        'This invitation has already been used. Sign in with your password instead.',
      );
    }

    await User.update(
      { passwordHash, status: 'ACTIVE', failedAttempts: 0, lockedUntil: null },
      { where: { id: user.id }, transaction },
    );

    await audit.record(
      {
        action: 'user.invitation_accepted',
        entityType: 'user',
        entityId: user.id,
        after: { email: user.email, status: 'ACTIVE' },
        // Nobody was signed in. The actor is the invitee, and attributing this
        // to the admin who sent the invitation would be a lie about who acted.
        actorUserId: null,
        ip: input.ip,
      },
      transaction,
    );
  });

  // A password change ends every other session, and an invitation accepted on
  // an account that somehow had one is exactly that case.
  await identityRepo.revokeAllSessionsFor(user.id, 'invitation_accepted');

  return { email: user.email, audience: user.audience };
}

/**
 * Issues a replacement and emails it. Used when the first never arrived, or
 * when it expired before the customer got to it.
 */
export async function resend(input: {
  userId: string;
  actorUserId: string;
  actorName: string;
  ip: string | null;
}): Promise<{ email: string; delivered: boolean; expiresAt: string }> {
  const user = await identityRepo.findUserById(input.userId);
  if (!user) throw new NotFoundError('User');

  if (user.status === 'SUSPENDED' || user.status === 'DISABLED') {
    throw new UnprocessableError(
      'account_not_invitable',
      'That account is suspended. Reinstate it before sending an invitation.',
    );
  }

  if (user.driverId) {
    const password = generateLoginPassword();
    user.passwordHash = await hashPassword(password);
    user.status = 'ACTIVE';
    user.failedAttempts = 0;
    user.lockedUntil = null;
    await user.save();
    await identityRepo.revokeAllSessionsFor(user.id, 'password_reset');

    await audit.record({
      action: 'user.invitation_resent',
      entityType: 'user',
      entityId: user.id,
      after: { email: user.email, kind: 'driver_credentials' },
      actorUserId: input.actorUserId,
      ip: input.ip,
    });

    const delivered = await mail.sendDriverInvitation({
      fullName: user.fullName,
      email: user.email,
      password,
      portalUrl: config.portals.driver,
      invitedBy: input.actorName,
    });

    return { email: user.email, delivered, expiresAt: new Date().toISOString() };
  }

  const issued = await issue({ userId: user.id, createdBy: input.actorUserId });

  await audit.record({
    action: 'user.invitation_resent',
    entityType: 'user',
    entityId: user.id,
    after: { email: user.email, expiresAt: issued.expiresAt.toISOString() },
    actorUserId: input.actorUserId,
    ip: input.ip,
  });

  const delivered = await deliver({
    user,
    token: issued.token,
    expiresAt: issued.expiresAt,
    invitedBy: input.actorName,
  });

  return { email: user.email, delivered, expiresAt: issued.expiresAt.toISOString() };
}

/**
 * Sends the invitation email. Never throws: the account already exists and the
 * link is already valid, so a mail failure is something to report and retry,
 * not something to unwind an onboarding for.
 */
export async function deliver(input: {
  user: { email: string; fullName: string; advertiserId: string | null; driverId?: string | null };
  token: string;
  expiresAt: Date;
  invitedBy: string;
}): Promise<boolean> {
  const organisation = input.user.driverId
    ? 'MoveAd Driver'
    : ((await identityRepo.organisationNameFor(input.user.advertiserId)) ?? 'MoveAd Operations');

  return mail.sendInvitation({
    fullName: input.user.fullName,
    email: input.user.email,
    organisation,
    acceptUrl: acceptUrlFor(input.user, input.token),
    portalUrl: portalUrlFor(input.user),
    expiresInHours: config.invitations.ttlHours,
    invitedBy: input.invitedBy,
  });
}

async function resolve(token: string): Promise<{ invitation: UserInvitation; user: User }> {
  const invitation = await UserInvitation.findOne({ where: { tokenHash: hashToken(token) } });

  if (!invitation) {
    throw new NotFoundError('Invitation', 'That invitation link is not valid.');
  }

  if (invitation.acceptedAt !== null) {
    throw new UnprocessableError(
      'invitation_used',
      'This invitation has already been used. Sign in with your password instead.',
    );
  }

  if (invitation.revokedAt !== null) {
    throw new UnprocessableError(
      'invitation_superseded',
      'A newer invitation was sent to you. Please use the most recent email.',
    );
  }

  if (invitation.expiresAt <= new Date()) {
    throw new UnprocessableError(
      'invitation_expired',
      'This invitation has expired. Ask your MoveAd contact to send another.',
    );
  }

  const user = await identityRepo.findUserById(invitation.userId);
  if (!user) throw new NotFoundError('Invitation', 'That invitation link is not valid.');

  return { invitation, user };
}
