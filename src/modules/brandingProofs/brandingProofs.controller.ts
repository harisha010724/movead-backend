import { type Request, type Response } from 'express';

import { IdParamSchema } from '../../contracts/common';
import {
  BrandingPhotoQuerySchema,
  PhotoIdParamSchema,
} from '../../contracts/brandingProofs';
import { BadRequestError } from '../../shared/errors';
import { currentUser } from '../../shared/http/middleware/auth';
import { parseParams, parseQuery } from '../../shared/http/validate';

import * as proofs from './brandingProofs.service';

function actor(req: Request): proofs.Actor {
  return { userId: currentUser(req).user.id };
}

function requireDriverId(req: Request): string {
  const { driverId } = currentUser(req).user;
  if (!driverId) throw new Error('Driver session is missing driverId');
  return driverId;
}

export async function request(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  res.status(201).json(await proofs.requestProof({ assignmentId: id, actor: actor(req) }));
}

export async function queue(_req: Request, res: Response): Promise<void> {
  res.json({ items: await proofs.reviewQueue() });
}

export async function waiting(_req: Request, res: Response): Promise<void> {
  res.json({ items: await proofs.outstanding() });
}

export async function eligible(_req: Request, res: Response): Promise<void> {
  res.json({ items: await proofs.eligibleAssignments() });
}

export async function photoFile(req: Request, res: Response): Promise<void> {
  const { photoId } = parseParams(req, PhotoIdParamSchema);
  const stored = await proofs.readPhoto(photoId);
  res.setHeader('content-type', stored.contentType);
  res.setHeader('content-disposition', `inline; filename="${stored.fileName}"`);
  res.send(stored.bytes);
}

export async function current(req: Request, res: Response): Promise<void> {
  res.json(await proofs.currentForDriver(requireDriverId(req)));
}

export async function start(req: Request, res: Response): Promise<void> {
  res.status(201).json(await proofs.startForDriver(requireDriverId(req)));
}

export async function uploadPhoto(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const query = parseQuery(req, BrandingPhotoQuerySchema);
  const file = req.file;
  if (!file) throw new BadRequestError('Attach a photo.');

  res.status(201).json(
    await proofs.uploadPhoto({
      proofId: id,
      driverId: requireDriverId(req),
      angle: query.angle,
      fileName: file.originalname,
      contentType: file.mimetype,
      bytes: file.buffer,
      lat: query.lat,
      lon: query.lon,
      capturedAt: query.capturedAt,
    }),
  );
}

export async function submit(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  res.json(await proofs.submitProof({ proofId: id, driverId: requireDriverId(req) }));
}

export async function driverPhoto(req: Request, res: Response): Promise<void> {
  const { photoId } = parseParams(req, PhotoIdParamSchema);
  const stored = await proofs.readPhotoForDriver(photoId, requireDriverId(req));
  res.setHeader('content-type', stored.contentType);
  res.setHeader('content-disposition', `inline; filename="${stored.fileName}"`);
  res.send(stored.bytes);
}
