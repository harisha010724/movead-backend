import { randomUUID } from 'node:crypto';

import { Op } from 'sequelize';

import { sequelize } from '../../db/sequelize';
import { money, toLedger, toPayable } from '../../pricing/money';
import { DRIVER_RATE } from '../../pricing/rates';
import * as tracking from '../tracking/tracking.service';
import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors';
import * as audit from '../audit/audit.service';
import { Campaign, type CampaignStatus } from '../campaigns/campaigns.model';
import { Driver, Vehicle } from '../drivers/drivers.model';
import * as notifications from '../notifications/notifications.service';
import { objectStore } from '../storage';

import {
  CampaignVehicle,
  Installation,
  InstallationPhoto,
  LIVE_ASSIGNMENT,
  REQUIRED_ANGLES,
  type AssignmentStatus,
  type PhotoAngle,
} from './installations.model';

/**
 * Assignment and installation — AC-22 and AC-06.
 *
 * The invariant worth stating once: nothing here makes a kilometre billable.
 * This module decides whether a vehicle is *allowed* to earn on a campaign;
 * AC-07 re-evaluates that server-side on every segment. Approving an
 * installation opens the gate, it does not backdate anything through it.
 */

/** AC-15: the driver's share, which is deliberately not the advertiser's rate. */
const DRIVER_RATES = {
  prime: money(DRIVER_RATE.prime),
  secondary: money(DRIVER_RATE.secondary),
  network: money(DRIVER_RATE.network),
} as const;

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const ACCEPTED_PHOTO_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

/** Campaign statuses from which a vehicle may be assigned. */
const ASSIGNABLE_CAMPAIGN = new Set(['APPROVED', 'AWAITING_INSTALLATION', 'ACTIVE']);

/** Vehicle statuses that satisfy AC-22.2's approval requirement. */
const ASSIGNABLE_VEHICLE = ['APPROVED', 'AVAILABLE'];

export interface Actor {
  userId: string;
  ip: string | null;
}

// ---------------------------------------------------------------------------
// Admin: assignment (AC-22)
// ---------------------------------------------------------------------------

export interface AssignmentView {
  id: string;
  campaignId: string;
  vehicleId: string;
  driverId: string;
  registrationNumber: string;
  driverName: string;
  vehicleCategory: string;
  status: AssignmentStatus;
  assignedAt: string;
  acceptedAt: string | null;
  activatedAt: string | null;
  overrideReason: string | null;
  installation: {
    status: string;
    photoCount: number;
    requiredCount: number;
    rejectionReason: string | null;
    submittedAt: string | null;
    reviewedAt: string | null;
  } | null;
}

/**
 * AC-22.1 — admin assigns vehicles by hand. The advertiser's
 * `requestedVehicleIds` is a request; this is the confirmation.
 *
 * A vehicle failing a requirement is refused unless `overrideReason` is given
 * (AC-22.3), and the reason is stored on the row rather than only audited, so
 * the exception is visible wherever the assignment is.
 */
