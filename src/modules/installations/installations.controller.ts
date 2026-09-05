import { type Request, type Response } from 'express';

import {
  AssignVehiclesSchema,
  InstallationPhotoQuerySchema,
  PhotoIdParamSchema,
} from '../../contracts/installations';
import { IdParamSchema } from '../../contracts/common';
import { ReasonBodySchema } from '../../contracts/drivers';
import { BadRequestError } from '../../shared/errors';
import { parseBody, parseParams, parseQuery } from '../../shared/http/validate';
import { currentUser } from '../../shared/http/middleware/auth';

import * as installations from './installations.service';

function actor(req: Request): installations.Actor {
  return { userId: currentUser(req).user.id, ip: req.ip ?? null };
}

function requireDriverId(req: Request): string {
  const { driverId } = currentUser(req).user;
  if (!driverId) throw new Error('Driver session is missing driverId');
  return driverId;
}

// --- Admin ---------------------------------------------------------------

export async function assign(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const body = parseBody(req, AssignVehiclesSchema);
  res.status(201).json(
    await installations.assignVehicles({
      campaignId: id,
      vehicleIds: body.vehicleIds,
      overrideReason: body.overrideReason,
      actor: actor(req),
    }),
  );
}

export async function listForCampaign(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  res.json({
    items: await installations.listAssignments(id),
    summary: await installations.assignmentSummary(id),
  });
}

export async function unassign(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const { reason } = parseBody(req, ReasonBodySchema);
  res.json(await installations.unassign({ assignmentId: id, reason, actor: actor(req) }));
}

export async function queue(_req: Request, res: Response): Promise<void> {
  res.json({ items: await installations.reviewQueue() });
}

export async function photos(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  res.json({ items: await installations.listPhotos(id) });
}

export async function uploadPhoto(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const { angle } = parseQuery(req, InstallationPhotoQuerySchema);
  const file = req.file;
  if (!file) throw new BadRequestError('Attach a photo.');

  res.status(201).json(
    await installations.uploadPhoto({
      assignmentId: id,
      angle,
      fileName: file.originalname,
      contentType: file.mimetype,
      bytes: file.buffer,
      actor: actor(req),
    }),
  );
}

export async function photoFile(req: Request, res: Response): Promise<void> {
  const { photoId } = parseParams(req, PhotoIdParamSchema);
  const stored = await installations.readPhoto(photoId);
  res.setHeader('content-type', stored.contentType);
  res.setHeader('content-disposition', `inline; filename="${stored.fileName}"`);
  res.send(stored.bytes);
}

export async function submit(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  res.json(await installations.submitInstallation({ assignmentId: id, actor: actor(req) }));
}

export async function approve(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  res.json(await installations.approveInstallation({ assignmentId: id, actor: actor(req) }));
}

export async function reject(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const { reason } = parseBody(req, ReasonBodySchema);
  res.json(
    await installations.rejectInstallation({ assignmentId: id, reason, actor: actor(req) }),
  );
}

// --- Driver --------------------------------------------------------------

export async function driverCampaign(req: Request, res: Response): Promise<void> {
  res.json(await installations.driverCampaign(requireDriverId(req)));
}

export async function driverEligibility(req: Request, res: Response): Promise<void> {
  res.json(await installations.eligibility(requireDriverId(req)));
}

export async function driverAccept(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  res.json(
    await installations.acceptAssignment({
      driverId: requireDriverId(req),
      assignmentId: id,
      actor: actor(req),
    }),
  );
}

export async function driverCreative(req: Request, res: Response): Promise<void> {
  const stored = await installations.driverCreative(requireDriverId(req));
  res.setHeader('content-type', stored.contentType);
  res.setHeader('content-disposition', `inline; filename="${stored.fileName}"`);
  res.send(stored.bytes);
}
