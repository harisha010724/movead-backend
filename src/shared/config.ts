import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/*
 * Environment files, most specific first: `.env.production` when the process
 * was launched with NODE_ENV=production, `.env.development` otherwise, with
 * `.env` underneath either as the shared base.
 *
 * Order is precedence. dotenv keeps the first value it sees for a key and never
 * overwrites one already on `process.env`, so a platform variable beats a file
 * and `.env.production` beats `.env` — which is what lets the production file
 * carry only the values that differ.
 *
 * The file is chosen by the NODE_ENV the process was LAUNCHED with, not by the
 * NODE_ENV written inside it. There is no way around that: the file has to be
 * picked before it can be read. `NODE_ENV=production node dist/entrypoints/api.js`
 * reads the production file; a bare `node dist/entrypoints/api.js` does not.
 *
 * A missing file is not an error. The runtime image carries no env file at all,
 * so in Azure both paths miss and the container's own variables are the only
 * source — which is the intended arrangement, not a fallback.
 */
loadDotenv({ path: [`.env.${process.env.NODE_ENV ?? 'development'}`, '.env'] });

/**
 * Every environment variable the process reads, validated once at startup.
 *
 * Nothing else in the codebase touches `process.env`. A missing or malformed
 * variable should stop the process on the first line rather than surface as an
 * `undefined` in a billing query four hours into a shift.
 */

const isProduction = process.env.NODE_ENV === 'production';

/** Long enough that a leaked dev value can never be mistaken for a real one. */
const DEV_SECRET = 'dev-only-insecure-secret-do-not-use-in-production';

