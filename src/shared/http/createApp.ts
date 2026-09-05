import cookieParser from 'cookie-parser';
import cors, { type CorsOptions } from 'cors';
import express, { type Express, type Request, type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { config } from '../config';
import { getRequestId } from '../context';
import { ForbiddenError, RateLimitedError } from '../errors';
import { logger } from '../logger';

import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';

export interface AppOptions {
  /** Appears in logs and on the service banner. */
  serviceName: string;
  /** Routers to mount, in order. Health is added automatically. */
  routers: { path: string; router: Router }[];
  /** Defaults to 512kb. Ingestion raises it for 500-point batches. */
  jsonLimit?: string;
  /**
   * Ingestion is rate-limited independently of the API (Part 2.1), so each
   * service passes its own ceiling rather than sharing one.
   */
  rateLimit?: { windowMs: number; max: number } | false;
}

export function createApp(options: AppOptions): Express {
  const app = express();

  // Behind the ALB. Without this, every client IP reads as the load balancer's
  // and the rate limiter throttles the whole fleet as one caller.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors(corsOptions));
  app.use(express.json({ limit: options.jsonLimit ?? '512kb' }));
  // Web portal sessions ride in httpOnly cookies (architecture Part 12.1).
  // Unsigned: the value is an opaque random token validated against the
  // database, so a signature would prove nothing the lookup does not.
  app.use(cookieParser());
  app.use(requestContext());

  app.use(
    pinoHttp({
      logger: logger.child({ service: options.serviceName }),
      genReqId: () => getRequestId() ?? '',
      // The context mixin already stamps the id onto every line.
      customProps: () => ({}),
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  const limits = options.rateLimit === undefined ? config.http.rateLimit : options.rateLimit;
  if (limits !== false) {
    app.use(
      rateLimit({
        windowMs: limits.windowMs,
        limit: limits.max,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        // Probes and the docs page are exempt. One Swagger UI page load pulls
        // a dozen static assets, which would otherwise spend a developer's
        // whole window before they had made a single API call.
        skip: (req) => req.path.startsWith('/health') || req.path.startsWith('/docs'),
        handler: () => {
          throw new RateLimitedError();
        },
      }),
    );
  }

  for (const { path, router } of options.routers) {
    app.use(path, router);
  }

  app.use(notFoundHandler());
  app.use(errorHandler());

  return app;
}

/**
 * An explicit allowlist. The two portals are separate origins by WEB-001, and
 * the mobile app sends no Origin header at all, which is why a missing origin
 * is permitted rather than rejected.
 *
 * Same-origin callers are allowed too. Browsers attach `Origin` to same-origin
 * POSTs as well as cross-origin ones, so without this the Swagger UI at `/docs`
 * is refused by the very server that served it — and more generally, rejecting
 * a request that CORS was never designed to police protects nothing.
 */
function corsOptions(
  req: Request,
  callback: (error: Error | null, options?: CorsOptions) => void,
): void {
  const origin = req.headers.origin;

  if (!origin || config.http.corsOrigins.includes(origin) || isSameOrigin(req, origin)) {
    callback(null, { origin: true, credentials: true, maxAge: 86_400 });
    return;
  }

  callback(new ForbiddenError(`Origin ${origin} is not allowed.`));
}

function isSameOrigin(req: Request, origin: string): boolean {
  const host = req.headers.host;
  return host ? origin === `${req.protocol}://${host}` : false;
}
