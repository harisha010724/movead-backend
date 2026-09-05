import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../../db/sequelize';

export type NotificationKind =
  | 'TRACKING'
  | 'EARNING'
  | 'CAMPAIGN'
  | 'PAYOUT'
  | 'VERIFICATION'
  | 'SYSTEM';

export class AppNotification extends Model<
  InferAttributes<AppNotification>,
  InferCreationAttributes<AppNotification>
> {
  declare id: CreationOptional<string>;
  declare driverId: string | null;
  declare userId: string | null;
  declare kind: NotificationKind;
  declare title: string;
  declare body: string | null;
  declare href: string | null;
  declare readAt: Date | null;
  declare createdAt: CreationOptional<Date>;
}

AppNotification.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    driverId: { type: DataTypes.UUID, allowNull: true },
    userId: { type: DataTypes.UUID, allowNull: true },
    kind: {
      type: DataTypes.ENUM(
        'TRACKING',
        'EARNING',
        'CAMPAIGN',
        'PAYOUT',
        'VERIFICATION',
        'SYSTEM',
      ),
      allowNull: false,
    },
    title: { type: DataTypes.TEXT, allowNull: false },
    body: { type: DataTypes.TEXT, allowNull: true },
    href: { type: DataTypes.TEXT, allowNull: true },
    readAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: 'notifications', timestamps: false },
);
