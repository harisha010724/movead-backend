import { randomUUID } from 'node:crypto';

import { Op } from 'sequelize';

import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors';
import { Campaign } from '../campaigns/campaigns.model';
import { Driver, Vehicle } from '../drivers/drivers.model';
import { CampaignVehicle } from '../installations/installations.model';
import * as notifications from '../notifications/notifications.service';
import { objectStore } from '../storage';

import {
  BrandingProof,
  BrandingProofPhoto,
  OPEN_PROOF,
  requiredBrandingAngles,
  type BrandingAngle,
  type BrandingProofStatus,
} from './brandingProofs.model';

/**
 * Driver wrap-photo checks. Distinct from AC-06 installation evidence: that
 * is taken by operations at fitment. These are taken by the driver, on the
 * ads vehicle, with a location the server recorded.
 */

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const ACCEPTED_PHOTO_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

/** How long the driver has before earning pauses. */
const DUE_HOURS = 24;

/** A phone clock may drift; a capture from last week is a gallery shot. */
const MAX_CAPTURE_AGE_MS = 15 * 60 * 1000;

export interface Actor {
  userId: string;
}

export interface ProofPhotoView {
  id: string;
  angle: BrandingAngle;
  fileName: string;
  lat: number;
  lon: number;
  capturedAt: string;
  uploadedAt: string;
}

export interface ProofView {
  id: string;
  assignmentId: string;
  campaignId: string;
  campaignName: string;
  registrationNumber: string;
  driverName: string;
  vehicleCategory: string;
  status: BrandingProofStatus;
  dueAt: string;
  requestedAt: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  photoCount: number;
  required: BrandingAngle[];
  uploaded: BrandingAngle[];
  photos: ProofPhotoView[];
}

export async function requestProof(input: {
  assignmentId: string;
  actor: Actor | null;
  notify?: boolean;
}): Promise<ProofView> {
  const assignment = await loadAssignment(input.assignmentId);
  if (assignment.status !== 'ACTIVE') {
    throw new ConflictError('Wrap photos can only be requested for a live assignment.');
  }

  const existing = await BrandingProof.findOne({
    where: { campaignVehicleId: assignment.id, status: { [Op.in]: OPEN_PROOF } },
  });
  if (existing) {
    throw new ConflictError('This vehicle already has a wrap-photo check in progress.');
  }

  const proof = await BrandingProof.create({
    campaignVehicleId: assignment.id,
    requestedBy: input.actor?.userId ?? null,
    dueAt: new Date(Date.now() + DUE_HOURS * 60 * 60 * 1000),
    status: 'REQUESTED',
  });

  const campaign = await Campaign.findByPk(assignment.campaignId);

  if (input.notify !== false) {
    await notifications.notifyDriver({
      driverId: assignment.driverId,
      kind: 'VERIFICATION',
      title: 'Photograph your wrap',
      body: `Take photos of the advertisement on your vehicle for “${campaign?.name ?? 'your campaign'}”. Camera only — gallery shots are not accepted.`,
      href: '/driver/branding-proof',
    });
  }

  return toView(proof.id);
}

/** The driver opens wrap photos themselves. Returns the open check, or starts one. */
export async function startForDriver(driverId: string): Promise<ProofView> {
  const assignment = await CampaignVehicle.findOne({
    where: { driverId, status: 'ACTIVE' },
  });
  if (!assignment) {
    throw new ConflictError('Wrap photos can only be taken while you have a live campaign.');
  }

  const existing = await BrandingProof.findOne({
    where: { campaignVehicleId: assignment.id, status: { [Op.in]: OPEN_PROOF } },
    order: [['requestedAt', 'DESC']],
  });
  if (existing) return toView(existing.id);

  return requestProof({ assignmentId: assignment.id, actor: null, notify: false });
}

/** Opens a check if none is open. Used when a vehicle first goes live. */
export async function requestIfNone(assignmentId: string): Promise<void> {
  const open = await BrandingProof.findOne({
    where: { campaignVehicleId: assignmentId, status: { [Op.in]: OPEN_PROOF } },
    attributes: ['id'],
  });
  if (open) return;

  try {
    await requestProof({ assignmentId, actor: null });
  } catch (error) {
    if (error instanceof ConflictError) return;
    throw error;
  }
}

