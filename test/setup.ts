import { testDatabaseUrl } from './databaseUrl';

/**
 * Runs before any test file imports application code, which matters because
 * `shared/config` reads and freezes the environment at import time.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

/**
 * Redirected before anything connects. The suite truncates tables, so it must
 * never be pointed at the database a developer is signed in against — see
 * `databaseUrl.ts`.
 */
process.env.DATABASE_URL = testDatabaseUrl();
process.env.JWT_ACCESS_SECRET ??= 'test-secret-value-long-enough-to-pass-validation';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-long-enough-to-pass-check';

/**
 * Assigned, not defaulted: a developer who has switched the second factor off
 * in `.env` must not thereby switch it off in the suite that is supposed to
 * prove it works. `mfa-flag.test.ts` opts out for itself, before it imports
 * anything that reads the config.
 */
process.env.ADMIN_MFA_REQUIRED = 'true';

/**
 * The suite never writes mail to disk. Tests that care about an email install a
 * capturing transport (`test/helpers/mail.ts`); this only stops the ones that
 * do not from littering `tmp/mail` on every run.
 */
process.env.MAIL_TRANSPORT = 'file';
process.env.MAIL_PREVIEW_DIR = 'tmp/mail-test';
process.env.CAMPAIGN_IMAGES_DIR = 'tmp/campaign-images-test';

/** Fixed, because tests assert on the links that appear in an invitation. */
process.env.PORTAL_ADVERTISER_URL = 'http://localhost:5173';
process.env.PORTAL_ADMIN_URL = 'http://localhost:5173/admin';
