import { randomBytes } from 'node:crypto';

import { UniqueConstraintError } from 'sequelize';

import { sequelize } from '../../db/sequelize';
import { ConflictError, NotFoundError } from '../../shared/errors';
import * as audit from '../audit/audit.service';
import { hashPassword } from '../identity/credentials';
import * as identityRepo from '../identity/identity.repository';
import * as invitations from '../invitations/invitations.service';

import { Advertiser, type AdvertiserStatus } from './advertisers.model';

/**
 * Advertiser onboarding, admin side.
 *
 * AC-32.2: there is no advertiser self-registration. An advertiser account and
 * its first portal user are both created by operations staff, which is what
 * makes "who is this company" a question answered before they can spend money
 * rather than after.
 *
 * What operations do *not* do is choose the customer's password. They create
 * the account; the platform emails a single-use link; the customer picks their
 * own password and is the only party who ever sees it (migration 009).
 */

const ADVERTISER_ROLE = 'ADVERTISER';

/**
 * An account with no password yet.
 *
 * `INVITED` is a real state rather than a label: `identity.service` refuses to
 * issue a session for one, so the row that exists between onboarding and the
 * customer choosing a password cannot be signed into even though it has a
 * password hash column filled with an unguessable value.
 */
const UNUSABLE_PASSWORD_BYTES = 48;

export interface AdvertiserView {
  id: string;
  legalName: string;
  brandName: string;
  gstin: string | null;
  pan: string | null;
  billingEmail: string;
  status: AdvertiserStatus;
  createdAt: string;
  /** The first portal login, when the account has one. */
  primaryUser: AdvertiserUserView | null;
}

export interface AdvertiserUserView {
  id: string;
  email: string;
  fullName: string;
  status: string;
  /** Null once they have accepted, or when no invitation was ever sent. */
  invitationExpiresAt: string | null;
}

export interface OnboardedAdvertiser {
  advertiser: AdvertiserView;
  user: AdvertiserUserView | null;
  /**
   * Whether the invitation email left the building.
   *
   * Reported rather than thrown. The account and the link are already committed
   * by the time mail is attempted, so a dead SMTP server is a thing to tell the
   * admin about — with a Resend button beside it — not a reason to lose
   * everything they just typed.
   */
  invitationEmailed: boolean;
}

export interface AdvertiserUserInput {
  email: string;
  fullName: string;
}

/**
 * Creates the advertiser and, optionally, its first login in one transaction.
 *
 * One transaction because onboarding is one form to the admin. Split across two
 * calls, an email that is already registered leaves an advertiser behind with
 * no way in and no obvious way to finish it — and the retry then fails on the
 * legal name being taken, which is not the thing that was wrong. The same
 * argument as `POST /v1/admin/drivers` creating the vehicle.
 */
export async function createAdvertiser(input: {
  legalName: string;
  brandName: string;
  gstin?: string | null;
  pan?: string | null;
  billingEmail: string;
  user?: AdvertiserUserInput | null;
  createdBy: string;
  createdByName: string;
  ip: string | null;
}): Promise<OnboardedAdvertiser> {
  const created = await sequelize
    .transaction(async (transaction) => {
      const advertiser = await Advertiser.create(
        {
          legalName: input.legalName,
          brandName: input.brandName,
          gstin: input.gstin ?? null,
          pan: input.pan ?? null,
          billingEmail: input.billingEmail,
          billingAddress: null,
          // Not ACTIVE on creation: an advertiser becomes active when it has a
          // funded wallet, which is a billing concern rather than an admin form.
          status: 'ONBOARDING',
        },
        { transaction },
      );

      await audit.record(
        {
          action: 'advertiser.created',
          entityType: 'advertiser',
          entityId: advertiser.id,
          after: { legalName: advertiser.legalName, brandName: advertiser.brandName },
          actorUserId: input.createdBy,
          ip: input.ip,
        },
        transaction,
      );

      if (!input.user) return { advertiser, invited: null };

      const invited = await addUser(
        {
          advertiser,
          email: input.user.email,
          fullName: input.user.fullName,
          createdBy: input.createdBy,
          ip: input.ip,
        },
        transaction,
      );

      return { advertiser, invited };
    })
    .catch(rethrowEmailConflict);

  const emailed = created.invited
    ? await invitations.deliver({
        user: created.invited.user,
        token: created.invited.token,
        expiresAt: created.invited.expiresAt,
        invitedBy: input.createdByName,
      })
    : false;

  return {
    advertiser: view(created.advertiser, null),
    user: created.invited ? userView(created.invited) : null,
    invitationEmailed: emailed,
  };
}

