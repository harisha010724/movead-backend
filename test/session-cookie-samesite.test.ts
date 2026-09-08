import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { crossSite, sessionCookie } from '../src/modules/identity/session-cookie';

/**
 * The session cookie's `SameSite`, which decides whether a portal on another
 * host stays signed in.
 *
 * `Strict` is the rule. The exception is a caller the browser would never send
 * a `Strict` cookie back to: there, `Strict` buys no strictness, only a login
 * that appears to work and then 401s on everything after it.
 *
 * Driven through the real functions on a bare route, because what is under
 * test is which pairs of hosts count as one site — no database, password or
 * MFA involved.
 */

interface Case {
  name: string;
  origin?: string;
  host: string;
  cookieDomain?: string;
  expected: 'strict' | 'none';
}

const CASES: Case[] = [
  {
    name: 'no Origin at all — the mobile app, with no SameSite rule to satisfy',
    host: 'api.example.com',
    expected: 'strict',
  },
  {
    name: 'the page and the API on one origin',
    origin: 'http://api.example.com',
    host: 'api.example.com',
    expected: 'strict',
  },
  {
    name: 'a proxied call, where the browser only ever saw one host',
    origin: 'http://portal.example.com',
    host: 'portal.example.com',
    expected: 'strict',
  },
  {
    name: 'subdomains sharing the configured COOKIE_DOMAIN',
    origin: 'https://app.movead.in',
    host: 'api.movead.in',
    cookieDomain: '.movead.in',
    expected: 'strict',
  },
  {
    name: 'the deployment that broke: the static app calling the API by name',
    origin: 'https://icy-mushroom-043c2f900.6.azurestaticapps.net',
    host: 'movead-api-ena2d4b6atfkh0fk.centralindia-01.azurewebsites.net',
    expected: 'none',
  },
  {
    name: 'unrelated hosts, with COOKIE_DOMAIN set for a different domain',
    origin: 'https://app.somewhere-else.net',
    host: 'api.movead.in',
    cookieDomain: '.movead.in',
    expected: 'none',
  },
  {
    name: 'a lookalike that merely ends in the same letters',
    origin: 'https://app.notmovead.in',
    host: 'api.movead.in',
    cookieDomain: '.movead.in',
    expected: 'none',
  },
  {
    name: 'a malformed Origin is not treated as another site',
    origin: 'not-a-url',
    host: 'api.movead.in',
    expected: 'strict',
  },
];

describe('session cookie SameSite', () => {
  for (const testCase of CASES) {
    it(testCase.name, async () => {
      const app = appWith(testCase.cookieDomain ?? null);

      let call = request(app).get('/').set('Host', testCase.host);
      if (testCase.origin) call = call.set('Origin', testCase.origin);

      const cookie = String((await call).headers['set-cookie']);

      expect(cookie.toLowerCase()).toContain(`samesite=${testCase.expected}`);
      expect(cookie).toContain('HttpOnly');

      // `SameSite=None` is discarded without it, so the pair has to hold even
      // here, where the context passed in says `secure: false`.
      if (testCase.expected === 'none') expect(cookie).toContain('Secure');
    });
  }

  it('clears with the same attributes it set, or the browser keeps the cookie', async () => {
    const app = appWith(null);
    const host = 'movead-api.azurewebsites.net';
    const origin = 'https://portal.azurestaticapps.net';

    const set = String((await request(app).get('/').set({ Host: host, Origin: origin })).headers['set-cookie']);
    const cleared = String(
      (await request(app).get('/clear').set({ Host: host, Origin: origin })).headers['set-cookie'],
    );

    for (const attribute of ['SameSite=None', 'Secure', 'HttpOnly', 'Path=/']) {
      expect(set).toContain(attribute);
      expect(cleared).toContain(attribute);
    }
  });
});

function appWith(cookieDomain: string | null): Express {
  const app = express();
  const options = (req: express.Request, expires: Date) =>
    sessionCookie(expires, crossSite(req, cookieDomain), { cookieDomain, secure: false });

  app.get('/', (req, res) => {
    res.cookie('movead_admin_session', 'token', options(req, new Date(Date.now() + 60_000)));
    res.status(204).send();
  });

  app.get('/clear', (req, res) => {
    res.clearCookie('movead_admin_session', options(req, new Date(0)));
    res.status(204).send();
  });

  return app;
}
