import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../../db/sequelize';
import type { BaselineSource } from '../traffic/traffic.service';

/**
 * One segment's modelled audience, under one version of the model.
 *
 * Holds no money and is referenced by nothing. Every column other than the
 * key is either the output or one of the inputs that produced it — see the
 * migration for why the inputs are stored rather than looked up.
 */
export class SegmentImpression extends Model<
  InferAttributes<SegmentImpression>,
  InferCreationAttributes<SegmentImpression>
> {
  declare segmentId: string;
  declare modelVersion: string;

  /** NUMERIC throughout, so `pg` hands these back as strings. */
  declare impressions: string;
  declare vehiclesPerKm: string;
  declare inVehiclePersonsKm: string;
  declare pedestrianDensity: string;
  declare personsPresentKm: string;
  declare lineOfSightShare: string;
  declare wrapQuality: string;
  declare daypartFactor: string;
  declare observedKmh: string;
  declare baselineKmh: string;

  declare baselineSource: BaselineSource;
  declare computedAt: CreationOptional<Date>;
}

SegmentImpression.init(
  {
    segmentId: { type: DataTypes.UUID, primaryKey: true },
    modelVersion: { type: DataTypes.TEXT, primaryKey: true },
    impressions: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    vehiclesPerKm: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    inVehiclePersonsKm: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    pedestrianDensity: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    personsPresentKm: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    lineOfSightShare: { type: DataTypes.DECIMAL(5, 4), allowNull: false },
    wrapQuality: { type: DataTypes.DECIMAL(5, 4), allowNull: false },
    daypartFactor: { type: DataTypes.DECIMAL(5, 4), allowNull: false },
    observedKmh: { type: DataTypes.DECIMAL(8, 2), allowNull: false },
    baselineKmh: { type: DataTypes.DECIMAL(8, 2), allowNull: false },
    baselineSource: { type: DataTypes.TEXT, allowNull: false },
    computedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'segment_impressions', timestamps: false },
);
