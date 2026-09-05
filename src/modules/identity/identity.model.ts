import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../../db/sequelize';

/**
 * Models for the identity tables (database design Part 4).
 *
 * Column names are snake_case in the database and camelCase here; the
 * `underscored: true` default on the connection maps between them, so nothing
 * has to be spelled twice.
 */

export type UserStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
export type SessionAudience = 'admin' | 'advertiser' | 'driver';

/**
 * What is holding the session, which decides how it ends.
 *
 * `web` is a browser cookie on a portal timeout. `mobile` is the driver app,
 * where the row is the refresh token's record and the timeouts a browser needs
 * would only sign a working driver out mid-shift.
 */
export type SessionClient = 'web' | 'mobile';

/** `audience` is derived, so it is omitted from the attribute inference. */
export class User extends Model<
  InferAttributes<User, { omit: 'audience' }>,
  InferCreationAttributes<User, { omit: 'audience' }>
> {
  declare id: CreationOptional<string>;
  declare email: string;
  declare passwordHash: string;
  declare fullName: string;
  /** Null for platform staff and drivers; set for advertiser-portal users. */
  declare advertiserId: string | null;
  /** Null for platform staff and advertisers; set for driver-portal users. */
  declare driverId: string | null;
  declare totpSecretEnc: Buffer | null;
  declare totpEnabledAt: Date | null;
  declare status: UserStatus;
  declare lastLoginAt: Date | null;
  declare failedAttempts: number;
  declare lockedUntil: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  /** Staff → admin, advertiser_id → advertiser, driver_id → driver. */
  get audience(): SessionAudience {
    if (this.driverId) return 'driver';
    return this.advertiserId === null ? 'admin' : 'advertiser';
  }
}

User.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    email: { type: DataTypes.CITEXT, allowNull: false, unique: true },
    passwordHash: { type: DataTypes.TEXT, allowNull: false },
    fullName: { type: DataTypes.TEXT, allowNull: false },
    advertiserId: { type: DataTypes.UUID, allowNull: true },
    driverId: { type: DataTypes.UUID, allowNull: true },
    totpSecretEnc: { type: DataTypes.BLOB, allowNull: true },
    totpEnabledAt: { type: DataTypes.DATE, allowNull: true },
    status: {
      type: DataTypes.ENUM('INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED'),
      allowNull: false,
    },
    lastLoginAt: { type: DataTypes.DATE, allowNull: true },
    failedAttempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    lockedUntil: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'users', timestamps: true },
);

export class Role extends Model<InferAttributes<Role>, InferCreationAttributes<Role>> {
  declare id: CreationOptional<string>;
  declare key: string;
  declare description: string;
  declare isSystem: boolean;
}

Role.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    key: { type: DataTypes.TEXT, allowNull: false, unique: true },
    description: { type: DataTypes.TEXT, allowNull: false },
    isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  { sequelize, tableName: 'roles' },
);

export class Permission extends Model<
  InferAttributes<Permission>,
  InferCreationAttributes<Permission>
> {
  declare key: string;
  declare description: string;
}

Permission.init(
  {
    key: { type: DataTypes.TEXT, primaryKey: true },
    description: { type: DataTypes.TEXT, allowNull: false },
  },
  { sequelize, tableName: 'permissions' },
);

export class UserRole extends Model<InferAttributes<UserRole>, InferCreationAttributes<UserRole>> {
  declare userId: string;
  declare roleId: string;
  declare grantedBy: string | null;
  declare grantedAt: CreationOptional<Date>;
}

UserRole.init(
  {
    userId: { type: DataTypes.UUID, primaryKey: true },
    roleId: { type: DataTypes.UUID, primaryKey: true },
    grantedBy: { type: DataTypes.UUID, allowNull: true },
    grantedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: 'user_roles' },
);

export class RolePermission extends Model<
  InferAttributes<RolePermission>,
  InferCreationAttributes<RolePermission>
> {
  declare roleId: string;
  declare permissionKey: string;
}

RolePermission.init(
  {
    roleId: { type: DataTypes.UUID, primaryKey: true },
    permissionKey: { type: DataTypes.TEXT, primaryKey: true },
  },
  { sequelize, tableName: 'role_permissions' },
);

export class UserSession extends Model<
  InferAttributes<UserSession>,
  InferCreationAttributes<UserSession>
> {
  declare id: CreationOptional<string>;
  declare userId: string;
  /**
   * SHA-256 of the opaque credential — the cookie value on web, the current
   * refresh token on mobile. The token itself is never stored, and on mobile
   * this changes on every refresh because the token rotates.
   */
  declare tokenHash: string;
  declare audience: SessionAudience;
  declare client: CreationOptional<SessionClient>;
  declare issuedAt: CreationOptional<Date>;
  declare lastSeenAt: CreationOptional<Date>;
  declare expiresAt: Date;
  declare revokedAt: Date | null;
  declare revokeReason: string | null;
  declare ip: string | null;
  declare userAgent: string | null;
}

UserSession.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    userId: { type: DataTypes.UUID, allowNull: false },
    tokenHash: { type: DataTypes.TEXT, allowNull: false, unique: true },
    audience: { type: DataTypes.TEXT, allowNull: false },
    client: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'web' },
    issuedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    lastSeenAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
    revokeReason: { type: DataTypes.TEXT, allowNull: true },
    ip: { type: DataTypes.INET, allowNull: true },
    userAgent: { type: DataTypes.TEXT, allowNull: true },
  },
  { sequelize, tableName: 'user_sessions' },
);

User.belongsToMany(Role, { through: UserRole, foreignKey: 'userId', otherKey: 'roleId' });
Role.belongsToMany(User, { through: UserRole, foreignKey: 'roleId', otherKey: 'userId' });
Role.belongsToMany(Permission, {
  through: RolePermission,
  foreignKey: 'roleId',
  otherKey: 'permissionKey',
});
User.hasMany(UserSession, { foreignKey: 'userId' });
UserSession.belongsTo(User, { foreignKey: 'userId' });