export async function assignVehicles(input: {
  campaignId: string;
  vehicleIds: string[];
  overrideReason?: string | undefined;
  actor: Actor;
}): Promise<AssignmentView[]> {
  const campaign = await loadCampaign(input.campaignId);

  if (!ASSIGNABLE_CAMPAIGN.has(campaign.status)) {
    throw new ConflictError('Only an approved campaign can have vehicles assigned.');
  }

  const unique = [...new Set(input.vehicleIds)];
  if (unique.length === 0) throw new BadRequestError('Select at least one vehicle.');

  const vehicles = await Vehicle.findAll({
    where: { id: { [Op.in]: unique } },
    include: [{ model: Driver, as: 'driver', required: true }],
  });

  if (vehicles.length !== unique.length) {
    throw new BadRequestError('One or more vehicles no longer exist.');
  }

  // AC-22.2. Collected rather than thrown one at a time so the admin sees
  // every problem at once instead of fixing them in sequence.
  const problems: string[] = [];
  for (const vehicle of vehicles) {
    if (vehicle.category !== campaign.vehicleType) {
      problems.push(`${vehicle.registrationNumber} is not a ${campaign.vehicleType.toLowerCase()}.`);
    }
    if (!ASSIGNABLE_VEHICLE.includes(vehicle.status)) {
      problems.push(`${vehicle.registrationNumber} is not approved.`);
    }
  }

  if (problems.length > 0 && !input.overrideReason) {
    throw new BadRequestError(`${problems.join(' ')} Assign anyway with a reason.`);
  }

  const created = await sequelize.transaction(async (transaction) => {
    const rows: CampaignVehicle[] = [];

    for (const vehicle of vehicles) {
      // AC-22.6. The partial unique index is the real guard; this exists to
      // turn a constraint violation into a sentence naming the vehicle.
      const live = await CampaignVehicle.findOne({
        where: { vehicleId: vehicle.id, status: { [Op.in]: LIVE_ASSIGNMENT } },
        transaction,
      });

      if (live) {
        if (live.campaignId === campaign.id) continue; // Already on this campaign.
        throw new ConflictError(
          `${vehicle.registrationNumber} is already on another live campaign.`,
        );
      }

      const assignment = await CampaignVehicle.create(
        {
          campaignId: campaign.id,
          vehicleId: vehicle.id,
          driverId: vehicle.driverId,
          assignedBy: input.actor.userId,
          overrideReason: input.overrideReason ?? null,
        },
        { transaction },
      );

      // AC-06.1: the installation record exists from assignment, so the
      // appointment is something the driver and installer can both see.
      await Installation.create({ campaignVehicleId: assignment.id }, { transaction });

      rows.push(assignment);
    }

    return rows;
  });

  for (const row of created) {
    await audit.record({
      action: 'campaign.vehicle_assigned',
      entityType: 'campaign_vehicle',
      entityId: row.id,
      after: { campaignId: campaign.id, vehicleId: row.vehicleId, status: 'ASSIGNED' },
      actorUserId: input.actor.userId,
      ip: input.actor.ip,
    });
  }

  // AC-22.5: the driver is told, and accepts before installation begins.
  for (const row of created) {
    await notifications.notifyDriver({
      driverId: row.driverId,
      kind: 'CAMPAIGN',
      title: 'New campaign assigned',
      body: `“${campaign.name}” has been assigned to your vehicle. Accept it to book your installation.`,
      href: '/driver/campaign',
    });
  }

  if (created.length > 0 && campaign.status === 'APPROVED') {
    await campaign.update({ status: 'AWAITING_INSTALLATION' });
  }

  return listAssignments(campaign.id);
}

export async function listAssignments(campaignId: string): Promise<AssignmentView[]> {
  const rows = await CampaignVehicle.findAll({
    where: { campaignId },
    include: [
      { model: Vehicle, as: 'vehicle', required: true },
      { model: Driver, as: 'driver', required: true },
      { model: Installation, as: 'installation', required: false },
    ],
    order: [['assignedAt', 'ASC']],
  });

  return Promise.all(rows.map(toAssignmentView));
}

/**
 * AC-22.8 — vehicles required against assigned, installed and active, which is
 * the only honest answer to "is this campaign ready to run?".
 */
export async function assignmentSummary(campaignId: string): Promise<{
  requested: number;
  assigned: number;
  accepted: number;
  installing: number;
  active: number;
}> {
  const campaign = await loadCampaign(campaignId);
  const rows = await CampaignVehicle.findAll({ where: { campaignId } });

  const count = (status: AssignmentStatus): number =>
    rows.filter((row) => row.status === status).length;

  return {
    requested: campaign.requestedVehicleIds.length,
    assigned: rows.filter((row) => LIVE_ASSIGNMENT.includes(row.status)).length,
    accepted: count('ACCEPTED'),
    installing: count('INSTALLING'),
    active: count('ACTIVE'),
  };
}

