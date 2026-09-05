import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { Advertiser } from '../advertisers/advertisers.model';
import { sequelize } from '../../db/sequelize';

export type CampaignStatus =
  | 'DRAFT'
  | 'PENDING_CONFIRMATION'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'AWAITING_INSTALLATION'
  | 'ACTIVE'
  | 'PAUSED'
  | 'BUDGET_WARNING'
  | 'STOPPED'
  | 'COMPLETED'
  | 'CANCELLED';

export type CampaignVehicleType = 'CAB' | 'AUTO';

export type ZoneTier = 'prime' | 'secondary';

export interface CampaignLocation {
  id: string;
  placeId: string;
  label: string;
  lat: number;
  lng: number;
  tier: ZoneTier;
}

export type ZonePolygons = Partial<
  Record<ZoneTier, { path: { lat: number; lng: number }[] }>
>;

export class Campaign extends Model<InferAttributes<Campaign>, InferCreationAttributes<Campaign>> {
  declare id: CreationOptional<string>;
  declare advertiserId: string;
  declare name: string;
  declare brandName: string;
  declare city: string;
  declare vehicleType: CampaignVehicleType;
  declare creativeKey: string | null;
  declare creativeFileName: string | null;
  declare creativeContentType: string | null;
  declare creativeByteSize: number | null;
  declare status: CampaignStatus;
  declare startDate: string;
  declare endDate: string;
  declare budgetAmount: string;
  declare spentAmount: CreationOptional<string>;
  declare zoneBudgetPrime: CreationOptional<string>;
  declare zoneBudgetSecondary: CreationOptional<string>;
  declare zoneBudgetNetwork: CreationOptional<string>;
  declare zoneKmPrime: CreationOptional<string>;
  declare zoneKmSecondary: CreationOptional<string>;
  declare locations: CreationOptional<CampaignLocation[]>;
  declare zonePolygons: CreationOptional<ZonePolygons>;
  /** Advertiser request. Admin still confirms assignment (AC-22.4). */
  declare requestedVehicleIds: CreationOptional<string[]>;
  declare targetKm: string | null;
  declare createdBy: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare advertiser?: Advertiser;
}

Campaign.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    advertiserId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.TEXT, allowNull: false },
    brandName: { type: DataTypes.TEXT, allowNull: false },
    city: { type: DataTypes.TEXT, allowNull: false },
    vehicleType: { type: DataTypes.ENUM('CAB', 'AUTO'), allowNull: false },
    creativeKey: { type: DataTypes.TEXT, allowNull: true },
    creativeFileName: { type: DataTypes.TEXT, allowNull: true },
    creativeContentType: { type: DataTypes.TEXT, allowNull: true },
    creativeByteSize: { type: DataTypes.INTEGER, allowNull: true },
    status: {
      type: DataTypes.ENUM(
        'DRAFT',
        'PENDING_CONFIRMATION',
        'PENDING_APPROVAL',
        'APPROVED',
        'AWAITING_INSTALLATION',
        'ACTIVE',
        'PAUSED',
        'BUDGET_WARNING',
        'STOPPED',
        'COMPLETED',
        'CANCELLED',
      ),
      allowNull: false,
      defaultValue: 'PENDING_APPROVAL',
    },
    startDate: { type: DataTypes.DATEONLY, allowNull: false },
    endDate: { type: DataTypes.DATEONLY, allowNull: false },
    budgetAmount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    spentAmount: { type: DataTypes.DECIMAL(14, 4), allowNull: false, defaultValue: '0' },
    zoneBudgetPrime: { type: DataTypes.DECIMAL(14, 4), allowNull: false, defaultValue: '0' },
    zoneBudgetSecondary: { type: DataTypes.DECIMAL(14, 4), allowNull: false, defaultValue: '0' },
    zoneBudgetNetwork: { type: DataTypes.DECIMAL(14, 4), allowNull: false, defaultValue: '0' },
    zoneKmPrime: { type: DataTypes.DECIMAL(12, 4), allowNull: false, defaultValue: '0' },
    zoneKmSecondary: { type: DataTypes.DECIMAL(12, 4), allowNull: false, defaultValue: '0' },
    locations: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    zonePolygons: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    requestedVehicleIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
    targetKm: { type: DataTypes.DECIMAL(12, 4), allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'campaigns', timestamps: true },
);

Campaign.belongsTo(Advertiser, { foreignKey: 'advertiserId', as: 'advertiser' });