export async function currentForDriver(driverId: string): Promise<ProofView | null> {
  const assignment = await CampaignVehicle.findOne({
    where: { driverId, status: 'ACTIVE' },
  });
  if (!assignment) return null;

  const proof = await BrandingProof.findOne({
    where: {
      campaignVehicleId: assignment.id,
      status: { [Op.in]: [...OPEN_PROOF, 'SUBMITTED'] },
    },
    order: [['requestedAt', 'DESC']],
  });
  return proof ? toView(proof.id) : null;
}

export async function uploadPhoto(input: {
  proofId: string;
  driverId: string;
  angle: BrandingAngle;
  fileName: string;
  contentType: string;
  bytes: Buffer;
  lat: number;
  lon: number;
  capturedAt: string;
}): Promise<ProofView> {
  const proof = await loadOwnedProof(input.proofId, input.driverId);
  if (proof.status === 'SUBMITTED' || proof.status === 'APPROVED') {
    throw new ConflictError('These photos have already been sent.');
  }

  const required = await anglesFor(proof);
  if (!required.includes(input.angle)) {
    throw new BadRequestError('That angle is not required for this vehicle.');
  }

  const ext = ACCEPTED_PHOTO_TYPES[input.contentType as keyof typeof ACCEPTED_PHOTO_TYPES];
  if (!ext) throw new BadRequestError('Accepted: JPEG, PNG or WebP, up to 10 MB.');
  if (input.bytes.length === 0) throw new BadRequestError('The file is empty.');
  if (input.bytes.length > MAX_PHOTO_BYTES) {
    throw new BadRequestError('Each photo must be 10 MB or smaller.');
  }

  const capturedAt = capturedAtFrom(input.capturedAt);

  const key = `${proof.id}/${randomUUID()}.${ext}`;
  await objectStore().put(key, input.bytes, input.contentType);

  const existing = await BrandingProofPhoto.findOne({
    where: { proofId: proof.id, angle: input.angle },
  });

  if (existing) {
    await existing.update({
      storageKey: key,
      fileName: input.fileName,
      contentType: input.contentType,
      byteSize: input.bytes.length,
      lat: String(input.lat),
      lon: String(input.lon),
      capturedAt,
      uploadedAt: new Date(),
    });
  } else {
    await BrandingProofPhoto.create({
      proofId: proof.id,
      angle: input.angle,
      storageKey: key,
      fileName: input.fileName,
      contentType: input.contentType,
      byteSize: input.bytes.length,
      lat: String(input.lat),
      lon: String(input.lon),
      capturedAt,
    });
  }

  if (proof.status === 'REQUESTED' || proof.status === 'REJECTED') {
    await proof.update({ status: 'IN_PROGRESS', rejectionReason: null });
  }

  return toView(proof.id);
}

export async function submitProof(input: { proofId: string; driverId: string }): Promise<ProofView> {
  const proof = await loadOwnedProof(input.proofId, input.driverId);
  if (proof.status === 'SUBMITTED' || proof.status === 'APPROVED') {
    throw new ConflictError('These photos have already been sent.');
  }

  const required = await anglesFor(proof);
  const uploaded = await uploadedAngles(proof.id);
  const missing = required.filter((angle) => !uploaded.includes(angle));
  if (missing.length > 0) {
    throw new BadRequestError(
      `Still needed: ${missing.map((angle) => angle.replaceAll('_', ' ').toLowerCase()).join(', ')}.`,
    );
  }

  await proof.update({
    status: 'SUBMITTED',
    submittedAt: new Date(),
    rejectionReason: null,
  });

  const view = await toView(proof.id);
  const assignment = await loadAssignment(proof.campaignVehicleId);
  const campaign = await Campaign.findByPk(assignment.campaignId);
  if (campaign) {
    await notifications.notifyAdvertiserUsers({
      advertiserId: campaign.advertiserId,
      kind: 'VERIFICATION',
      title: 'New wrap photos',
      body: `${view.registrationNumber} photographed the advertisement for “${view.campaignName}”.`,
      href: `/campaigns/${campaign.id}`,
    });
  }

  return view;
}

export async function reviewQueue(): Promise<ProofView[]> {
  const rows = await BrandingProof.findAll({
    where: { status: 'SUBMITTED' },
    order: [['submittedAt', 'ASC']],
  });
  return Promise.all(rows.map((row) => toView(row.id)));
}

