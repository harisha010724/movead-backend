import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../../db/sequelize';

/**
 * One version of an advertiser's ₹/km card.
 *
 * The latest row is the price for new campaigns. Older rows stay so a change
 * is an audit trail rather than an overwrite. Campaigns copy the numbers they
 * were sold at and never read this table again.
 */
export class AdvertiserRateCard extends Model<
  InferAttributes<AdvertiserRateCard>,
  InferCreationAttributes<AdvertiserRateCard>
> {
  declare id: CreationOptional<string>;
  declare advertiserId: string;
  declare prime: string;
  declare secondary: string;
  declare network: string;
  declare createdBy: string;
  declare createdAt: CreationOptional<Date>;
}

AdvertiserRateCard.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    advertiserId: { type: DataTypes.UUID, allowNull: false },
    prime: { type: DataTypes.DECIMAL(8, 4), allowNull: false },
    secondary: { type: DataTypes.DECIMAL(8, 4), allowNull: false },
    network: { type: DataTypes.DECIMAL(8, 4), allowNull: false },
    createdBy: { type: DataTypes.UUID, allowNull: false },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'advertiser_rate_cards', timestamps: true, updatedAt: false },
);
