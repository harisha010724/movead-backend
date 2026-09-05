import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../../db/sequelize';

/**
 * A single-use link that lets someone set their first password (migration 009).
 *
 * The token is not here. Only its SHA-256 is stored, so this table is worth
 * nothing to anyone who reads it — the same treatment `user_sessions` gives a
 * session cookie, and for the same reason.
 */
export class UserInvitation extends Model<
  InferAttributes<UserInvitation>,
  InferCreationAttributes<UserInvitation>
> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare tokenHash: string;
  declare expiresAt: Date;
  declare acceptedAt: CreationOptional<Date | null>;
  /** Set when a resend supersedes this one. */
  declare revokedAt: CreationOptional<Date | null>;
  declare createdBy: string | null;
  declare createdAt: CreationOptional<Date>;
}

UserInvitation.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    userId: { type: DataTypes.UUID, allowNull: false },
    tokenHash: { type: DataTypes.TEXT, allowNull: false, unique: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    acceptedAt: { type: DataTypes.DATE, allowNull: true },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'user_invitations', timestamps: true, updatedAt: false },
);
