import { type Sequelize } from 'sequelize';

import { sequelize } from '../sequelize';

/**
 * Model registry.
 *
 * Sequelize owns the domain tables — drivers, vehicles, campaigns, users. It
 * does not own the pipeline: classification, allocation and billing are raw
 * parameterised SQL in `src/db/sql`, because they are set operations over
 * geometry that an ORM can only get in the way of (architecture Part 1.2).
 *
 * Each module defines its own model beside its service and registers it here,
 * so associations are declared in one place after every model exists.
 */

export function initModels(_db: Sequelize = sequelize): void {
  // e.g. defineDriver(db); defineVehicle(db); then the associations.
}

export { sequelize };