export async function outstanding(): Promise<ProofView[]> {
  const rows = await BrandingProof.findAll({
    where: { status: { [Op.in]: ['REQUESTED', 'IN_PROGRESS', 'REJECTED'] } },
    order: [['dueAt', 'ASC']],
  });
  return Promise.all(rows.map((row) => toView(row.id)));
}

export async function eligibleAssignments(): Promise<
  {
    assignmentId: string;
    campaignId: string;
    campaignName: string;
    registrationNumber: string;
    driverName: string;
  }[]
> {
  const assignments = await CampaignVehicle.findAll({
    where: { status: 'ACTIVE' },
    include: [
      { model: Campaign, as: 'campaign', required: true },
      { model: Vehicle, as: 'vehicle', required: true },
      { model: Driver, as: 'driver', required: true },
    ],
    order: [['activatedAt', 'DESC']],
  });

  const open = await BrandingProof.findAll({
    where: {
      campaignVehicleId: { [Op.in]: assignments.map((row) => row.id) },
      status: { [Op.in]: OPEN_PROOF },
    },
    attributes: ['campaignVehicleId'],
  });
  const busy = new Set(open.map((row) => row.campaignVehicleId));

  return assignments
    .filter((row) => !busy.has(row.id))
    .map((row) => ({
      assignmentId: row.id,
      campaignId: row.campaignId,
      campaignName: row.campaign?.name ?? '',
      registrationNumber: row.vehicle?.registrationNumber ?? '',
      driverName: row.driver?.name ?? '',
    }));
}

export async function listForAdvertiser(
  advertiserId: string,
  campaignId: string,
): Promise<ProofView[]> {
  const campaign = await Campaign.findOne({ where: { id: campaignId, advertiserId } });
  if (!campaign) throw new NotFoundError('Campaign');

  const assignments = await CampaignVehicle.findAll({
    where: { campaignId },
    attributes: ['id'],
  });
  if (assignments.length === 0) return [];

  const rows = await BrandingProof.findAll({
    where: {
      campaignVehicleId: { [Op.in]: assignments.map((row) => row.id) },
      status: { [Op.in]: ['SUBMITTED', 'APPROVED'] },
    },
    order: [['submittedAt', 'DESC']],
  });
  return Promise.all(rows.map((row) => toView(row.id)));
}

export async function readPhotoForAdvertiser(
  advertiserId: string,
  campaignId: string,
  photoId: string,
): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
  const photo = await BrandingProofPhoto.findByPk(photoId);
  if (!photo) throw new NotFoundError('Photo');

  const proof = await BrandingProof.findByPk(photo.proofId);
  if (!proof) throw new NotFoundError('Photo');

  const assignment = await CampaignVehicle.findByPk(proof.campaignVehicleId);
  if (!assignment || assignment.campaignId !== campaignId) throw new NotFoundError('Photo');

  const campaign = await Campaign.findOne({
    where: { id: campaignId, advertiserId },
    attributes: ['id'],
  });
  if (!campaign) throw new NotFoundError('Photo');

  return readPhoto(photoId);
}

export async function readPhoto(
  photoId: string,
): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
  const photo = await BrandingProofPhoto.findByPk(photoId);
  if (!photo) throw new NotFoundError('Photo');
  const stored = await objectStore().get(photo.storageKey);
  if (!stored) throw new NotFoundError('Photo');
  return { bytes: stored.bytes, contentType: stored.contentType, fileName: photo.fileName };
}

export async function readPhotoForDriver(
  photoId: string,
  driverId: string,
): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
  const photo = await BrandingProofPhoto.findByPk(photoId);
  if (!photo) throw new NotFoundError('Photo');
  await loadOwnedProof(photo.proofId, driverId);
  return readPhoto(photoId);
}

/**
 * Whether the live assignment may keep earning.
 *
 * Sending the photos publishes them to the advertiser and keeps the meter
 * running. Rejected or overdue requests pause it.
 */
