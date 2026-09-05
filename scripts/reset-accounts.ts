import process from 'node:process';

import { QueryTypes } from 'sequelize';

import { sequelize } from '../src/db/sequelize';

/**
 * Clears accounts so the one-time bootstrap endpoint becomes available again.
 *
 * The usual reason to need this: an admin exists whose TOTP secret only ever
 * lived in the memory of the process that made it. The row blocks bootstrap and
 * nobody can sign in as it, so the account is simultaneously in the way and
 * useless.
 *
 * This is the only routine command that will sign you out. It names the
 * database first, because the whole point of the separate test database is that
 * nothing else does this behind your back.
 *
 * Local development only.
 *
 *   npm run admin:reset
 */

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run against production.');
  }

  const rows = await sequelize.query<{ n: number }>('SELECT count(*)::int AS n FROM users', {
    type: QueryTypes.SELECT,
  });

  await sequelize.query(
    'TRUNCATE users, user_sessions, audit_log, advertisers RESTART IDENTITY CASCADE',
  );

  console.log(`database: ${sequelize.getDatabaseName()}`);
  console.log(`users: ${rows[0]?.n ?? 0} -> 0 (every session ended)`);
  console.log('bootstrap is available again — run `npm run admin:first`');

  await sequelize.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