/** AC-22.7 — unassign with a reason; history for the period is preserved. */
export async function unassign(input: {
  assignmentId: string;
  reason: string;
  actor: Actor;
}): Promise<AssignmentView> {
  const row = await loadAssignment(input.assignmentId);

  if (!LIVE_ASSIGNMENT.includes(row.status)) {
    throw new ConflictError('That vehicle is no longer on this campaign.');
  }

  const wasLive = row.status === 'ACTIVE';
  await row.update({
    status: wasLive ? 'ENDED' : 'WITHDRAWN',
    endedAt: new Date(),
    endReason: input.reason,
  });

  await audit.record({
    action: 'campaign.vehicle_unassigned',
    entityType: 'campaign_vehicle',
    entityId: row.id,
    after: { status: row.status, reason: input.reason },
    actorUserId: input.actor.userId,
    ip: input.actor.ip,
  });

  return toAssignmentView(await loadAssignment(row.id));
}

// ---------------------------------------------------------------------------
// Installation evidence (AC-06)
// ---------------------------------------------------------------------------

/** AC-06.4 — one photo per required angle; re-uploading an angle replaces it. */
export async function uploadPhoto(input: {
  assignmentId: string;
  angle: PhotoAngle;
  fileName: string;
  contentType: string;
  bytes: Buffer;
  actor: Actor;
}): Promise<{ angle: PhotoAngle; uploaded: PhotoAngle[]; required: PhotoAngle[] }> {
  const assignment = await loadAssignment(input.assignmentId);
  const installation = await loadInstallation(assignment.id);

  if (installation.status === 'APPROVED') {
    throw new ConflictError('This installation has already been approved.');
  }

  const ext = ACCEPTED_PHOTO_TYPES[input.contentType as keyof typeof ACCEPTED_PHOTO_TYPES];
  if (!ext) throw new BadRequestError('Accepted: JPEG, PNG or WebP, up to 10 MB.');
  if (input.bytes.length === 0) throw new BadRequestError('The file is empty.');
  if (input.bytes.length > MAX_PHOTO_BYTES) {
    throw new BadRequestError('Each photo must be 10 MB or smaller.');
  }

  // The store takes exactly `{owner}/{file}`; the installation id is the owner.
  const key = `${installation.id}/${randomUUID()}.${ext}`;
  await objectStore().put(key, input.bytes, input.contentType);

  const existing = await InstallationPhoto.findOne({
    where: { installationId: installation.id, angle: input.angle },
  });

  if (existing) {
    await existing.update({
      storageKey: key,
      fileName: input.fileName,
      contentType: input.contentType,
      byteSize: input.bytes.length,
      uploadedBy: input.actor.userId,
      uploadedAt: new Date(),
    });
  } else {
    await InstallationPhoto.create({
      installationId: installation.id,
      angle: input.angle,
      storageKey: key,
      fileName: input.fileName,
      contentType: input.contentType,
      byteSize: input.bytes.length,
      uploadedBy: input.actor.userId,
    });
  }

  // A rejected installation being corrected goes back to in progress, rather
  // than sitting in the review queue while photos are still changing.
  if (installation.status === 'SCHEDULED' || installation.status === 'REJECTED') {
    await installation.update({ status: 'IN_PROGRESS', rejectionReason: null });
    if (assignment.status === 'ACCEPTED') await assignment.update({ status: 'INSTALLING' });
  }

  const required = await requiredAngles(assignment);
  const uploaded = await uploadedAngles(installation.id);

  return { angle: input.angle, uploaded, required };
}

