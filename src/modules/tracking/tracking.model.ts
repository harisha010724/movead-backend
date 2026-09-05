import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../../db/sequelize';
import type { Money } from '../../pricing/money';
import { Campaign } from '../campaigns/campaigns.model';
import { Driver, Vehicle } from '../drivers/drivers.model';
import { CampaignVehicle } from '../installations/installations.model';

/**
 * The three records a kilometre passes through: the session it was driven in,
 * the fixes that recorded it, and the classified segments that priced it.
 *
 * Every money figure on a screen is a sum over `trip_segments`. Nothing
 * anywhere holds a total as a stored value, because a total that is written
 * rather than derived is a total that can disagree with its parts (AC-00).
 */

export type TrackingSessionStatus = 'ACTIVE' | 'ENDED';
export type GpsQuality = 'ELIGIBLE' | 'QUESTIONABLE' | 'REJECTED';
export type SegmentZone = 'PRIME' | 'SECONDARY' | 'NETWORK';
export type SegmentState = 'BILLABLE' | 'PENDING_REVIEW' | 'NON_BILLABLE';

export class TrackingSession extends Model<
  InferAttributes<TrackingSession>,
  InferCreationAttributes<TrackingSession>
> {
  declare id: CreationOptional<string>;
  declare driverId: string;
  declare vehicleId: string;
  declare campaignId: string;
  declare campaignVehicleId: string;
  declare status: CreationOptional<TrackingSessionStatus>;
  declare startedAt: Date;
  declare endedAt: CreationOptional<Date | null>;
  declare endReason: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare campaign?: Campaign;
  declare vehicle?: Vehicle;
}

TrackingSession.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    driverId: { type: DataTypes.UUID, allowNull: false },
    vehicleId: { type: DataTypes.UUID, allowNull: false },
    campaignId: { type: DataTypes.UUID, allowNull: false },
    campaignVehicleId: { type: DataTypes.UUID, allowNull: false },
    status: {
      type: DataTypes.ENUM('ACTIVE', 'ENDED'),
      allowNull: false,
      defaultValue: 'ACTIVE',
    },
    startedAt: { type: DataTypes.DATE, allowNull: false },
    endedAt: { type: DataTypes.DATE, allowNull: true },
    endReason: { type: DataTypes.TEXT, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'tracking_sessions', timestamps: true },
);

export class GpsPoint extends Model<
  InferAttributes<GpsPoint>,
  InferCreationAttributes<GpsPoint>
> {
  declare id: CreationOptional<string>;
  declare sessionId: string;
  declare clientPointId: string;
  declare recordedAt: Date;
  declare receivedAt: CreationOptional<Date>;
  /*
   * Coordinates come back from `pg` as strings, because they are NUMERIC.
   * Declared as such rather than quietly coerced: a latitude that has been
   * through a float on its way to a comparison is a latitude that can move.
   */
  declare lat: string;
  declare lon: string;
  declare accuracyM: string;
  declare speedMps: CreationOptional<string | null>;
  declare headingDeg: CreationOptional<string | null>;
  declare isMock: CreationOptional<boolean>;
  declare quality: GpsQuality;
  declare deviceDistanceM: CreationOptional<string | null>;
}

GpsPoint.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    sessionId: { type: DataTypes.UUID, allowNull: false },
    clientPointId: { type: DataTypes.UUID, allowNull: false },
    recordedAt: { type: DataTypes.DATE, allowNull: false },
    receivedAt: DataTypes.DATE,
    lat: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
    lon: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
    accuracyM: { type: DataTypes.DECIMAL(8, 2), allowNull: false },
    speedMps: { type: DataTypes.DECIMAL(8, 2), allowNull: true },
    headingDeg: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
    isMock: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    quality: {
      type: DataTypes.ENUM('ELIGIBLE', 'QUESTIONABLE', 'REJECTED'),
      allowNull: false,
    },
    deviceDistanceM: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
  },
  { sequelize, tableName: 'gps_points', timestamps: false },
);

export class TripSegment extends Model<
  InferAttributes<TripSegment>,
  InferCreationAttributes<TripSegment>
> {
  declare id: CreationOptional<string>;
  declare sessionId: string;
  declare campaignId: string;
  declare driverId: string;
  declare vehicleId: string;
  declare fromPointId: string;
  declare toPointId: string;
  declare partIndex: number;
  declare startedAt: Date;
  declare endedAt: Date;
  declare distanceKm: string;
  declare zone: SegmentZone;
  declare state: SegmentState;
  declare advertiserRate: Money;
  declare driverRate: Money;
  declare advertiserCharge: Money;
  declare driverEarning: Money;
  declare bridged: CreationOptional<boolean>;
  declare flagReason: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
}

TripSegment.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    sessionId: { type: DataTypes.UUID, allowNull: false },
    campaignId: { type: DataTypes.UUID, allowNull: false },
    driverId: { type: DataTypes.UUID, allowNull: false },
    vehicleId: { type: DataTypes.UUID, allowNull: false },
    fromPointId: { type: DataTypes.UUID, allowNull: false },
    toPointId: { type: DataTypes.UUID, allowNull: false },
    partIndex: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    startedAt: { type: DataTypes.DATE, allowNull: false },
    endedAt: { type: DataTypes.DATE, allowNull: false },
    distanceKm: { type: DataTypes.DECIMAL(12, 6), allowNull: false },
    zone: { type: DataTypes.ENUM('PRIME', 'SECONDARY', 'NETWORK'), allowNull: false },
    state: {
      type: DataTypes.ENUM('BILLABLE', 'PENDING_REVIEW', 'NON_BILLABLE'),
      allowNull: false,
    },
    advertiserRate: { type: DataTypes.DECIMAL(8, 4), allowNull: false },
    driverRate: { type: DataTypes.DECIMAL(8, 4), allowNull: false },
    advertiserCharge: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    driverEarning: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    bridged: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    flagReason: { type: DataTypes.TEXT, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'trip_segments', timestamps: false },
);

TrackingSession.belongsTo(Campaign, { foreignKey: 'campaignId', as: 'campaign' });
TrackingSession.belongsTo(Vehicle, { foreignKey: 'vehicleId', as: 'vehicle' });
TrackingSession.belongsTo(Driver, { foreignKey: 'driverId', as: 'driver' });
TrackingSession.belongsTo(CampaignVehicle, {
  foreignKey: 'campaignVehicleId',
  as: 'assignment',
});

TrackingSession.hasMany(GpsPoint, { foreignKey: 'sessionId', as: 'points' });
GpsPoint.belongsTo(TrackingSession, { foreignKey: 'sessionId', as: 'session' });

TrackingSession.hasMany(TripSegment, { foreignKey: 'sessionId', as: 'segments' });
TripSegment.belongsTo(TrackingSession, { foreignKey: 'sessionId', as: 'session' });
