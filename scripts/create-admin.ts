import process from 'node:process';

import { currentTotp } from '../src/modules/identity/credentials';

/**
 * Creates an admin account through the real API, signing in as an existing one.
 *
 * `POST /v1/admin/users` requires an authenticated admin holding `user.create`,
 * which is correct — it mints SUPER_ADMIN accounts, and an open endpoint that
 * does that is a back door. The consequence is that reaching it from Swagger UI
 * means signing in on the page first, which is easy to forget and produces a
 * `401` that reads like an expired session.
 *
 * This does the sign-in and the create in one step, so a second admin can be
 * added without a browser.
 *
 *   npm run admin:create -- --email you@example.com --name "Your Name" --password "..."
 *
 * The signing-in account defaults to the one `admin:first` makes. Override with
 * `--as-email` and `--as-password`.
 */

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i]?.replace(/^--/, '') ?? '', process.argv[i + 1] ?? '');
}

const base = args.get('api') ?? process.env.API_URL ?? 'http://localhost:8080';

const email = args.get('email');
const fullName = args.get('name');
const password = args.get('password');
const roleKey = args.get('role') ?? 'SUPER_ADMIN';

const asEmail = args.get('as-email') ?? 'ops@movead.in';
const asPassword = args.get('as-password') ?? 'correct-horse-battery-staple';
const asTotpSecret = args.get('as-totp');

interface AdminUser {
  email: string;
  fullName: string;
  roles: string[];
}

interface Challenge {
  status: string;
  audience: string;
  challengeToken: string;
}

async function call<T>(
  path: string,
  body: unknown,
  cookie?: string,
): Promise<{ body: T; setCookie: string | null }> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`${path} → ${String(response.status)} ${text}`);
  }

  return { body: parsed as T, setCookie: response.headers.get('set-cookie') };
}

async function signIn(): Promise<string> {
  const login = await call<Challenge>('/v1/auth/login', {
    email: asEmail,
    password: asPassword,
  });

  if (login.body.status === 'authenticated') {
    return (login.setCookie ?? '').split(';')[0] ?? '';
  }

  // MFA is on, so the password was only the first half of the sign-in.
  if (!asTotpSecret) {
    throw new Error(
      `${asEmail} needs a second factor. Pass --as-totp <secret>, or set ADMIN_MFA_REQUIRED=false.`,
    );
  }

  const verify = await call<AdminUser>('/v1/auth/mfa/verify', {
    challengeToken: login.body.challengeToken,
    code: await currentTotp(asTotpSecret),
  });

  return (verify.setCookie ?? '').split(';')[0] ?? '';
}

async function main(): Promise<void> {
  if (!email || !fullName || !password) {
    throw new Error('Pass --email, --name and --password');
  }

  const cookie = await signIn();
  console.log(`1. signed in as ${asEmail}`);

  const created = await call<AdminUser>(
    '/v1/admin/users',
    { email, fullName, password, roleKey },
    cookie,
  );

  console.log(`2. created ${created.body.email} as ${created.body.roles.join(', ')}`);
  console.log(`\nSign in at either portal, or in Swagger UI, with that email and password.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