export async function earningHold(
  assignmentId: string,
): Promise<{ held: boolean; reason: string | null }> {
  const proof = await BrandingProof.findOne({
    where: { campaignVehicleId: assignmentId, status: { [Op.in]: OPEN_PROOF } },
  });
  if (!proof) return { held: false, reason: null };
  if (proof.status === 'REJECTED') {
    return {
      held: true,
      reason: proof.rejectionReason ?? 'Photograph the wrap on your vehicle again.',
    };
  }
  if (proof.dueAt.getTime() < Date.now()) {
    return {
      held: true,
      reason: 'Photograph the wrap on your vehicle to keep earning.',
    };
  }
  return { held: false, reason: null };
}

function capturedAtFrom(claimed: string): Date {
  const at = new Date(claimed);
  if (Number.isNaN(at.getTime())) throw new BadRequestError('capturedAt is not a timestamp.');
  const now = Date.now();
  if (at.getTime() > now + 30_000) {
    throw new BadRequestError('A photo cannot be captured in the future.');
  }
  if (at.getTime() < now - MAX_CAPTURE_AGE_MS) {
    throw new BadRequestError('That photo is too old. Take a new one in the app.');
  }
  return at;
}

async function loadAssignment(id: string): Promise<CampaignVehicle> {
  const row = await CampaignVehicle.findByPk(id, {
    include: [
      { model: Campaign, as: 'campaign', required: false },
      { model: Vehicle, as: 'vehicle', required: false },
      { model: Driver, as: 'driver', required: false },
    ],
  });
  if (!row) throw new NotFoundError('Assignment');
  return row;
}

async function loadOwnedProof(proofId: string, driverId: string): Promise<BrandingProof> {
  const proof = await BrandingProof.findByPk(proofId);
  if (!proof) throw new NotFoundError('Wrap photos');
  const assignment = await CampaignVehicle.findByPk(proof.campaignVehicleId);
  if (!assignment || assignment.driverId !== driverId) throw new NotFoundError('Wrap photos');
  return proof;
}

async function anglesFor(proof: BrandingProof): Promise<BrandingAngle[]> {
  const assignment = await loadAssignment(proof.campaignVehicleId);
  const campaign = await Campaign.findByPk(assignment.campaignId);
  if (!campaign) throw new NotFoundError('Campaign');
  return requiredBrandingAngles(campaign.vehicleType);
}

async function uploadedAngles(proofId: string): Promise<BrandingAngle[]> {
  const photos = await BrandingProofPhoto.findAll({ where: { proofId } });
  return photos.map((photo) => photo.angle);
}

async function toView(proofId: string): Promise<ProofView> {
  const proof = await BrandingProof.findByPk(proofId, {
    include: [{ model: BrandingProofPhoto, as: 'photos' }],
  });
  if (!proof) throw new NotFoundError('Wrap photos');

  const assignment = await loadAssignment(proof.campaignVehicleId);
  const campaign = assignment.campaign ?? (await Campaign.findByPk(assignment.campaignId));
  const vehicle = assignment.vehicle ?? (await Vehicle.findByPk(assignment.vehicleId));
  const driver = assignment.driver ?? (await Driver.findByPk(assignment.driverId));
  const required = campaign ? requiredBrandingAngles(campaign.vehicleType) : [];
  const photos = (proof.photos ?? []).sort((a, b) => a.angle.localeCompare(b.angle));

  return {
    id: proof.id,
    assignmentId: assignment.id,
    campaignId: assignment.campaignId,
    campaignName: campaign?.name ?? '',
    registrationNumber: vehicle?.registrationNumber ?? '',
    driverName: driver?.name ?? '',
    vehicleCategory: vehicle?.category ?? '',
    status: proof.status,
    dueAt: proof.dueAt.toISOString(),
    requestedAt: proof.requestedAt.toISOString(),
    submittedAt: proof.submittedAt?.toISOString() ?? null,
    reviewedAt: proof.reviewedAt?.toISOString() ?? null,
    rejectionReason: proof.rejectionReason,
    photoCount: photos.length,
    required,
    uploaded: photos.map((photo) => photo.angle),
    photos: photos.map((photo) => ({
      id: photo.id,
      angle: photo.angle,
      fileName: photo.fileName,
      lat: Number(photo.lat),
      lon: Number(photo.lon),
      capturedAt: photo.capturedAt.toISOString(),
      uploadedAt: photo.uploadedAt.toISOString(),
    })),
  };
}
