import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../../db/sequelize';

export type ReportType =
  | 'proof-pack'
  | 'billing-statement'
  | 'zone-summary'
  | 'vehicle-summary'
  | 'km-detail';

export type ReportFormat = 'html' | 'csv';

export class ReportExport extends Model<
  InferAttributes<ReportExport>,
  InferCreationAttributes<ReportExport>
> {
  declare id: CreationOptional<string>;
  declare advertiserId: string;
  declare campaignId: string;
  declare type: ReportType;
  declare format: ReportFormat;
  declare fromDate: string;
  declare toDate: string;
  declare fileName: string;
  declare contentType: string;
  declare byteSize: number;
  declare storageKey: string;
  declare checksum: string;
  declare generatedAt: CreationOptional<Date>;
  declare expiresAt: Date;
  declare createdAt: CreationOptional<Date>;
}

ReportExport.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    advertiserId: { type: DataTypes.UUID, allowNull: false },
    campaignId: { type: DataTypes.UUID, allowNull: false },
    type: {
      type: DataTypes.ENUM(
        'proof-pack',
        'billing-statement',
        'zone-summary',
        'vehicle-summary',
        'km-detail',
      ),
      allowNull: false,
    },
    format: { type: DataTypes.ENUM('html', 'csv'), allowNull: false },
    fromDate: { type: DataTypes.DATEONLY, allowNull: false },
    toDate: { type: DataTypes.DATEONLY, allowNull: false },
    fileName: { type: DataTypes.TEXT, allowNull: false },
    contentType: { type: DataTypes.TEXT, allowNull: false },
    byteSize: { type: DataTypes.INTEGER, allowNull: false },
    storageKey: { type: DataTypes.TEXT, allowNull: false },
    checksum: { type: DataTypes.TEXT, allowNull: false },
    generatedAt: { type: DataTypes.DATE, allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'report_exports', timestamps: false },
);
