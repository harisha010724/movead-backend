import pg from 'pg';
import { Sequelize } from 'sequelize';

import { config } from '../shared/config';
import { loggerFor } from '../shared/logger';

const log = loggerFor('db');

/**
 * NUMERIC must never become a JavaScript number.
 *
 * `node-postgres` already returns OID 1700 as a string, but the guarantee is
 * load-bearing enough to state rather than inherit: a rate of 2.7500 that
 * round-trips through a float is a rounding error in someone's payout.
 * Architecture Part 9.1.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value: string) => value);
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => value);

export const sequelize = new Sequelize(config.database.url, {
  dialect: 'postgres',
  dialectModule: pg,
  logging: config.database.logSql ? (sql: string) => log.debug({ sql }, 'query') : false,
  pool: {
    max: config.database.poolMax,
    min: config.database.poolMin,
    idle: 10_000,
    acquire: 30_000,
  },
  dialectOptions: config.database.ssl
    ? { ssl: { require: true, rejectUnauthorized: false } }
    : undefined,
  define: {
    // The schema is snake_case (see MoveAd-Database-Design.md §1); models are
    // camelCase. Sequelize maps between them rather than either side bending.
    underscored: true,
    freezeTableName: true,
    timestamps: false,
  },
});

/** Readiness probe. Cheap enough to run on every check. */
export async function pingDatabase(): Promise<void> {
  await sequelize.query('SELECT 1');
}

export async function closeDatabase(): Promise<void> {
  await sequelize.close();
  log.info('database pool closed');
}
