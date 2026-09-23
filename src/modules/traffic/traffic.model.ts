import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../../db/sequelize';

/**
 * What a road looks like when it is clear, per cell per hour of the week.
 *
 * Derived entirely from `trip_segments`, holds no money, and is referenced by
 * nothing. Deleting the table costs one recompute.
 */
export class SpeedBaseline extends Model<
  InferAttributes<SpeedBaseline>,
  InferCreationAttributes<SpeedBaseline>
> {
  declare id: CreationOptional<string>;
  declare gridKey: string;
  /** Null is the all-week row for this cell — see the migration. */
  declare hourOfWeek: number | null;
  /** NUMERIC, so `pg` hands it back as a string. */
  declare freeFlowKmh: string;
  declare sampleCount: number;
  declare computedAt: CreationOptional<Date>;
}

SpeedBaseline.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    gridKey: { type: DataTypes.TEXT, allowNull: false },
    hourOfWeek: { type: DataTypes.SMALLINT, allowNull: true },
    freeFlowKmh: { type: DataTypes.DECIMAL(6, 2), allowNull: false },
    sampleCount: { type: DataTypes.INTEGER, allowNull: false },
    computedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'speed_baselines', timestamps: false },
);
