import { Op, QueryTypes, type Transaction } from 'sequelize';

import { sequelize } from '../../db/sequelize';

import {
  User,
  UserRole,
  UserSession,
  type SessionAudience,
  type SessionClient,
} from './identity.model';

/**
 * Data access for identity. No business rules and no transaction boundaries —
 * both belong to the service (architecture Part 4.2).
 */

export function findUserByEmail(email: string): Promise<User | null> {
  return User.findOne({ where: { email } });
}

export function findUserById(id: string): Promise<User | null> {
  return User.findByPk(id);
}

export function countUsers(): Promise<number> {
  return User.count();
}

export function createUser(
  attributes: {
    email: string;
    passwordHash: string;
    fullName: string;
    advertiserId?: string | null;
    driverId?: string | null;
    status: 'INVITED' | 'ACTIVE';
  },
  transaction?: Transaction,
): Promise<User> {
  return User.create(
    {
      email: attributes.email,
      passwordHash: attributes.passwordHash,
      fullName: attributes.fullName,
      advertiserId: attributes.advertiserId ?? null,
      driverId: attributes.driverId ?? null,
      status: attributes.status,
      totpSecretEnc: null,
      totpEnabledAt: null,
      lastLoginAt: null,
      failedAttempts: 0,
      lockedUntil: null,
    },
    { transaction },
  );
}

export async function grantRole(
  userId: string,
  roleKey: string,
  grantedBy: string | null,
  transaction?: Transaction,
): Promise<void> {
  const [role] = await sequelize.query<{ id: string }>('SELECT id FROM roles WHERE key = $1', {
    bind: [roleKey],
    type: QueryTypes.SELECT,
    transaction,
  });

  if (!role) throw new Error(`Role ${roleKey} is missing. Has migration 004 run?`);

  await UserRole.upsert({ userId, roleId: role.id, grantedBy }, { transaction });
}

/**
 * Resolves a user's permissions through the role graph. Two joins, cached per
 * request by the caller rather than here, so a permission revoked mid-session
 * takes effect on the next request instead of the next login.
 */
export async function permissionsFor(userId: string): Promise<string[]> {
  const rows = await sequelize.query<{ permission_key: string }>(
    `SELECT DISTINCT rp.permission_key
     FROM   user_roles ur
     JOIN   role_permissions rp ON rp.role_id = ur.role_id
     WHERE  ur.user_id = $1`,
    { bind: [userId], type: QueryTypes.SELECT },
  );

  return rows.map((row) => row.permission_key);
}

/**
 * The brand name an advertiser user belongs to, for the portal's header. Null
 * for staff, who belong to the platform rather than to a customer.
 */
export async function organisationNameFor(advertiserId: string | null): Promise<string | null> {
  if (!advertiserId) return null;

  const [row] = await sequelize.query<{ brand_name: string }>(
    'SELECT brand_name FROM advertisers WHERE id = $1',
    { bind: [advertiserId], type: QueryTypes.SELECT },
  );

  return row?.brand_name ?? null;
}

export interface PrimaryUserRow {
  id: string;
  email: string;
  fullName: string;
  status: string;
  /** Expiry of the invitation still outstanding, or null if there is none. */
  invitationExpiresAt: string | null;
}

/**
 * The first login created for each of these advertisers, with the state of any
 * invitation still outstanding.
 *
 * One query for the whole page rather than one per row: the Advertisers table
 * shows the contact and whether they have accepted, and doing that per row is
 * the N+1 that turns a list of forty into forty-one round trips.
 */
export async function primaryUsersFor(
  advertiserIds: string[],
): Promise<Map<string, PrimaryUserRow>> {
  if (advertiserIds.length === 0) return new Map();

  const rows = await sequelize.query<{
    advertiser_id: string;
    id: string;
    email: string;
    full_name: string;
    status: string;
    invitation_expires_at: Date | null;
  }>(
    `SELECT DISTINCT ON (u.advertiser_id)
            u.advertiser_id, u.id, u.email, u.full_name, u.status,
            i.expires_at AS invitation_expires_at
     FROM   users u
     LEFT   JOIN user_invitations i
            ON  i.user_id = u.id
            AND i.accepted_at IS NULL
            AND i.revoked_at IS NULL
     WHERE  u.advertiser_id = ANY($1::uuid[])
     ORDER  BY u.advertiser_id, u.created_at ASC`,
    { bind: [advertiserIds], type: QueryTypes.SELECT },
  );

  return new Map(
    rows.map((row) => [
      row.advertiser_id,
      {
        id: row.id,
        email: row.email,
        fullName: row.full_name,
        status: row.status,
        invitationExpiresAt: row.invitation_expires_at?.toISOString() ?? null,
      },
    ]),
  );
}

export async function roleKeysFor(userId: string): Promise<string[]> {
  const rows = await sequelize.query<{ key: string }>(
    `SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
    { bind: [userId], type: QueryTypes.SELECT },
  );

  return rows.map((row) => row.key);
}

// -------------------------------------------------------------------- sessions

export function createSession(attributes: {
  userId: string;
  tokenHash: string;
  audience: SessionAudience;
  client?: SessionClient;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}): Promise<UserSession> {
  return UserSession.create({
    ...attributes,
    client: attributes.client ?? 'web',
    revokedAt: null,
    revokeReason: null,
  });
}

export function findLiveSession(tokenHash: string): Promise<UserSession | null> {
  return UserSession.findOne({ where: { tokenHash, revokedAt: null } });
}

export function findLiveSessionById(id: string): Promise<UserSession | null> {
  return UserSession.findOne({ where: { id, revokedAt: null } });
}

/**
 * Swaps the credential on a session that outlives it.
 *
 * The refresh token rotates on every use, so the row is the session and the
 * hash is only its current key. Rewriting it in place keeps `issuedAt` and the
 * session id stable, which is what lets an access token issued an hour ago
 * name the same session the newest refresh token unlocks.
 */
export async function rotateSessionToken(
  id: string,
  tokenHash: string,
  expiresAt: Date,
  at: Date,
): Promise<void> {
  await UserSession.update({ tokenHash, expiresAt, lastSeenAt: at }, { where: { id } });
}

export async function touchSession(id: string, at: Date): Promise<void> {
  await UserSession.update({ lastSeenAt: at }, { where: { id } });
}

export async function revokeSession(id: string, reason: string): Promise<void> {
  await UserSession.update({ revokedAt: new Date(), revokeReason: reason }, { where: { id } });
}

/** Used when a password changes or an account is suspended. */
export async function revokeAllSessionsFor(userId: string, reason: string): Promise<void> {
  await UserSession.update(
    { revokedAt: new Date(), revokeReason: reason },
    { where: { userId, revokedAt: { [Op.is]: null } } },
  );
}
