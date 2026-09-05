import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from 'pg';

import { databaseName, maintenanceUrl, testDatabaseUrl } from './databaseUrl';

const run = promisify(execFile);

/**
 * Creates the test database and brings its schema up to date.
 *
 * Doing this here rather than in a README instruction means the suite cannot be
 * run against the development database by someone who has not read the README —
 * which is the failure this whole arrangement exists to prevent.
 */
async function prepareDatabase(url: string): Promise<boolean> {
  const admin = new Client({ connectionString: maintenanceUrl(url) });

  try {
    await admin.connect();
  } catch {
    return false;
  }

  try {
    const name = databaseName(url);
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);

    if (rows.length === 0) {
      // The name is derived from DATABASE_URL, not user input, and CREATE
      // DATABASE takes no parameters — hence the interpolation.
      await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
      console.warn(`\n  Created test database ${name}\n`);
    }
  } finally {
    await admin.end();
  }

  await run('npx', ['sequelize-cli', 'db:migrate'], {
    env: { ...process.env, DATABASE_URL: url },
    shell: process.platform === 'win32',
  });

  return true;
}

/**
 * Serialises whole test runs against the shared database.
 *
 * `fileParallelism: false` keeps one file at a time inside a single run, but it
 * cannot see a second `vitest` process. Two runs overlapping is not a subtle
 * problem: each suite truncates to get a clean slate, so one run deletes the
 * rows the other is mid-way through asserting on. It surfaces as bootstrap
 * returning 409, sign-in returning 401 and the lockout case returning 200 —
 * eight failures that read like a broken privilege boundary and are nothing of
 * the kind. That misdiagnosis is expensive enough to be worth preventing.
 *
 * A session-level advisory lock is the cheapest fix available. It costs one
 * connection, needs no table, and Postgres releases it automatically if the
 * process dies, so a killed run cannot wedge the next one.
 */

/** Arbitrary but fixed. Any other lock in this database must not reuse it. */
const LOCK_KEY = 8_140_2026;

const WAIT_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 500;

let client: Client | null = null;

export async function setup(): Promise<void> {
  const url = testDatabaseUrl();

  // No server reachable. Every integration suite already skips itself in that
  // case, so failing here would turn a runnable checkout into an unrunnable one.
  if (!(await prepareDatabase(url))) return;

  const candidate = new Client({ connectionString: url });

  try {
    await candidate.connect();
  } catch {
    return;
  }

  client = candidate;

  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let waiting = false;

  for (;;) {
    const { rows } = await candidate.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [LOCK_KEY],
    );

    if (rows[0]?.locked) break;

    if (Date.now() > deadline) {
      throw new Error(
        'Another test run has held the database lock for five minutes. ' +
          'Check for a stray `vitest` process before retrying.',
      );
    }

    if (!waiting) {
      waiting = true;
      console.warn('\n  Waiting for another test run to release the database…\n');
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export async function teardown(): Promise<void> {
  if (!client) return;

  // Closing the connection would release the lock anyway; unlocking explicitly
  // means a leaked client cannot keep the next run waiting.
  await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  await client.end();
  client = null;
}
