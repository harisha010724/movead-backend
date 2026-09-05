import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { app } from '../src/entrypoints/api';
import { ConflictError, ValidationError } from '../src/shared/errors';
import { createApp } from '../src/shared/http/createApp';

describe('health', () => {
  it('reports liveness without touching a dependency', async () => {
    const response = await request(app).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', service: 'api' });
  });
});

describe('error envelope', () => {
  /**
   * `movead-mobile` reads `code` and `message` off the top level of the body.
   * These assertions are the contract with that already-shipped client, so a
   * refactor that nests the envelope has to fail here rather than in the app.
   */
  it('returns a flat body with a correlation id for an unknown route', async () => {
    const response = await request(app).get('/nope');

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('not_found');
    expect(typeof response.body.message).toBe('string');
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });

  it('echoes an inbound request id so one trace spans client and server', async () => {
    const response = await request(app).get('/health/live').set('x-request-id', 'trace-abc');

    expect(response.headers['x-request-id']).toBe('trace-abc');
  });

  it('maps a thrown AppError onto its status and code', async () => {
    const routes = Router();
    routes.get('/boom', () => {
      throw new ConflictError('Already recorded.');
    });

    const response = await request(harness(routes)).get('/boom');

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'conflict', message: 'Already recorded.' });
  });

  it('propagates a rejection from an async handler', async () => {
    const routes = Router();
    routes.get('/async-boom', async () => {
      await Promise.resolve();
      throw new ValidationError({ issues: [{ path: 'mobile', code: 'invalid', message: 'bad' }] });
    });

    const response = await request(harness(routes)).get('/async-boom');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('validation_failed');
    expect(response.body.details).toEqual({
      issues: [{ path: 'mobile', code: 'invalid', message: 'bad' }],
    });
  });

  it('hides the detail of an unexpected throw but keeps the request id', async () => {
    const routes = Router();
    routes.get('/leak', () => {
      throw new Error('connection string postgres://user:password@host/db');
    });

    const response = await request(harness(routes)).get('/leak');

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('internal_error');
    expect(JSON.stringify(response.body)).not.toContain('password');
    expect(response.body.requestId).toBeTruthy();
  });
});

function harness(routes: Router) {
  return createApp({ serviceName: 'test', routers: [{ path: '/', router: routes }] });
}