const secret = (name: string) =>
  z
    .string()
    .min(32, `${name} must be at least 32 characters`)
    .default(DEV_SECRET)
    .superRefine((value, ctx) => {
      if (isProduction && value === DEV_SECRET) {
        ctx.addIssue({ code: 'custom', message: `${name} must be set in production` });
      }
    });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Set by the deploy pipeline to the image tag; reported by /health. */
  APP_VERSION: z.string().default('0.0.0-dev'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  INGESTION_PORT: z.coerce.number().int().min(1).max(65535).default(8081),

  /**
   * Comma-separated. The advertiser and admin portals are separate origins, and
   * 8081 is `movead-mobile`'s browser preview. The Android build sends no
   * `Origin` header, so it needs no entry — only the preview does.
   */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:5174,http://localhost:8081'),

  /**
   * Where each portal lives, for links the server puts in an email.
   *
   * Locally both products share one origin: advertisers at `/`, operations at
   * `/admin`. Production still uses two hosts.
   */
  PORTAL_ADVERTISER_URL: z.url().default('http://localhost:5173'),
  PORTAL_ADMIN_URL: z.url().default('http://localhost:5173/admin'),
  PORTAL_DRIVER_URL: z.url().default('http://localhost:5173/driver'),

  /**
   * Serves the browsable API reference at `/docs`.
   *
   * Off by default in production. The document is a complete map of every
   * endpoint, its parameters and its error codes — useful to a developer and
   * equally useful to someone probing the surface, and there is no reason for
   * it to be reachable from the public internet.
   */
  DOCS_ENABLED: z.stringbool().default(!isProduction),

  DATABASE_URL: z.url().default('postgres://movead:movead@localhost:5432/movead'),
  DATABASE_SSL: z.stringbool().default(false),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_POOL_MIN: z.coerce.number().int().nonnegative().default(0),
  DATABASE_LOG_SQL: z.stringbool().default(false),

  REDIS_URL: z.url().default('redis://localhost:6379'),

  JWT_ISSUER: z.string().default('movead'),
  JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
  JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),
  /** Architecture Part 12.1: fifteen minutes, held in memory on the device. */
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  /** The refresh token rotates on every use, so a long life is not a long risk. */
  JWT_REFRESH_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 60),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

  /**
   * Web portal sessions. Admin gets a shorter idle window than advertiser
   * (architecture Part 12.1); the absolute ceiling ends a session that stays
   * busy all day, which is the one an unattended terminal keeps alive.
   */
  ADMIN_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(30),
  ADVERTISER_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(120),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(12),

  /**
   * Scopes the session cookie so one sign-in works across both portal origins.
   *
   * The portals are separate origins by design (architecture Part 11.1), and a
   * single login page that redirects by role has to hand the session to
   * whichever one it lands on. `.movead.in` covers both subdomains; leave it
   * unset in development, where localhost ignores the port and the cookie is
   * already shared between the two dev servers.
   */
  COOKIE_DOMAIN: z.string().optional(),

  /** Brute-force protection on password login. Not specified by the ACs. */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),

  TOTP_ISSUER: z.string().default('MoveAd'),
  /** Stands in for the KMS data key until there is a KMS to call. */
  TOTP_ENCRYPTION_KEY: secret('TOTP_ENCRYPTION_KEY'),

  /**
   * Whether an admin must pass TOTP to get a session.
   *
   * Architecture Part 12.1 makes it mandatory for staff, so this exists only to
   * keep the second factor out of the way while the portal screens are still
   * being built. Turning it off skips both enrolment and the code — including
   * for accounts that already have an authenticator — so a stolen admin
   * password is the whole of the login.
   *
   * Refused outright in production rather than merely discouraged.
   */
  ADMIN_MFA_REQUIRED: z
    .stringbool()
    .default(true)
    .superRefine((value, ctx) => {
      if (isProduction && !value) {
        ctx.addIssue({ code: 'custom', message: 'ADMIN_MFA_REQUIRED cannot be false in production' });
      }
    }),

  /**
   * How long an invitation stays usable.
   *
   * Short enough that a link sitting in an abandoned mailbox stops working,
   * long enough to survive a weekend and a customer who reads email on Monday.
   */
  INVITATION_TTL_HOURS: z.coerce.number().int().positive().default(72),

  /**
   * How outgoing mail leaves the process.
   *
   * `file` renders the message to disk and logs the path instead of sending it,
   * so the templates can be designed and reviewed without an SMTP server or a
   * signup. It is refused in production — silently writing a customer's
   * invitation to a directory nobody reads is worse than failing to send it.
   */
  MAIL_TRANSPORT: z
    .enum(['file', 'smtp'])
    .default(isProduction ? 'smtp' : 'file')
    .superRefine((value, ctx) => {
      if (isProduction && value !== 'smtp') {
        ctx.addIssue({ code: 'custom', message: 'MAIL_TRANSPORT must be smtp in production' });
      }
    }),

  /** `smtp://user:pass@host:587`. Required when MAIL_TRANSPORT is smtp. */
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('MoveAd <no-reply@movead.in>'),
  /** Replies from a customer should reach a person, not a disabled mailbox. */
  MAIL_REPLY_TO: z.string().default('support@movead.in'),
  MAIL_PREVIEW_DIR: z.string().default('tmp/mail'),

  /**
   * Where campaign creatives live.
   *
   * `local` writes under CAMPAIGN_IMAGES_DIR, one folder per user
   * (`{userId}/{file}`). Azure Blob is the same interface with a different
   * driver — swap STORAGE_DRIVER when that account exists. The API stores a
   * storage key, never a URL, so the driver can change without rewriting rows.
   */
  STORAGE_DRIVER: z.enum(['local']).default('local'),
  CAMPAIGN_IMAGES_DIR: z.string().default('campaign-images'),

  /*
   * Tracking thresholds.
   *
   * AC-11.2, AC-10.6, AC-18.8 and AC-20.2 all say the same thing in different
   * words: these numbers are tuned during the pilot against real Bengaluru
   * traffic on real handsets, so none of them may require a release to change.
   * The defaults are the spec's starting values, explicitly not final.
   */

  /** AC-11.1: at or under this, a fix is good enough to bill on. */
  GPS_ACCURACY_ELIGIBLE_M: z.coerce.number().positive().default(30),
  /** Between the two, held for review — never billed automatically (AC-11.4). */
  GPS_ACCURACY_REJECT_M: z.coerce.number().positive().default(100),

  /**
   * AC-20.2 / AC-12.3: how long a hole in the trace may be before the two
   * fixes either side of it stop being treated as one journey.
   *
   * Bridging a gap is an assumption about where the vehicle went. Over a few
   * seconds that assumption is safe; over minutes it is the interpolation
   * AC-20.8 forbids, and the distance is dropped instead.
   */
  GPS_MAX_BRIDGE_SECONDS: z.coerce.number().positive().default(120),

  /**
   * AC-18: above this the trace is not describing a car in a city, so the
   * distance is held rather than paid. Generous on purpose — a flagged
   * kilometre costs a driver their earnings until somebody reviews it.
   */
  GPS_MAX_PLAUSIBLE_KMH: z.coerce.number().positive().default(150),

  /**
   * Enables `POST /v1/admin/bootstrap`, which creates the first Super Admin.
   * Unset means the endpoint is not mounted at all — and it refuses anyway
   * once a user exists, so it cannot be used twice.
   */
  ADMIN_BOOTSTRAP_TOKEN: z.string().min(16).optional(),

  /** How long a terminating process waits for in-flight work before killing it. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
}).superRefine((env, ctx) => {
  if (env.MAIL_TRANSPORT === 'smtp' && !env.SMTP_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['SMTP_URL'],
      message: 'SMTP_URL is required when MAIL_TRANSPORT is smtp',
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

function load(): Env {
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  return parsed.data;
}

const env = load();

export const config = {
  env: env.NODE_ENV,
  version: env.APP_VERSION,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  logLevel: env.LOG_LEVEL,
  shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,

  http: {
    apiPort: env.API_PORT,
    ingestionPort: env.INGESTION_PORT,
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    rateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX },
    docsEnabled: env.DOCS_ENABLED,
  },

  database: {
    url: env.DATABASE_URL,
    ssl: env.DATABASE_SSL,
    poolMax: env.DATABASE_POOL_MAX,
    poolMin: env.DATABASE_POOL_MIN,
    logSql: env.DATABASE_LOG_SQL,
  },

  redis: { url: env.REDIS_URL },

  jwt: {
    issuer: env.JWT_ISSUER,
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    refreshTtlSeconds: env.JWT_REFRESH_TTL_SECONDS,
    /** WEB-001: one audience per portal, so a token cannot cross between them. */
    audience: { driver: 'movead-driver', advertiser: 'movead-advertiser', admin: 'movead-admin' },
  },

  session: {
    adminIdleMinutes: env.ADMIN_IDLE_TIMEOUT_MINUTES,
    advertiserIdleMinutes: env.ADVERTISER_IDLE_TIMEOUT_MINUTES,
    absoluteHours: env.SESSION_ABSOLUTE_HOURS,
    cookieDomain: env.COOKIE_DOMAIN ?? null,
  },

  login: {
    maxAttempts: env.LOGIN_MAX_ATTEMPTS,
    lockMinutes: env.LOGIN_LOCK_MINUTES,
  },

  totp: {
    issuer: env.TOTP_ISSUER,
    encryptionKey: env.TOTP_ENCRYPTION_KEY,
    adminRequired: env.ADMIN_MFA_REQUIRED,
  },

  admin: {
    bootstrapToken: env.ADMIN_BOOTSTRAP_TOKEN ?? null,
  },

  portals: {
    advertiser: env.PORTAL_ADVERTISER_URL.replace(/\/$/, ''),
    admin: env.PORTAL_ADMIN_URL.replace(/\/$/, ''),
    driver: env.PORTAL_DRIVER_URL.replace(/\/$/, ''),
  },

  invitations: {
    ttlHours: env.INVITATION_TTL_HOURS,
  },

  mail: {
    transport: env.MAIL_TRANSPORT,
    smtpUrl: env.SMTP_URL ?? null,
    from: env.MAIL_FROM,
    replyTo: env.MAIL_REPLY_TO,
    previewDir: env.MAIL_PREVIEW_DIR,
  },

  storage: {
    driver: env.STORAGE_DRIVER,
    campaignImagesDir: env.CAMPAIGN_IMAGES_DIR,
  },

  tracking: {
    eligibleAccuracyM: env.GPS_ACCURACY_ELIGIBLE_M,
    rejectAccuracyM: env.GPS_ACCURACY_REJECT_M,
    maxBridgeSeconds: env.GPS_MAX_BRIDGE_SECONDS,
    maxPlausibleKmh: env.GPS_MAX_PLAUSIBLE_KMH,
  },
} as const;

export type AppConfig = typeof config;