/** AC-06.5 — the workflow cannot complete until every required photo exists. */
export async function submitInstallation(input: {
  assignmentId: string;
  actor: Actor;
}): Promise<AssignmentView> {
  const assignment = await loadAssignment(input.assignmentId);
  const installation = await loadInstallation(assignment.id);

  if (installation.status === 'SUBMITTED') {
    throw new ConflictError('This installation is already awaiting review.');
  }
  if (installation.status === 'APPROVED') {
    throw new ConflictError('This installation has already been approved.');
  }

  const required = await requiredAngles(assignment);
  const uploaded = await uploadedAngles(installation.id);
  const missing = required.filter((angle) => !uploaded.includes(angle));

  if (missing.length > 0) {
    throw new BadRequestError(`Missing photos: ${missing.join(', ').toLowerCase()}.`);
  }

  await installation.update({
    status: 'SUBMITTED',
    submittedAt: new Date(),
    submittedBy: input.actor.userId,
    rejectionReason: null,
  });

  await assignment.update({ status: 'INSTALLING' });

  await audit.record({
    action: 'installation.submitted',
    entityType: 'installation',
    entityId: installation.id,
    after: { status: 'SUBMITTED' },
    actorUserId: input.actor.userId,
    ip: input.actor.ip,
  });

  return toAssignmentView(await loadAssignment(assignment.id));
}

/**
 * AC-06.10 — the campaign becomes active *for this vehicle* here, and nowhere
 * earlier. AC-06.12's separation of duties is a database check constraint; the
 * friendly refusal is here so the admin gets a sentence rather than a 500.
 */
export async function approveInstallation(input: {
  assignmentId: string;
  actor: Actor;
}): Promise<AssignmentView> {
  const assignment = await loadAssignment(input.assignmentId);
  const installation = await loadInstallation(assignment.id);

  if (installation.status !== 'SUBMITTED') {
    throw new ConflictError('Only a submitted installation can be approved.');
  }
  if (installation.submittedBy === input.actor.userId) {
    throw new ConflictError('The person who installed the wrap cannot approve it (AC-06.12).');
  }

  const campaign = await loadCampaign(assignment.campaignId);

  await sequelize.transaction(async (transaction) => {
    await installation.update(
      { status: 'APPROVED', reviewedAt: new Date(), reviewedBy: input.actor.userId },
      { transaction },
    );
    await assignment.update({ status: 'ACTIVE', activatedAt: new Date() }, { transaction });

    // The campaign as a whole is live once any one vehicle is carrying it.
    if (campaign.status === 'AWAITING_INSTALLATION') {
      await campaign.update({ status: 'ACTIVE' }, { transaction });
    }
  });

  await audit.record({
    action: 'installation.approved',
    entityType: 'installation',
    entityId: installation.id,
    after: { status: 'APPROVED', assignmentStatus: 'ACTIVE' },
    actorUserId: input.actor.userId,
    ip: input.actor.ip,
  });

  await notifications.notifyDriver({
    driverId: assignment.driverId,
    kind: 'CAMPAIGN',
    title: 'Your campaign is live',
    body: `The wrap for “${campaign.name}” is verified. You can start tracking and earning.`,
    href: '/driver/track',
  });

  await notifications.notifyAdvertiserUsers({
    advertiserId: campaign.advertiserId,
    kind: 'CAMPAIGN',
    title: 'A vehicle is live',
    body: `A vehicle on “${campaign.name}” passed installation review and is now running.`,
    href: '/campaigns',
  });

  return toAssignmentView(await loadAssignment(assignment.id));
}

/** AC-06.8 and AC-06.9 — rejection needs a reason and returns it for redoing. */
export async function rejectInstallation(input: {
  assignmentId: string;
  reason: string;
  actor: Actor;
}): Promise<AssignmentView> {
  const assignment = await loadAssignment(input.assignmentId);
  const installation = await loadInstallation(assignment.id);

  if (installation.status !== 'SUBMITTED') {
    throw new ConflictError('Only a submitted installation can be rejected.');
  }

  await installation.update({
    status: 'REJECTED',
    reviewedAt: new Date(),
    reviewedBy: input.actor.userId,
    rejectionReason: input.reason,
  });

  await audit.record({
    action: 'installation.rejected',
    entityType: 'installation',
    entityId: installation.id,
    after: { status: 'REJECTED', reason: input.reason },
    actorUserId: input.actor.userId,
    ip: input.actor.ip,
  });

  await notifications.notifyDriver({
    driverId: assignment.driverId,
    kind: 'CAMPAIGN',
    title: 'Installation needs attention',
    body: input.reason,
    href: '/driver/campaign',
  });

  return toAssignmentView(await loadAssignment(assignment.id));
}

