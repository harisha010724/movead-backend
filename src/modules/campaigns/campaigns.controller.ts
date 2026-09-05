import { type Request, type Response } from 'express';

import {
  AvailableVehiclesRequestSchema,
  CampaignHaltRequestSchema,
  CampaignListQuerySchema,
  CampaignRejectRequestSchema,
  CreateCampaignRequestSchema,
  CreativeKeyParamSchema,
  EstimateCampaignRequestSchema,
} from '../../contracts/campaigns';
import { IdParamSchema } from '../../contracts/common';
import * as drivers from '../drivers/drivers.service';
import { BadRequestError, ForbiddenError } from '../../shared/errors';
import { currentUser } from '../../shared/http/middleware/auth';
import { parseBody, parseParams, parseQuery } from '../../shared/http/validate';

import * as campaigns from './campaigns.service';

function advertiserIdOf(req: Request): string {
  const { user } = currentUser(req);
  if (!user.advertiserId) {
    throw new ForbiddenError('Only an advertiser account can manage campaigns here.');
  }
  return user.advertiserId;
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = parseQuery(req, CampaignListQuerySchema);
  res.json(
    await campaigns.listForAdvertiser({
      advertiserId: advertiserIdOf(req),
      page: query.page,
      pageSize: query.pageSize,
      status: query.status,
    }),
  );
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, CreateCampaignRequestSchema);
  const { user } = currentUser(req);

  const created = await campaigns.createForAdvertiser({
    advertiserId: advertiserIdOf(req),
    createdBy: user.id,
    name: body.name,
    brandName: body.brandName,
    city: body.city,
    vehicleType: body.vehicleType,
    startDate: body.startDate,
    endDate: body.endDate,
    zonePrimeKm: body.zonePrimeKm,
    zoneSecondaryKm: body.zoneSecondaryKm,
    locations: body.locations,
    zonePolygons: body.zonePolygons,
    requestedVehicleIds: body.requestedVehicleIds,
    targetKm: body.targetKm,
    creativeKey: body.creativeKey,
    ip: req.ip ?? null,
  });

  res.status(201).json(created);
}

export async function get(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  res.json(await campaigns.getForAdvertiser(advertiserIdOf(req), id));
}

export async function update(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const body = parseBody(req, CreateCampaignRequestSchema);
  const { user } = currentUser(req);

  res.json(
    await campaigns.updateForAdvertiser({
      advertiserId: advertiserIdOf(req),
      id,
      actorUserId: user.id,
      name: body.name,
      brandName: body.brandName,
      city: body.city,
      vehicleType: body.vehicleType,
      startDate: body.startDate,
      endDate: body.endDate,
      zonePrimeKm: body.zonePrimeKm,
      zoneSecondaryKm: body.zoneSecondaryKm,
      locations: body.locations,
      zonePolygons: body.zonePolygons,
      requestedVehicleIds: body.requestedVehicleIds,
      targetKm: body.targetKm,
      creativeKey: body.creativeKey,
      ip: req.ip ?? null,
    }),
  );
}

export async function availableVehicles(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, AvailableVehiclesRequestSchema);
  advertiserIdOf(req);
  res.json(
    await drivers.vehiclesInZones({
      vehicleType: body.vehicleType,
      zonePolygons: body.zonePolygons,
      revealIdentity: false,
    }),
  );
}

export function estimate(req: Request, res: Response): void {
  const body = parseBody(req, EstimateCampaignRequestSchema);
  advertiserIdOf(req);
  res.json(
    campaigns.estimate({
      startDate: body.startDate,
      endDate: body.endDate,
      zonePrimeKm: body.zonePrimeKm,
      zoneSecondaryKm: body.zoneSecondaryKm,
    }),
  );
}

export async function uploadCreative(req: Request, res: Response): Promise<void> {
  const { user } = currentUser(req);
  advertiserIdOf(req);

  const file = req.file;
  if (!file) throw new BadRequestError('Attach a PDF or PNG as the `file` field.');

  const stored = await campaigns.storeCreative({
    userId: user.id,
    fileName: file.originalname,
    contentType: file.mimetype,
    bytes: file.buffer,
  });

  res.status(201).json(stored);
}

export async function downloadCreative(req: Request, res: Response): Promise<void> {
  const { user } = currentUser(req);
  const params = parseParams(req, CreativeKeyParamSchema);
  const key = `${params.userId}/${params.fileName}`;
  const stored = await campaigns.readOwnedCreative(user.id, key);

  res.setHeader('Content-Type', stored.contentType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(stored.bytes);
}

export async function adminList(req: Request, res: Response): Promise<void> {
  const query = parseQuery(req, CampaignListQuerySchema);
  res.json(
    await campaigns.listForAdmin({
      page: query.page,
      pageSize: query.pageSize,
      status: query.status,
    }),
  );
}

export async function adminGet(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  res.json(await campaigns.getForAdmin(id));
}

export async function adminApprove(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const { user } = currentUser(req);
  res.json(
    await campaigns.approveForAdmin({
      id,
      actorUserId: user.id,
      ip: req.ip ?? null,
    }),
  );
}

export async function adminPrintReady(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const { user } = currentUser(req);
  res.json(
    await campaigns.markPrintReadyForAdmin({
      id,
      actorUserId: user.id,
      ip: req.ip ?? null,
    }),
  );
}

export async function adminInstalled(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const { user } = currentUser(req);
  res.json(
    await campaigns.markInstalledForAdmin({
      id,
      actorUserId: user.id,
      ip: req.ip ?? null,
    }),
  );
}

export async function adminReject(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const body = parseBody(req, CampaignRejectRequestSchema);
  const { user } = currentUser(req);
  res.json(
    await campaigns.rejectForAdmin({
      id,
      reason: body.reason,
      actorUserId: user.id,
      ip: req.ip ?? null,
    }),
  );
}

export async function adminPause(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const body = parseBody(req, CampaignHaltRequestSchema);
  const { user } = currentUser(req);
  res.json(
    await campaigns.pauseForAdmin({
      id,
      reason: body.reason,
      actorUserId: user.id,
      ip: req.ip ?? null,
    }),
  );
}

export async function adminResume(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const { user } = currentUser(req);
  res.json(
    await campaigns.resumeForAdmin({
      id,
      actorUserId: user.id,
      ip: req.ip ?? null,
    }),
  );
}

export async function adminComplete(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const { user } = currentUser(req);
  res.json(
    await campaigns.completeForAdmin({
      id,
      actorUserId: user.id,
      ip: req.ip ?? null,
    }),
  );
}

export async function adminStop(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const body = parseBody(req, CampaignHaltRequestSchema);
  const { user } = currentUser(req);
  res.json(
    await campaigns.stopForAdmin({
      id,
      reason: body.reason,
      actorUserId: user.id,
      ip: req.ip ?? null,
    }),
  );
}

export async function adminCreative(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const stored = await campaigns.readAdminCreative(id);
  res.setHeader('Content-Type', stored.contentType);
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${stored.fileName.replace(/"/g, '')}"`,
  );
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(stored.bytes);
}
