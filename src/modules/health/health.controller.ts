import { type Request, type Response } from 'express';

import * as healthService from './health.service';

/**
 * Controllers hold HTTP concerns only: read the request, call the service, map
 * the result onto a status code. Every business rule belongs one layer down
 * (architecture Part 4.2).
 */

export function getLiveness(service: string) {
  return (_req: Request, res: Response): void => {
    res.json(healthService.liveness(service));
  };
}

export function getReadiness(service: string) {
  return async (_req: Request, res: Response): Promise<void> => {
    const report = await healthService.readiness(service);
    res.status(report.status === 'ready' ? 200 : 503).json(report);
  };
}