export interface AdvertiserChanges {
  legalName?: string;
  brandName?: string;
  /** Undefined leaves it alone; null clears it. */
  gstin?: string | null;
  pan?: string | null;
  billingEmail?: string;
}

/**
 * Corrects the organisation on record.
 *
 * Only the company: the primary user is read back onto the response so the
 * caller's row stays whole, but nothing about that person is editable here. A
 * contact's sign-in address is their credential, and changing it through the
 * company's endpoint would be a way to move an account to a new mailbox without
 * anybody treating it as the security event it is.
 */
export async function updateAdvertiser(input: {
  advertiserId: string;
  changes: AdvertiserChanges;
  actorUserId: string;
  ip: string | null;
}): Promise<AdvertiserView> {
  const advertiser = await Advertiser.findByPk(input.advertiserId);
  if (!advertiser) throw new NotFoundError('No advertiser with that id.');

  const before = snapshot(advertiser);

  // `in` rather than a truthiness check: null is a value here, meaning clear
  // the field, and `undefined` is the absence of an instruction.
  const { changes } = input;
  if (changes.legalName !== undefined) advertiser.legalName = changes.legalName;
  if (changes.brandName !== undefined) advertiser.brandName = changes.brandName;
  if ('gstin' in changes) advertiser.gstin = changes.gstin ?? null;
  if ('pan' in changes) advertiser.pan = changes.pan ?? null;
  if (changes.billingEmail !== undefined) advertiser.billingEmail = changes.billingEmail;

  const after = snapshot(advertiser);
  const changed = Object.keys(after).filter((field) => after[field] !== before[field]);

  // A no-op PATCH is not an error — a form submitted unchanged is an ordinary
  // thing — but it should not leave an audit entry claiming something happened.
  if (changed.length > 0) {
    await advertiser.save();

    await audit.record({
      action: 'advertiser.updated',
      entityType: 'advertiser',
      entityId: advertiser.id,
      before: pick(before, changed),
      after: pick(after, changed),
      actorUserId: input.actorUserId,
      ip: input.ip,
    });
  }

  const primaries = await identityRepo.primaryUsersFor([advertiser.id]);
  return view(advertiser, primaries.get(advertiser.id) ?? null);
}

export async function listAdvertisers(): Promise<AdvertiserView[]> {
  const rows = await Advertiser.findAll({ order: [['createdAt', 'DESC']], limit: 200 });
  if (rows.length === 0) return [];

  const primaries = await identityRepo.primaryUsersFor(rows.map((row) => row.id));
  return rows.map((row) => view(row, primaries.get(row.id) ?? null));
}

/**
 * Adds a login to an existing advertiser and emails the invitation.
 *
 * There is no password parameter, and that is the point. The endpoint that used
 * to take one has been changed rather than supplemented, so there is exactly
 * one way an advertiser account gets a password and it goes through the
 * customer's mailbox.
 */
