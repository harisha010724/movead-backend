import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../../db/sequelize';

/** The advertiser account (database design Part 4.1). */

export type AdvertiserStatus = 'ONBOARDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

export class Advertiser extends Model<
  InferAttributes<Advertiser>,
  InferCreationAttributes<Advertiser>
> {
  declare id: CreationOptional<string>;
  declare legalName: string;
  declare brandName: string;
  declare gstin: string | null;
  declare pan: string | null;
  declare billingEmail: string;
  declare billingAddress: Record<string, unknown> | null;
  declare status: AdvertiserStatus;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Advertiser.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    legalName: { type: DataTypes.TEXT, allowNull: false },
    brandName: { type: DataTypes.TEXT, allowNull: false },
    gstin: { type: DataTypes.TEXT, allowNull: true },
    pan: { type: DataTypes.TEXT, allowNull: true },
    billingEmail: { type: DataTypes.TEXT, allowNull: false },
    billingAddress: { type: DataTypes.JSONB, allowNull: true },
    status: {
      type: DataTypes.ENUM('ONBOARDING', 'ACTIVE', 'SUSPENDED', 'CLOSED'),
      allowNull: false,
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'advertisers', timestamps: true },
);
