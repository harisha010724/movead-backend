import { describe, expect, it } from 'vitest';

import { client } from './helpers/admin';

/**
 * CORS is the one middleware that can reject a request before any handler,
 * auth check or database call runs, which makes a mistake here look like a
 * permissions bug rather than a transport one.
 *
 * These cases use `/v1/auth/login` because a POST is what browsers attach an
 * `Origin` header to. None of them care whether the credentials are valid —
 * only whether the request was allowed to reach the handler at all, so any
 * status other than 403 counts as "not blocked by CORS".
 */

const CREDENTIALS = { email: 'nobody@movead.in', password: 'not-a-real-password' };

async function loginFrom(origin: string | null): Promise<number> {
  const req = client().post('/v1/auth/login');
  if (origin) req.set('Origin', origin);
  const response = await req.send(CREDENTIALS);
  return response.status;
}

describe('cors', () => {
  it('allows the admin portal', async () => {
    expect(await loginFrom('http://localhost:5174')).not.toBe(403);
  });

  it('allows the advertiser portal', async () => {
    expect(await loginFrom('http://localhost:5173')).not.toBe(403);
  });

  it('allows a caller that sends no Origin at all, which is the mobile app', async () => {
    expect(await loginFrom(null)).not.toBe(403);
  });

  it('rejects an origin that is on neither list', async () => {
    expect(await loginFrom('http://evil.example')).toBe(403);
  });

  it('allows the API its own origin, so Swagger UI at /docs can call it', async () => {
    // Supertest binds an ephemeral port, so the real origin is unknowable until
    // runtime. Setting both headers states the case directly instead: this is
    // what the browser sends from the docs page, where Origin and Host name the
    // same server.
    const response = await client()
      .post('/v1/auth/login')
      .set('Host', 'localhost:8080')
      .set('Origin', 'http://localhost:8080')
      .send(CREDENTIALS);

    expect(response.status).not.toBe(403);
  });

  it('rejects an origin that only resembles the host, rather than any origin that asks', async () => {
    const response = await client()
      .post('/v1/auth/login')
      .set('Host', 'localhost:8080')
      .set('Origin', 'http://localhost:9999')
      .send(CREDENTIALS);

    expect(response.status).toBe(403);
  });
});
