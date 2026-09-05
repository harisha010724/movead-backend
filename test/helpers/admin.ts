import request from 'supertest';

import { app } from '../../src/entrypoints/api';
import { currentTotp } from '../../src/modules/identity/credentials';

/** The first-run admin path, shared by every suite that needs a signed-in admin. */

export const BOOTSTRAP_TOKEN =
  process.env.ADMIN_BOOTSTRAP_TOKEN ?? 'local-bootstrap-token-change-me';

export const ADMIN = {
  email: 'ops@movead.in',
  fullName: 'Ops Admin',
  password: 'correct-horse-battery-staple',
};

/**
 * A fresh agent with its own client IP.
 *
 * The sign-in limiter allows ten attempts per IP per fifteen minutes, and it
 * stays switched on during tests — a suite that passes only because a rate
 * limit was disabled has not tested the thing that ships. Giving each test a
 * distinct forwarded IP isolates them and incidentally proves the limiter keys
 * on the caller rather than on the proxy.
 */
let nextIp = 0;

export function client() {
  nextIp += 1;
  const octet = nextIp % 250;
  const block = Math.floor(nextIp / 250);
  return request.agent(app).set('X-Forwarded-For', `10.0.${String(block)}.${String(octet + 1)}`);
}

export type Agent = ReturnType<typeof client>;

export function bootstrap(agent: Agent) {
  return agent
    .post('/v1/admin/bootstrap')
    .send({ ...ADMIN, token: BOOTSTRAP_TOKEN })
    .expect(201);
}

/** The whole first-run path: bootstrap, enrol an authenticator, sign in. */
export async function signIn(): Promise<Agent> {
  const agent = client();
  await bootstrap(agent);
  await enrolAndVerify(agent, ADMIN.email, ADMIN.password);
  return agent;
}

/**
 * Password, then first-time authenticator enrolment, then the code. The path
 * every admin walks once, and the only way an admin ever gets a session.
 */
export async function enrolAndVerify(
  agent: Agent,
  email: string,
  password: string,
): Promise<void> {
  const login = await agent.post('/v1/auth/login').send({ email, password }).expect(200);
  const enrol = await agent
    .post('/v1/auth/mfa/enrol')
    .send({ challengeToken: login.body.challengeToken })
    .expect(200);

  await agent
    .post('/v1/auth/mfa/verify')
    .send({
      challengeToken: login.body.challengeToken,
      code: await currentTotp(String(enrol.body.secret)),
    })
    .expect(200);
}
