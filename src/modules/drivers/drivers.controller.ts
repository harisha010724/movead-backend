import { type Request, type Response } from 'express';

import { AvailableVehiclesRequestSchema } from '../../contracts/campaigns';
import { IdParamSchema } from '../../contracts/common';
import {
  AddVehicleSchema,
  AvailableFleetQuerySchema,
  CreateDriverSchema,
  DriverListQuerySchema,
  ReasonBodySchema,
  RegisterDocumentSchema,
  SetConsentSchema,
  UpdateDriverProfileSchema,
  UpdateDriverSchema,
  UpdateDriverVehicleSchema,
  UpdateVehicleSchema,
  UploadDocumentSchema,
} from '../../contracts/drivers';
import { BadRequestError } from '../../shared/errors';
import { currentUser } from '../../shared/http/middleware/auth';
import { parseBody, parseParams, parseQuery } from '../../shared/http/validate';

import * as consent from './consent';
import { type Actor } from './drivers.service';
import * as drivers from './drivers.service';

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, CreateDriverSchema);
  const { user } = currentUser(req);
  const created = await drivers.createDriver(body, {
    ...actor(req),
    createdByName: user.fullName,
  });
  res.status(201).json({
    driver: drivers.viewDriver(created.driver),
    vehicle: created.vehicle,
    user: created.user,
    invitationEmailed: created.invitationEmailed,
  });
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = parseQuery(req, DriverListQuerySchema);
  const page = await drivers.listDrivers(query);

  res.json({
    items: page.map(({ driver, vehicle }) => ({
      id: driver.id,
      name: driver.name,
      mobile: driver.mobile,
      status: driver.status,
      photoKey: driver.photoKey,
      joinedAt: driver.joinedAt.toISOString(),
      city: driver.city,
      location: drivers.locationView(driver),
      // Null until a vehicle is added. The queue shows a dash rather than
      // hiding the driver, who still needs reviewing.
      vehicle: vehicle
        ? {
            id: vehicle.id,
            registrationNumber: vehicle.registrationNumber,
            category: vehicle.category,
            status: vehicle.status,
          }
        : null,
    })),
    // The cursor is the last row's timestamp: the list is append-only and read
    // newest first, so an offset would shift under the reader as drivers join.
    nextCursor:
      page.length === query.limit
        ? (page.at(-1)?.driver.createdAt.toISOString() ?? null)
        : null,
  });
}

export async function detail(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  res.json(await drivers.driverDetail(id));
}

export async function update(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const body = parseBody(req, UpdateDriverSchema);
  res.json(drivers.viewDriver(await drivers.updateDriverProfile(id, body, actor(req))));
}

export async function remove(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const { reason } = parseBody(req, ReasonBodySchema);
  res.json(await drivers.deleteDriver(id, reason, actor(req)));
}

export async function approve(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  res.json(await drivers.approveDriver(id, actor(req)));
}

export async function reject(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const { reason } = parseBody(req, ReasonBodySchema);
  res.json(await drivers.rejectDriver(id, reason, actor(req)));
}

export async function suspend(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const { reason } = parseBody(req, ReasonBodySchema);
  res.json(await drivers.suspendDriver(id, reason, actor(req)));
}

export async function reinstate(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  res.json(await drivers.reinstateDriver(id, actor(req)));
}

export async function addVehicle(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const body = parseBody(req, AddVehicleSchema);
  res.status(201).json(await drivers.addVehicle(id, body, actor(req)));
}

export async function updateVehicle(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const body = parseBody(req, UpdateVehicleSchema);
  res.json(await drivers.updateVehicle(id, body, actor(req)));
}

export async function verifyVehicleDocuments(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  res.json(await drivers.verifyVehicleDocuments(id, actor(req)));
}

export async function approveVehicle(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  res.json(await drivers.approveVehicle(id, actor(req)));
}

export async function rejectVehicle(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const { reason } = parseBody(req, ReasonBodySchema);
  res.json(await drivers.rejectVehicle(id, reason, actor(req)));
}

export async function suspendVehicle(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const { reason } = parseBody(req, ReasonBodySchema);
  res.json(await drivers.suspendVehicle(id, reason, actor(req)));
}

export async function reinstateVehicle(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  res.json(await drivers.reinstateVehicle(id, actor(req)));
}

export async function vehicleHistory(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  res.json(await drivers.vehicleHistory(id));
}

export async function registerDocument(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, RegisterDocumentSchema);
  res.status(201).json(await drivers.registerDocument(body, actor(req)));
}

export async function documentFile(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const stored = await drivers.readDocument(id);

  res.setHeader('content-type', stored.contentType);
  // Inline, because the point is to look at it in the review screen rather
  // than to collect licence scans in an operator's downloads folder.
  res.setHeader('content-disposition', `inline; filename="${stored.kind.toLowerCase()}"`);
  res.setHeader('cache-control', 'private, max-age=300');
  res.send(stored.bytes);
}

export async function verifyDocument(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  res.json(await drivers.verifyDocument(id, actor(req)));
}

export async function rejectDocument(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const { reason } = parseBody(req, ReasonBodySchema);
  res.json(await drivers.rejectDocument(id, reason, actor(req)));
}

export async function availableFleet(req: Request, res: Response): Promise<void> {
  const query = parseQuery(req, AvailableFleetQuerySchema);
  res.json(await drivers.listAvailableFleet({ vehicleType: query.vehicleType }));
}

export async function vehiclesInZones(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, AvailableVehiclesRequestSchema);
  res.json(
    await drivers.vehiclesInZones({
      vehicleType: body.vehicleType,
      zonePolygons: body.zonePolygons,
      revealIdentity: true,
    }),
  );
}

