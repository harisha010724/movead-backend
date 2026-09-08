import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { app } from '../src/entrypoints/api';

/**
 * The API answers on `/v1` and on `/api/v1`, and they are the same routes.
 *
 * Two prefixes because a browser reaches this service through a proxy that
 * keeps it same-origin — Vite in development, Static Web Apps in production —
 * and that proxy forwards `/api` rather than removing it. Without the alias
 * the proxied call 404s, and it 404s only once deployed, which is the worst
 * time to find out.
 *
 * These assert routing, not behaviour: an unauthenticated call to a guarded
 * route answers 401, and 401 is proof the route exists. A 404 is the failure
 * being guarded against.
 */

const GUARDED = [
  '/v1/auth/me',
  '/v1/admin/notifications',
  '/v1/vehicles/available',
  // The four that used to 404 because they had no server side at all.
  '/v1/dashboard/admin',
  '/v1/dashboard/advertiser',
  '/v1/vehicles',
  '/v1/vehicles/live-positions',
];

describe('api prefix', () => {
  for (const path of GUARDED) {
    it(`serves ${path} under both prefixes`, async () => {
      const direct = await request(app).get(path);
      const proxied = await request(app).get(`/api${path}`);

      expect(direct.status).not.toBe(404);
      expect(proxied.status).toBe(direct.status);
    });
  }

  it('still 404s a path that exists under neither', async () => {
    const direct = await request(app).get('/v1/nothing-here');
    const proxied = await request(app).get('/api/v1/nothing-here');

    expect(direct.status).toBe(404);
    expect(proxied.status).toBe(404);
  });

  it('does not invent a bare /api route', async () => {
    const response = await request(app).get('/api');
    expect(response.status).toBe(404);
  });
});
