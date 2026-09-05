import process from 'node:process';

import { currentTotp } from '../src/modules/identity/credentials';

/**
 * Walks the first-run admin path against a running API: bootstrap, enrol an
 * authenticator, sign in, read `/v1/auth/me`.
 *
 * A convenience for local development and a live check that the flow works
 * end to end. It calls the same public endpoints the admin portal will, so it
 * has no privileged access of its own.
 *
 *   npm run admin:first -- --email ops@movead.in --name "Ops Admin" --password "..."
 */

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i]?.replace(/^--/, '') ?? '', process.argv[i + 1] ?? '');
}

const base = args.get('api') ?? process.env.API_URL ?? 'http://localhost:8080';
const token = args.get('token') ?? process.env.ADMIN_BOOTSTRAP_TOKEN ?? '';
const email = args.get('email') ?? 'ops@movead.in';
const fullName = args.get('name') ?? 'Ops Admin';
const password = args.get('password') ?? 'correct-horse-battery-staple';

interface AdminUser {
  email: string;
  fullName: string;
  roles: string[];
  permissions: string[];
}

interface Challenge {
  status: string;
  audience: string;
  challengeToken: string;
}

interface Enrolment {
  secret: string;
  otpauthUri: string;
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

async function main(): Promise<void> {
  if (!token) throw new Error('Set ADMIN_BOOTSTRAP_TOKEN or pass --token');

  const created = await call<AdminUser>('/v1/admin/bootstrap', {
    token,
    email,
    fullName,
    password,
  });
  console.log(`1. bootstrapped ${created.body.email} as ${created.body.roles.join(', ')}`);

  const login = await call<Challenge>('/v1/auth/login', { email, password });
  console.log(`2. password accepted → ${login.body.status} (audience: ${login.body.audience})`);

  // With ADMIN_MFA_REQUIRED=false the password is the whole of the login, so
  // there is no challenge to enrol against and the session already exists.
  const enrolled = login.body.status !== 'authenticated';

  let secret: string | null = null;
  let sessionCookie = login.setCookie;

  if (enrolled) {
    const enrol = await call<Enrolment>('/v1/auth/mfa/enrol', {
      challengeToken: login.body.challengeToken,
    });
    secret = enrol.body.secret;
    console.log(`3. authenticator secret ${enrol.body.secret}`);
    console.log(`   ${enrol.body.otpauthUri}`);

    const verify = await call<AdminUser>('/v1/auth/mfa/verify', {
      challengeToken: login.body.challengeToken,
      code: await currentTotp(enrol.body.secret),
    });
    sessionCookie = verify.setCookie;
  } else {
    console.log('3. second factor skipped — ADMIN_MFA_REQUIRED is false');
  }

  const cookie = (sessionCookie ?? '').split(';')[0] ?? '';
  console.log(`4. signed in, session cookie set (${cookie.split('=')[0] ?? ''})`);

  const me = await call<AdminUser>('/v1/auth/me', undefined, cookie);
  console.log(`5. /v1/auth/me → ${me.body.fullName}, ${me.body.permissions.length} permissions`);

  console.log(
    secret
      ? '\nScan the otpauth URI above into an authenticator app before the next sign-in.'
      : '\nSign in with the password alone. Turn ADMIN_MFA_REQUIRED back on to enrol.',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