export async function portalMe(req: Request, res: Response): Promise<void> {
  res.json(await drivers.portalProfile(requireDriverId(req)));
}

export async function portalUpdateMe(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, UpdateDriverProfileSchema);

  res.json(
    await drivers.updatePortalProfile(
      requireDriverId(req),
      {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.address === undefined ? {} : { address: body.address ?? null }),
        ...(body.payout === undefined ? {} : { payout: body.payout ?? null }),
      },
      actor(req),
    ),
  );
}

export async function portalRevealPayout(req: Request, res: Response): Promise<void> {
  res.json(await drivers.revealPayout(requireDriverId(req), actor(req)));
}

export async function portalUploadPhoto(req: Request, res: Response): Promise<void> {
  const file = req.file;
  if (!file) throw new BadRequestError('Attach the photo as the `file` field.');

  res.json(
    await drivers.uploadPortalPhoto(
      requireDriverId(req),
      { contentType: file.mimetype, bytes: file.buffer },
      actor(req),
    ),
  );
}

export async function portalPhoto(req: Request, res: Response): Promise<void> {
  sendImage(res, await drivers.readPortalPhoto(requireDriverId(req)));
}

export async function portalVehicle(req: Request, res: Response): Promise<void> {
  res.json(await drivers.portalVehicle(requireDriverId(req)));
}

export async function portalUpdateVehicle(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, UpdateDriverVehicleSchema);

  // Rebuilt key by key rather than spread: an absent field must stay absent so
  // the service can tell "leave it alone" from an explicit null that clears it.
  res.json(
    await drivers.updatePortalVehicle(
      requireDriverId(req),
      {
        ...(body.bodyType === undefined ? {} : { bodyType: body.bodyType ?? null }),
        ...(body.makeModel === undefined ? {} : { makeModel: body.makeModel ?? null }),
        ...(body.colour === undefined ? {} : { colour: body.colour ?? null }),
        ...(body.manufactureYear === undefined
          ? {}
          : { manufactureYear: body.manufactureYear ?? null }),
        ...(body.fuelType === undefined ? {} : { fuelType: body.fuelType ?? null }),
      },
      actor(req),
    ),
  );
}

export async function portalUploadVehiclePhoto(req: Request, res: Response): Promise<void> {
  const file = req.file;
  if (!file) throw new BadRequestError('Attach the photo as the `file` field.');

  res.json(
    await drivers.uploadVehiclePhoto(
      requireDriverId(req),
      { contentType: file.mimetype, bytes: file.buffer },
      actor(req),
    ),
  );
}

export async function portalVehiclePhoto(req: Request, res: Response): Promise<void> {
  sendImage(res, await drivers.readVehiclePhoto(requireDriverId(req)));
}

export async function vehiclePhoto(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  sendImage(res, await drivers.readVehiclePhotoById(id));
}

function sendImage(res: Response, stored: { bytes: Buffer; contentType: string }): void {
  res.setHeader('content-type', stored.contentType);
  res.setHeader('cache-control', 'private, max-age=3600');
  res.send(stored.bytes);
}

export async function portalConsent(req: Request, res: Response): Promise<void> {
  const driverId = requireDriverId(req);

  res.json({
    disclosure: consent.CONSENT_DISCLOSURE,
    current: await consent.current(driverId),
    history: await consent.history(driverId),
  });
}

export async function portalSetConsent(req: Request, res: Response): Promise<void> {
  const { granted } = parseBody(req, SetConsentSchema);
  const who = {
    driverId: requireDriverId(req),
    actorUserId: currentUser(req).user.id,
    ip: req.ip ?? null,
  };

  res.json(granted ? await consent.grant(who) : await consent.withdraw(who));
}

export async function portalEarnings(req: Request, res: Response): Promise<void> {
  res.json(await drivers.portalEarnings(requireDriverId(req)));
}

export function portalCampaign(_req: Request, res: Response): void {
  res.json(null);
}

export async function portalEligibility(req: Request, res: Response): Promise<void> {
  res.json(await drivers.portalEligibility(requireDriverId(req)));
}

export async function portalDocuments(req: Request, res: Response): Promise<void> {
  res.json(await drivers.driverDocuments(requireDriverId(req)));
}

export async function portalUploadDocument(req: Request, res: Response): Promise<void> {
  const file = req.file;
  if (!file) throw new BadRequestError('Attach the document as the `file` field.');

  // Multipart carries every field as a string, so the body is parsed from the
  // text form rather than the JSON schema the admin route uses.
  const body = parseBody(req, UploadDocumentSchema);

  const item = await drivers.uploadDriverDocument(
    {
      driverId: requireDriverId(req),
      kind: body.kind,
      contentType: file.mimetype,
      bytes: file.buffer,
      ...(body.documentNumber ? { documentNumber: body.documentNumber } : {}),
      ...(body.expiresOn ? { expiresOn: body.expiresOn } : {}),
    },
    actor(req),
  );

  res.status(201).json(item);
}

export async function portalDocumentFile(req: Request, res: Response): Promise<void> {
  const { id } = parseParams(req, IdParamSchema);
  const stored = await drivers.readDriverDocument(requireDriverId(req), id);

  res.setHeader('content-type', stored.contentType);
  res.setHeader('cache-control', 'private, max-age=3600');
  res.send(stored.bytes);
}

/** AC-31.5: every action is attributable to a named individual account. */
function actor(req: Request): Actor {
  return { userId: currentUser(req).user.id, ip: req.ip ?? null };
}

function requireDriverId(req: Request): string {
  const { driverId } = currentUser(req).user;
  if (!driverId) throw new Error('Driver session is missing driverId');
  return driverId;
}