/** The admin review queue: everything waiting on a decision. */
export async function reviewQueue(): Promise<AssignmentView[]> {
  const installations = await Installation.findAll({
    where: { status: 'SUBMITTED' },
    order: [['submittedAt', 'ASC']],
  });

  const rows = await Promise.all(
    installations.map((installation) => loadAssignment(installation.campaignVehicleId)),
  );

  return Promise.all(rows.map(toAssignmentView));
}

export async function readPhoto(
  photoId: string,
): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
  const photo = await InstallationPhoto.findByPk(photoId);
  if (!photo) throw new NotFoundError('Photo');

  const stored = await objectStore().get(photo.storageKey);
  if (!stored) throw new NotFoundError('Photo');

  return { bytes: stored.bytes, contentType: stored.contentType, fileName: photo.fileName };
}

export async function listPhotos(assignmentId: string): Promise<
  { id: string; angle: PhotoAngle; fileName: string; uploadedAt: string }[]
> {
  const installation = await loadInstallation(assignmentId);
  const photos = await InstallationPhoto.findAll({
    where: { installationId: installation.id },
    order: [['angle', 'ASC']],
  });

  return photos.map((photo) => ({
    id: photo.id,
    angle: photo.angle,
    fileName: photo.fileName,
    uploadedAt: photo.uploadedAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Driver-facing (AC-22.5, UI-024 to UI-035)
// ---------------------------------------------------------------------------

/** AC-22.5 — the driver accepts before the installation workflow begins. */
export async function acceptAssignment(input: {
  driverId: string;
  assignmentId: string;
  actor: Actor;
}): Promise<{ status: AssignmentStatus }> {
  const row = await CampaignVehicle.findOne({
    where: { id: input.assignmentId, driverId: input.driverId },
  });
  if (!row) throw new NotFoundError('Assignment');

  if (row.status !== 'ASSIGNED') {
    throw new ConflictError('This campaign has already been accepted.');
  }

  await row.update({ status: 'ACCEPTED', acceptedAt: new Date() });

  await audit.record({
    action: 'campaign.assignment_accepted',
    entityType: 'campaign_vehicle',
    entityId: row.id,
    after: { status: 'ACCEPTED', driverId: input.driverId },
    actorUserId: input.actor.userId,
    ip: input.actor.ip,
  });

  return { status: 'ACCEPTED' };
}

/**
 * A campaign a campaign is still expected to reach the driver through, so an
 * advertiser's request against it is worth showing. Rejection sets
 * `CANCELLED`, which is how a dead request stops being displayed.
 */
const OPEN_TO_REQUESTS: CampaignStatus[] = [
  'PENDING_APPROVAL',
  'APPROVED',
  'AWAITING_INSTALLATION',
  'ACTIVE',
];

interface DriverCampaignContext {
  campaign: Campaign;
  vehicle: Vehicle;
  /** Null while the campaign is only an advertiser's request. */
  assignment: CampaignVehicle | null;
}

/**
 * The one campaign a driver is currently concerned with, and how firmly.
 *
 * A confirmed assignment always wins. AC-22.6 allows a vehicle only one live
 * campaign, so if operations has assigned one, no other advertiser's request
 * can displace it in the driver's view — and acting on a request while
 * carrying somebody else's wrap is not a thing a driver can do anyway.
 */
async function currentCampaign(driverId: string): Promise<DriverCampaignContext | null> {
  const assignment = await CampaignVehicle.findOne({
    where: { driverId, status: { [Op.in]: LIVE_ASSIGNMENT } },
    include: [
      { model: Vehicle, as: 'vehicle', required: true },
      { model: Installation, as: 'installation', required: false },
    ],
    order: [['assignedAt', 'DESC']],
  });

  if (assignment?.vehicle) {
    return {
      campaign: await loadCampaign(assignment.campaignId),
      vehicle: assignment.vehicle,
      assignment,
    };
  }

  return (await requestedCampaign(driverId)) ?? closedCampaign(driverId);
}

/**
 * How long a finished campaign stays on the driver's screen after its vehicles
 * are released. Long enough to be there when someone opens the app after a few
 * days off, short enough that it does not become furniture.
 */
const CLOSING_VIEW_DAYS = 14;

/**
 * The campaign that has just ended.
 *
 * Completing or stopping a campaign ends its assignments, which is what frees
 * the vehicles — but it would also have made the driver's campaign disappear
 * mid-shift with no explanation, which is a poor way to learn that your
 * earnings have stopped. The card stays, reading `completed`, and yields to
 * anything live the moment a new campaign arrives.
 *
 * The campaign itself has to have finished, not just this assignment. A
 * driver taken off a campaign that is still running (AC-22.7) is no longer on
 * it, and showing it to them would misrepresent somebody else's live campaign
 * as theirs.
 */
const FINISHED_CAMPAIGN = ['COMPLETED', 'STOPPED', 'CANCELLED'];

async function closedCampaign(driverId: string): Promise<DriverCampaignContext | null> {
  const since = new Date(Date.now() - CLOSING_VIEW_DAYS * 24 * 60 * 60 * 1000);

  const assignment = await CampaignVehicle.findOne({
    where: { driverId, status: 'ENDED', endedAt: { [Op.gte]: since } },
    include: [
      { model: Vehicle, as: 'vehicle', required: true },
      { model: Installation, as: 'installation', required: false },
      {
        model: Campaign,
        as: 'campaign',
        required: true,
        where: { status: { [Op.in]: FINISHED_CAMPAIGN } },
      },
    ],
    order: [['endedAt', 'DESC']],
  });

  if (!assignment?.vehicle || !assignment.campaign) return null;

  return { campaign: assignment.campaign, vehicle: assignment.vehicle, assignment };
}

/**
 * AC-22.4 — the advertiser picks vehicles and operations confirms them. This
 * is the gap between those two moments, which the driver could not see at all
 * until now: their vehicle is on somebody's campaign and no row exists to say
 * so.
 *
 * It is deliberately not an assignment. Nothing here books the vehicle, and
 * `eligibility()` still fails `campaign_assigned`, so a request cannot become
 * a kilometre by being looked at.
 */
async function requestedCampaign(driverId: string): Promise<DriverCampaignContext | null> {
  const vehicles = await Vehicle.findAll({ where: { driverId } });
  if (vehicles.length === 0) return null;

  const campaigns = await Campaign.findAll({
    where: {
      status: { [Op.in]: OPEN_TO_REQUESTS },
      requestedVehicleIds: { [Op.overlap]: vehicles.map((vehicle) => vehicle.id) },
    },
    order: [['createdAt', 'DESC']],
  });

  for (const campaign of campaigns) {
    // Operations having already ruled on this driver for this campaign is a
    // decision, including when the ruling was to take them off it (AC-22.7).
    // Re-offering it as a fresh request would quietly undo that.
    const decided = await CampaignVehicle.findOne({
      where: { campaignId: campaign.id, driverId },
    });
    if (decided) continue;

    const vehicle = vehicles.find((row) => campaign.requestedVehicleIds.includes(row.id));
    if (vehicle) return { campaign, vehicle, assignment: null };
  }

  return null;
}

/**
 * The driver's campaign, shaped to match the mobile app's `Campaign` type so
 * one contract serves both clients.
 *
 * Visible from the advertiser's request onward, not only once active. AC-22.5
 * requires the driver to accept before installation, which they cannot do
 * without seeing it; and a driver whose vehicle has been picked has a
 * legitimate interest in knowing before operations gets to the paperwork.
 * What the stage gates is *doing* anything: `assignmentId` is null while it is
 * only a request, so there is nothing to accept, and tracking is gated
 * separately by `eligibility()` below.
 */
export async function driverCampaign(driverId: string): Promise<DriverCampaignView | null> {
  const current = await currentCampaign(driverId);
  if (!current) return null;

  const { campaign, vehicle, assignment } = current;

  const start = new Date(campaign.startDate);
  const end = new Date(campaign.endDate);
  const totalDays = daysBetween(start, end) + 1;
  const elapsedDays = clamp(daysBetween(start, new Date()) + 1, 0, totalDays);

  const targetKm = campaign.targetKm ? Number(campaign.targetKm) : 0;
  const achievedKm = await tracking.achievedKmFor({ driverId, campaignId: campaign.id });

  return {
    id: campaign.id,
    assignmentId: assignment?.id ?? null,
    name: campaign.name,
    brandName: campaign.brandName,
    logoUrl: null,
    creativeUrl: campaign.creativeKey ? `/v1/driver/campaign/creative` : null,
    status: assignment ? driverStatus(assignment.status, campaign.status) : 'requested',
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    vehicleId: vehicle.id,
    vehicleRegistration: vehicle.registrationNumber,
    rateCard: {
      model: 'zoned',
      zones: [
        { zone: 'prime', label: 'Prime', ratePerKm: toPayable(DRIVER_RATES.prime) },
        { zone: 'secondary', label: 'Secondary', ratePerKm: toPayable(DRIVER_RATES.secondary) },
        { zone: 'network', label: 'Network', ratePerKm: toPayable(DRIVER_RATES.network) },
      ],
    },
    payoutType: 'per_km',
    minMonthlyTargetKm: targetKm,
    expectedMonthlyEarning: toPayable(DRIVER_RATES.secondary.times(targetKm)),
    elapsedDays,
    totalDays,
    daysLeft: Math.max(totalDays - elapsedDays, 0),
    achievedKm,
    terms: CAMPAIGN_TERMS,
    areas: campaign.locations.map((location) => ({
      id: location.id,
      name: location.label,
      zone: location.tier,
      polygon: polygonFor(campaign, location.tier),
    })),
    installation: assignment?.installation
      ? {
          status: assignment.installation.status,
          scheduledFor: assignment.installation.scheduledFor?.toISOString() ?? null,
          rejectionReason: assignment.installation.rejectionReason,
        }
      : null,
  };
}

export { eligibility } from './eligibility';

export async function driverCreative(
  driverId: string,
): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
  // Resolved the same way as the campaign itself, so the artwork a requested
  // campaign advertises in `creativeUrl` is actually fetchable.
  const current = await currentCampaign(driverId);
  const campaign = current?.campaign;
  if (!campaign?.creativeKey) throw new NotFoundError('Creative');

  const stored = await objectStore().get(campaign.creativeKey);
  if (!stored) throw new NotFoundError('Creative');

  return {
    bytes: stored.bytes,
    contentType: stored.contentType,
    fileName: campaign.creativeFileName ?? 'creative',
  };
}

// ---------------------------------------------------------------------------

export interface DriverCampaignView {
  id: string;
  /** Null while this is only an advertiser's request — there is nothing to accept. */
  assignmentId: string | null;
  name: string;
  brandName: string;
  logoUrl: string | null;
  creativeUrl: string | null;
  status:
    | 'requested'
    | 'assigned'
    | 'installation_pending'
    | 'active'
    | 'paused'
    | 'completed';
  startDate: string;
  endDate: string;
  vehicleId: string;
  vehicleRegistration: string;
  rateCard: {
    model: 'zoned';
    zones: { zone: string; label: string; ratePerKm: string }[];
  };
  payoutType: 'per_km';
  minMonthlyTargetKm: number;
  expectedMonthlyEarning: string;
  elapsedDays: number;
  totalDays: number;
  daysLeft: number;
  achievedKm: number;
  terms: string[];
  areas: { id: string; name: string; zone: string; polygon: { lat: number; lng: number }[] }[];
  installation: { status: string; scheduledFor: string | null; rejectionReason: string | null } | null;
}

/** UI-031. Campaign-specific terms are a later migration; these are the platform's. */
const CAMPAIGN_TERMS = [
  'Keep the advertisement visible and clean',
  'Do not remove or damage the wrap',
  'Drive within the campaign areas to earn the higher rate',
  'Follow all traffic rules',
];

/**
 * The campaign has the final word.
 *
 * A wrapped vehicle on a campaign that was stopped or cancelled is not still
 * installing, and reading the assignment first would tell the driver it was —
 * the assignment is ended in the same breath, but the phone may be showing a
 * cached copy of it. Stopped and cancelled both read as finished: the
 * distinction is why operations ended it, which is not the driver's business.
 */
const CAMPAIGN_OVERRIDES: Record<string, DriverCampaignView['status']> = {
  PAUSED: 'paused',
  COMPLETED: 'completed',
  STOPPED: 'completed',
  CANCELLED: 'completed',
};

function driverStatus(
  assignment: AssignmentStatus,
  campaign: string,
): DriverCampaignView['status'] {
  const override = CAMPAIGN_OVERRIDES[campaign];
  if (override) return override;
  if (assignment === 'ASSIGNED') return 'assigned';
  if (assignment === 'ACCEPTED' || assignment === 'INSTALLING') return 'installation_pending';
  return campaign === 'ACTIVE' ? 'active' : 'installation_pending';
}

function polygonFor(campaign: Campaign, tier: string): { lat: number; lng: number }[] {
  const polygons = campaign.zonePolygons;
  const zone = tier === 'prime' ? polygons.prime : polygons.secondary;
  return zone?.path ?? [];
}

async function requiredAngles(assignment: CampaignVehicle): Promise<PhotoAngle[]> {
  const campaign = await loadCampaign(assignment.campaignId);
  return REQUIRED_ANGLES[campaign.vehicleType];
}

async function uploadedAngles(installationId: string): Promise<PhotoAngle[]> {
  const photos = await InstallationPhoto.findAll({ where: { installationId } });
  return photos.map((photo) => photo.angle);
}

async function loadCampaign(id: string): Promise<Campaign> {
  const row = await Campaign.findByPk(id);
  if (!row) throw new NotFoundError('Campaign');
  return row;
}

async function loadAssignment(id: string): Promise<CampaignVehicle> {
  const row = await CampaignVehicle.findByPk(id, {
    include: [
      { model: Vehicle, as: 'vehicle', required: false },
      { model: Driver, as: 'driver', required: false },
      { model: Installation, as: 'installation', required: false },
    ],
  });
  if (!row) throw new NotFoundError('Assignment');
  return row;
}

async function loadInstallation(assignmentId: string): Promise<Installation> {
  const row = await Installation.findOne({ where: { campaignVehicleId: assignmentId } });
  if (!row) throw new NotFoundError('Installation');
  return row;
}

async function toAssignmentView(row: CampaignVehicle): Promise<AssignmentView> {
  const installation = row.installation ?? (await Installation.findOne({
    where: { campaignVehicleId: row.id },
  }));

  const photoCount = installation
    ? await InstallationPhoto.count({ where: { installationId: installation.id } })
    : 0;

  const campaign = await Campaign.findByPk(row.campaignId);
  const required = campaign
    ? REQUIRED_ANGLES[campaign.vehicleType].length
    : 0;

  return {
    id: row.id,
    campaignId: row.campaignId,
    vehicleId: row.vehicleId,
    driverId: row.driverId,
    registrationNumber: row.vehicle?.registrationNumber ?? '',
    driverName: row.driver?.name ?? '',
    vehicleCategory: row.vehicle?.category ?? '',
    status: row.status,
    assignedAt: row.assignedAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    overrideReason: row.overrideReason,
    installation: installation
      ? {
          status: installation.status,
          photoCount,
          requiredCount: required,
          rejectionReason: installation.rejectionReason,
          submittedAt: installation.submittedAt?.toISOString() ?? null,
          reviewedAt: installation.reviewedAt?.toISOString() ?? null,
        }
      : null,
  };
}

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / 86_400_000);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export { toLedger };
