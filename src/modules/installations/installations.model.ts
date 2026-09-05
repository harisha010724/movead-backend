import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../../db/sequelize';
import { Campaign, type CampaignVehicleType } from '../campaigns/campaigns.model';
import { Driver, Vehicle } from '../drivers/drivers.model';

/**
 * Assignment and installation — the two records that stand between a campaign
 * being approved and a driver earning on it (AC-22, AC-06).
 */

export type AssignmentStatus =
  | 'ASSIGNED'
  | 'ACCEPTED'
  | 'INSTALLING'
  | 'ACTIVE'
  | 'ENDED'
  | 'WITHDRAWN';

export type InstallationStatus =
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'REJECTED';

export type PhotoAngle = 'FRONT' | 'REAR' | 'LEFT' | 'RIGHT';

/**
 * AC-06.4 — the required photo set is per vehicle type and configurable.
 *
 * A cab is wrapped on four faces. An auto has no meaningful left/right body
 * panel of the same kind, so the spec calls for an "adapted set"; MVP Appendix
 * E leaves the exact list open, and this is the working answer until it is
 * confirmed.
 */
export const REQUIRED_ANGLES: Record<CampaignVehicleType, PhotoAngle[]> = {
  CAB: ['FRONT', 'REAR', 'LEFT', 'RIGHT'],
  AUTO: ['REAR', 'LEFT', 'RIGHT'],
};

/** Assignment states in which the vehicle is spoken for (AC-22.6). */
export const LIVE_ASSIGNMENT: AssignmentStatus[] = [
  'ASSIGNED',
  'ACCEPTED',
  'INSTALLING',
  'ACTIVE',
];

export class CampaignVehicle extends Model<
  InferAttributes<CampaignVehicle>,
  InferCreationAttributes<CampaignVehicle>
> {
  declare id: CreationOptional<string>;
  declare campaignId: string;
  declare vehicleId: string;
  declare driverId: string;
  declare status: CreationOptional<AssignmentStatus>;
  declare assignedBy: string;
  declare assignedAt: CreationOptional<Date>;
  declare acceptedAt: CreationOptional<Date | null>;
  declare activatedAt: CreationOptional<Date | null>;
  declare endedAt: CreationOptional<Date | null>;
  declare endReason: CreationOptional<string | null>;
  declare overrideReason: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare campaign?: Campaign;
  declare vehicle?: Vehicle;
  declare driver?: Driver;
  declare installation?: Installation;
}

CampaignVehicle.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    campaignId: { type: DataTypes.UUID, allowNull: false },
    vehicleId: { type: DataTypes.UUID, allowNull: false },
    driverId: { type: DataTypes.UUID, allowNull: false },
    status: {
      type: DataTypes.ENUM('ASSIGNED', 'ACCEPTED', 'INSTALLING', 'ACTIVE', 'ENDED', 'WITHDRAWN'),
      allowNull: false,
      defaultValue: 'ASSIGNED',
    },
    assignedBy: { type: DataTypes.UUID, allowNull: false },
    assignedAt: DataTypes.DATE,
    acceptedAt: { type: DataTypes.DATE, allowNull: true },
    activatedAt: { type: DataTypes.DATE, allowNull: true },
    endedAt: { type: DataTypes.DATE, allowNull: true },
    endReason: { type: DataTypes.TEXT, allowNull: true },
    overrideReason: { type: DataTypes.TEXT, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'campaign_vehicles', timestamps: true },
);

export class Installation extends Model<
  InferAttributes<Installation>,
  InferCreationAttributes<Installation>
> {
  declare id: CreationOptional<string>;
  declare campaignVehicleId: string;
  declare status: CreationOptional<InstallationStatus>;
  declare scheduledFor: CreationOptional<Date | null>;
  declare submittedAt: CreationOptional<Date | null>;
  declare submittedBy: CreationOptional<string | null>;
  declare reviewedAt: CreationOptional<Date | null>;
  declare reviewedBy: CreationOptional<string | null>;
  declare rejectionReason: CreationOptional<string | null>;
  declare removedAt: CreationOptional<Date | null>;
  declare removedReason: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare assignment?: CampaignVehicle;
  declare photos?: InstallationPhoto[];
}

Installation.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    campaignVehicleId: { type: DataTypes.UUID, allowNull: false },
    status: {
      type: DataTypes.ENUM('SCHEDULED', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED'),
      allowNull: false,
      defaultValue: 'SCHEDULED',
    },
    scheduledFor: { type: DataTypes.DATE, allowNull: true },
    submittedAt: { type: DataTypes.DATE, allowNull: true },
    submittedBy: { type: DataTypes.UUID, allowNull: true },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
    reviewedBy: { type: DataTypes.UUID, allowNull: true },
    rejectionReason: { type: DataTypes.TEXT, allowNull: true },
    removedAt: { type: DataTypes.DATE, allowNull: true },
    removedReason: { type: DataTypes.TEXT, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'installations', timestamps: true },
);

export class InstallationPhoto extends Model<
  InferAttributes<InstallationPhoto>,
  InferCreationAttributes<InstallationPhoto>
> {
  declare id: CreationOptional<string>;
  declare installationId: string;
  declare angle: PhotoAngle;
  declare storageKey: string;
  declare fileName: string;
  declare contentType: string;
  declare byteSize: number;
  declare uploadedBy: string;
  declare uploadedAt: CreationOptional<Date>;
}

InstallationPhoto.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    installationId: { type: DataTypes.UUID, allowNull: false },
    angle: { type: DataTypes.ENUM('FRONT', 'REAR', 'LEFT', 'RIGHT'), allowNull: false },
    storageKey: { type: DataTypes.TEXT, allowNull: false },
    fileName: { type: DataTypes.TEXT, allowNull: false },
    contentType: { type: DataTypes.TEXT, allowNull: false },
    byteSize: { type: DataTypes.INTEGER, allowNull: false },
    uploadedBy: { type: DataTypes.UUID, allowNull: false },
    uploadedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'installation_photos', timestamps: false },
);

CampaignVehicle.belongsTo(Campaign, { foreignKey: 'campaignId', as: 'campaign' });
CampaignVehicle.belongsTo(Vehicle, { foreignKey: 'vehicleId', as: 'vehicle' });
CampaignVehicle.belongsTo(Driver, { foreignKey: 'driverId', as: 'driver' });
CampaignVehicle.hasOne(Installation, { foreignKey: 'campaignVehicleId', as: 'installation' });

Installation.belongsTo(CampaignVehicle, { foreignKey: 'campaignVehicleId', as: 'assignment' });
Installation.hasMany(InstallationPhoto, { foreignKey: 'installationId', as: 'photos' });

InstallationPhoto.belongsTo(Installation, { foreignKey: 'installationId', as: 'installation' });

Campaign.hasMany(CampaignVehicle, { foreignKey: 'campaignId', as: 'assignments' });
