import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../../db/sequelize';
import { CampaignVehicle, REQUIRED_ANGLES, type PhotoAngle } from '../installations/installations.model';
import type { CampaignVehicleType } from '../campaigns/campaigns.model';

/**
 * Mid-campaign wrap photos taken by the driver, with a location the server
 * recorded rather than one read from the file.
 */

export type BrandingProofStatus =
  | 'REQUESTED'
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'REJECTED';

export type BrandingAngle = PhotoAngle | 'AD_CLOSEUP';

/** Installation angles plus a close-up of the creative. */
export function requiredBrandingAngles(category: CampaignVehicleType): BrandingAngle[] {
  return [...REQUIRED_ANGLES[category], 'AD_CLOSEUP'];
}

/** Driver still has work. Submitted photos are published and no longer open. */
export const OPEN_PROOF: BrandingProofStatus[] = ['REQUESTED', 'IN_PROGRESS', 'REJECTED'];

export class BrandingProof extends Model<
  InferAttributes<BrandingProof>,
  InferCreationAttributes<BrandingProof>
> {
  declare id: CreationOptional<string>;
  declare campaignVehicleId: string;
  declare status: CreationOptional<BrandingProofStatus>;
  declare requestedBy: CreationOptional<string | null>;
  declare requestedAt: CreationOptional<Date>;
  declare dueAt: Date;
  declare submittedAt: CreationOptional<Date | null>;
  declare reviewedAt: CreationOptional<Date | null>;
  declare reviewedBy: CreationOptional<string | null>;
  declare rejectionReason: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare assignment?: CampaignVehicle;
  declare photos?: BrandingProofPhoto[];
}

BrandingProof.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    campaignVehicleId: { type: DataTypes.UUID, allowNull: false },
    status: {
      type: DataTypes.ENUM('REQUESTED', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED'),
      allowNull: false,
      defaultValue: 'REQUESTED',
    },
    requestedBy: { type: DataTypes.UUID, allowNull: true },
    requestedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    dueAt: { type: DataTypes.DATE, allowNull: false },
    submittedAt: { type: DataTypes.DATE, allowNull: true },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
    reviewedBy: { type: DataTypes.UUID, allowNull: true },
    rejectionReason: { type: DataTypes.TEXT, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'branding_proofs', timestamps: true },
);

export class BrandingProofPhoto extends Model<
  InferAttributes<BrandingProofPhoto>,
  InferCreationAttributes<BrandingProofPhoto>
> {
  declare id: CreationOptional<string>;
  declare proofId: string;
  declare angle: BrandingAngle;
  declare storageKey: string;
  declare fileName: string;
  declare contentType: string;
  declare byteSize: number;
  declare lat: string;
  declare lon: string;
  declare capturedAt: Date;
  declare uploadedAt: CreationOptional<Date>;
}

BrandingProofPhoto.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    proofId: { type: DataTypes.UUID, allowNull: false },
    angle: {
      type: DataTypes.ENUM('FRONT', 'REAR', 'LEFT', 'RIGHT', 'AD_CLOSEUP'),
      allowNull: false,
    },
    storageKey: { type: DataTypes.TEXT, allowNull: false },
    fileName: { type: DataTypes.TEXT, allowNull: false },
    contentType: { type: DataTypes.TEXT, allowNull: false },
    byteSize: { type: DataTypes.INTEGER, allowNull: false },
    lat: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
    lon: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
    capturedAt: { type: DataTypes.DATE, allowNull: false },
    uploadedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: 'branding_proof_photos', timestamps: false },
);

CampaignVehicle.hasMany(BrandingProof, { foreignKey: 'campaignVehicleId', as: 'brandingProofs' });
BrandingProof.belongsTo(CampaignVehicle, { foreignKey: 'campaignVehicleId', as: 'assignment' });
BrandingProof.hasMany(BrandingProofPhoto, { foreignKey: 'proofId', as: 'photos' });
BrandingProofPhoto.belongsTo(BrandingProof, { foreignKey: 'proofId', as: 'proof' });
