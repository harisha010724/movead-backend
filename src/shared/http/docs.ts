import { Router } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';

import { buildOpenApiDocument } from '../../contracts';
import { config } from '../config';
import { loggerFor } from '../logger';

/**
 * The browsable API reference, served from the same origin as the API itself.
 *
 * Same-origin matters more than it looks. Authentication is an httpOnly
 * `SameSite=Strict` session cookie, so "Try it out" only works if the request
 * comes from the API's own origin — a docs page hosted anywhere else could
 * render every endpoint and exercise none of the authenticated ones.
 *
 * The document is generated from the same Zod schemas the handlers validate
 * with, so it cannot drift: `npm run openapi:check` fails the build when the
 * committed JSON no longer matches the code.
 */
export function docsRoutes(): Router {
  const router = Router();

  // Built once. The schemas are static after import, and regenerating a 38 kB
  // document on every page load would be work done for nobody's benefit.
  const document = buildOpenApiDocument();

  router.get('/openapi.json', (_req, res) => {
    res.json(document);
  });

  if (!config.http.docsEnabled) {
    loggerFor('http').info('DOCS_ENABLED is false — /docs not mounted');
    return router;
  }

  router.use(
    '/docs',
    /**
     * Swagger UI ships inline styles and inline bootstrap script, which the
     * global `helmet()` default policy blocks — the page renders blank with
     * CSP violations in the console.
     *
     * This relaxation is scoped to `/docs` and nowhere else: the header set
     * here replaces the global one for these responses only, so no API route
     * loses its protection. `/docs` serves static assets and no user data, and
     * it is off in production anyway.
     */
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
        },
      },
    }),
    swaggerUi.serve,
    swaggerUi.setup(document, {
      customSiteTitle: 'MoveAd API',
      swaggerOptions: {
        // Send the session cookie with "Try it out" requests. Without it every
        // guarded endpoint answers 401 and the page looks broken.
        withCredentials: true,
        persistAuthorization: true,
        // Endpoints in the order the registry declares them, which groups a
        // resource's operations together instead of alphabetising them apart.
        operationsSorter: undefined,
        docExpansion: 'none',
        filter: true,
      },
    }),
  );

  return router;
}
