import process from 'node:process';

import { QueryTypes } from 'sequelize';

import { sequelize } from '../src/db/sequelize';
import { config } from '../src/shared/config';

/**
 * Answers "why am I getting 401?" without guessing.
 *
 * A `401 unauthenticated` from an admin endpoint has three ordinary causes and
 * they are indistinguishable from the response body: no account, no session, or
 * a session that has idled out. This prints which one it is.
 *
 * Read-only. It will not sign you out.
 *
 *   npm run admin:sessions
 */

interface UserRow {
  email: string;
  full_name: string;
  created_at: Date;
}

interface SessionRow {
  email: string;
  audience: string;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  idle_minutes: number;
}

const minutes = (value: number) => `${Math.floor(value)}m`;

async function main(): Promise<void> {
  console.log(`database: ${sequelize.getDatabaseName()}\n`);

  const users = await sequelize.query<UserRow>(
    'SELECT email, full_name, created_at FROM users ORDER BY created_at',
    { type: QueryTypes.SELECT },
  );

  if (users.length === 0) {
    console.log('No accounts. Run `npm run admin:first`.');
    await sequelize.close();
    return;
  }

  console.log(`accounts (${users.length}):`);
  for (const user of users) {
    console.log(`  ${user.email}  ${user.full_name}`);
  }

  const sessions = await sequelize.query<SessionRow>(
    `SELECT u.email,
            s.audience,
            s.last_seen_at,
            s.expires_at,
            s.revoked_at,
            EXTRACT(EPOCH FROM (now() - s.last_seen_at)) / 60 AS idle_minutes
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.revoked_at IS NULL
        AND s.expires_at > now()
      ORDER BY s.last_seen_at DESC`,
    { type: QueryTypes.SELECT },
  );

  console.log(`\nlive sessions (${sessions.length}):`);
  if (sessions.length === 0) {
    console.log('  none — sign in again, then retry the call');
  }

  for (const session of sessions) {
    const idle = Number(session.idle_minutes);
    const limit =
      session.audience === 'admin'
        ? config.session.adminIdleMinutes
        : config.session.advertiserIdleMinutes;

    // Idle past the limit is a session the API will reject on the next request,
    // even though the row is still here and looks alive.
    const state = idle > limit ? `IDLED OUT (${minutes(idle)} > ${limit}m)` : `idle ${minutes(idle)}`;
    console.log(`  ${session.email}  ${session.audience}  ${state}`);
  }

  console.log(
    `\nA browser session lives in a cookie. Signing in from a script sets one` +
      ` in that script, not in Swagger UI — sign in from the page you are calling from.`,
  );

  await sequelize.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
