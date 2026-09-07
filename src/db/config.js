/* eslint-disable */
// Configuration for sequelize-cli only. The application builds its own
// Sequelize instance in `src/db/sequelize.ts`; this file exists because the
// CLI is a separate process that never loads the TypeScript source.
// The same layering as src/shared/config.ts. The CLI is a separate process, so
// without this `NODE_ENV=production npm run db:migrate` would read `.env` while
// the application read `.env.production` — and the migration would run against
// the development database while every log line said production.
require('dotenv').config({
  path: [`.env.${process.env.NODE_ENV ?? 'development'}`, '.env'],
});

const url = process.env.DATABASE_URL ?? 'postgres://movead:movead@localhost:5432/movead';
const ssl = process.env.DATABASE_SSL === 'true';

const base = {
  url,
  dialect: 'postgres',
  migrationStorageTableName: 'sequelize_meta',
  seederStorage: 'sequelize',
  seederStorageTableName: 'sequelize_seeds',
  dialectOptions: ssl ? { ssl: { require: true, rejectUnauthorized: false } } : {},
};

module.exports = {
  development: base,
  test: base,
  production: base,
};
