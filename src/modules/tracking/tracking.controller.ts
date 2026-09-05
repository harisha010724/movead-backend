import type { Request, Response } from 'express';

import {
  StartSessionRequestSchema,
  StopSessionRequestSchema,
  TrackingPointsRequestSchema,
} from '../../contracts/tracking';
import { currentUser } from '../../shared/http/middleware/auth';
import { parseBody } from '../../shared/http/validate';

import * as tracking from './tracking.service';

function requireDriverId(req: Request): string {
  const { driverId } = currentUser(req).user;
  if (!driverId) throw new Error('Driver session is missing driverId');
  return driverId;
}

export async function startSession(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, StartSessionRequestSchema);
  res.json(
    await tracking.startSession({
      driverId: requireDriverId(req),
      startedAt: body.startedAt ?? null,
    }),
  );
}

export async function readSession(req: Request, res: Response): Promise<void> {
  res.json(await tracking.currentSession(requireDriverId(req)));
}

export async function stopSession(req: Request, res: Response): Promise<void> {
  // A phone stopping on a dying battery may send no body at all, and refusing
  // over a missing optional field would leave the session open and the vehicle
  // unable to start the next one.
  req.body ??= {};
  const body = parseBody(req, StopSessionRequestSchema);
  res.json(
    await tracking.stopSession({
      driverId: requireDriverId(req),
      reason: body.reason ?? null,
    }),
  );
}

export async function ingestPoints(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, TrackingPointsRequestSchema);
  res.json(
    await tracking.ingestPoints({
      driverId: requireDriverId(req),
      sessionId: body.sessionId,
      points: body.points,
    }),
  );
}
