import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { forwardedFor } from '../src/shared/http/middleware/forwardedFor';

/**
 * Azure App Service forwards `203.0.113.5:54321`, not the bare address. That
 * value reaches Postgres as an `INET` on every session and audit row, so a port
 * left on it fails the insert and rolls the request back — which is what a
 * bootstrap or a sign-in surfaces as a 500.
 *
 * These build the app the same way `createApp` does, since what is under test
 * is what `proxy-addr` makes of the header rather than the header itself.
 */
function appWith(trustProxy: number): Express {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use(forwardedFor());
  app.get('/ip', (req, res) => {
    res.json({ ip: req.ip, ips: req.ips });
  });

  return app;
}

async function ipFor(header: string): Promise<string> {
  const response = await request(appWith(1)).get('/ip').set('X-Forwarded-For', header);
  return (response.body as { ip: string }).ip;
}

describe('forwardedFor', () => {
  it('drops the port Azure appends to an IPv4 address', async () => {
    expect(await ipFor('203.0.113.5:54321')).toBe('203.0.113.5');
  });

  it('leaves an address that already arrives without a port alone', async () => {
    expect(await ipFor('203.0.113.5')).toBe('203.0.113.5');
  });

  it('keeps a bare IPv6 address whole, colons and all', async () => {
    expect(await ipFor('2001:db8::1')).toBe('2001:db8::1');
  });

  it('unwraps a bracketed IPv6 address with a port', async () => {
    expect(await ipFor('[2001:db8::1]:443')).toBe('2001:db8::1');
  });

  it('cleans every hop, not only the one req.ip happens to select', async () => {
    // Two trusted hops, so the address chosen is the left-hand entry — the one
    // a single-hop test never reads.
    const response = await request(appWith(2))
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.7:1111, 203.0.113.5:54321');

    expect((response.body as { ip: string }).ip).toBe('198.51.100.7');
  });

  it('passes a request with no forwarding header through untouched', async () => {
    const response = await request(appWith(1)).get('/ip');
    expect((response.body as { ip: string }).ip).toBeTruthy();
  });
});