export async function createAdvertiserUser(input: {
  advertiserId: string;
  email: string;
  fullName: string;
  createdBy: string;
  createdByName: string;
  ip: string | null;
}): Promise<{ user: AdvertiserUserView; invitationEmailed: boolean }> {
  const advertiser = await Advertiser.findByPk(input.advertiserId);
  if (!advertiser) throw new NotFoundError('No advertiser with that id.');

  if (advertiser.status === 'CLOSED') {
    throw new ConflictError('That advertiser account is closed.');
  }

  const invited = await sequelize
    .transaction((transaction) =>
      addUser(
        {
          advertiser,
          email: input.email,
          fullName: input.fullName,
          createdBy: input.createdBy,
          ip: input.ip,
        },
        transaction,
      ),
    )
    .catch(rethrowEmailConflict);

  const emailed = await invitations.deliver({
    user: invited.user,
    token: invited.token,
    expiresAt: invited.expiresAt,
    invitedBy: input.createdByName,
  });

  return { user: userView(invited), invitationEmailed: emailed };
}

interface InvitedUser {
  user: { id: string; email: string; fullName: string; advertiserId: string | null };
  token: string;
  expiresAt: Date;
}

/**
 * The user row, its role, its audit entry and its invitation — all inside the
 * caller's transaction, so an advertiser is never left holding a login that has
 * no way to become usable.
 */
async function addUser(
  input: {
    advertiser: Advertiser;
    email: string;
    fullName: string;
    createdBy: string;
    ip: string | null;
  },
  transaction: Parameters<typeof identityRepo.createUser>[1],
): Promise<InvitedUser> {
  const user = await identityRepo.createUser(
    {
      email: input.email,
      fullName: input.fullName,
      // Filled with randomness nobody holds, not left blank. The column is NOT
      // NULL, and a predictable placeholder in a password column is the kind of
      // thing that survives to production and becomes a way in.
      passwordHash: await hashPassword(unusablePassword()),
      advertiserId: input.advertiser.id,
      status: 'INVITED',
    },
    transaction,
  );

  await identityRepo.grantRole(user.id, ADVERTISER_ROLE, input.createdBy, transaction);

  const invitation = await invitations.issue(
    { userId: user.id, createdBy: input.createdBy },
    transaction,
  );

  await audit.record(
    {
      action: 'advertiser.user_invited',
      entityType: 'user',
      entityId: user.id,
      after: {
        email: user.email,
        advertiserId: input.advertiser.id,
        role: ADVERTISER_ROLE,
        invitationExpiresAt: invitation.expiresAt.toISOString(),
      },
      actorUserId: input.createdBy,
      ip: input.ip,
    },
    transaction,
  );

  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      advertiserId: input.advertiser.id,
    },
    token: invitation.token,
    expiresAt: invitation.expiresAt,
  };
}

function unusablePassword(): string {
  return randomBytes(UNUSABLE_PASSWORD_BYTES).toString('base64url');
}

/**
 * `users.email` is unique platform-wide. Sequelize reports that as a generic
 * unique violation, which would surface as a 500; the form needs a 409 naming
 * the field so the message lands under the input that caused it.
 */
function rethrowEmailConflict(error: unknown): never {
  if (error instanceof UniqueConstraintError) {
    throw new ConflictError('That email address is already registered.', { fields: ['email'] });
  }
  throw error;
}

type AdvertiserSnapshot = Record<string, string | null>;

/** The editable fields only, so the audit entry records the correction. */
function snapshot(row: Advertiser): AdvertiserSnapshot {
  return {
    legalName: row.legalName,
    brandName: row.brandName,
    gstin: row.gstin,
    pan: row.pan,
    billingEmail: row.billingEmail,
  };
}

function pick(from: AdvertiserSnapshot, fields: string[]): AdvertiserSnapshot {
  return Object.fromEntries(fields.map((field) => [field, from[field] ?? null]));
}

function userView(invited: InvitedUser): AdvertiserUserView {
  return {
    id: invited.user.id,
    email: invited.user.email,
    fullName: invited.user.fullName,
    status: 'INVITED',
    invitationExpiresAt: invited.expiresAt.toISOString(),
  };
}

function view(row: Advertiser, primaryUser: AdvertiserUserView | null): AdvertiserView {
  return {
    id: row.id,
    legalName: row.legalName,
    brandName: row.brandName,
    gstin: row.gstin,
    pan: row.pan,
    billingEmail: row.billingEmail,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    primaryUser,
  };
}
