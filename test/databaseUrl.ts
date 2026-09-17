/**
 * Where the test suite is allowed to be destructive.
 *
 * Every integration suite truncates to get a clean slate. Pointed at the
 * development database that deletes the admin account you are signed in with,
 * and the next request from Swagger UI or the portal comes back `401
 * unauthenticated` — which reads as a broken session or a wrong password
 * rather than as a side effect of running the tests. That misdiagnosis is
 * expensive, and it recurs every single time the suite runs.
 *
 * So the suite gets its own database, derived from the development one by
 * suffixing the name. `TEST_DATABASE_URL` overrides it outright for CI, where
 * the database is usually named by the runner.
 */
export function testDatabaseUrl(): string {
  const override = process.env.TEST_DATABASE_URL;
  if (override) return override;

  const base = process.env.DATABASE_URL ?? 'postgres://movead:movead@localhost:5432/movead';
  const url = new URL(base);

  // pathname is "/movead"; an empty name means the URL has no database at all,
  // which is a misconfiguration worth failing on rather than papering over.
  const name = url.pathname.replace(/^\//, '');
  if (!name) {
    throw new Error(`DATABASE_URL has no database name: ${base}`);
  }

  url.pathname = `/${name}_test`;
  return url.toString();
}

/**
 * Whether the test database speaks TLS.
 *
 * Deliberately not just `DATABASE_SSL`. Development points at Azure, which
 * refuses a plaintext connection, while the suite runs against a local
 * Postgres that refuses an encrypted one — so the development setting applied
 * to the test database fails the migration with "The server does not support
 * SSL connections", which reads as a broken harness rather than as one
 * database's setting reaching the other.
 *
 * An explicitly named `TEST_DATABASE_URL` is somewhere other than the
 * development server, so it does not inherit; without one the test database is
 * a sibling on the same server, and does.
 */
export function testDatabaseSsl(): boolean {
  const explicit = process.env.TEST_DATABASE_SSL;
  if (explicit) return explicit === 'true';
  if (process.env.TEST_DATABASE_URL) return false;
  return process.env.DATABASE_SSL === 'true';
}

/** The maintenance database used to issue `CREATE DATABASE`. */
export function maintenanceUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

/** The database name inside a connection URL. */
export function databaseName(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, '');
}
