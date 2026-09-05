import { randomUUID } from 'node:crypto';

import { Op } from 'sequelize';

import { money, toLedger, toPayable } from '../../pricing/money';
import { ADVERTISER_RATE } from '../../pricing/rates';
import * as tracking from '../tracking/tracking.service';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors';
import * as audit from '../audit/audit.service';
import { Advertiser } from '../advertisers/advertisers.model';
import * as notifications from '../notifications/notifications.service';
import { Vehicle } from '../drivers/drivers.model';
import { CampaignVehicle, LIVE_ASSIGNMENT } from '../installations/installations.model';
import { objectStore } from '../storage';

import {
  Campaign,
  type CampaignLocation,
  type CampaignStatus,
  type CampaignVehicleType,
  type ZonePolygons,
} from './campaigns.model';

/** Advertiser can still change the brief before operations has approved it. */
const EDITABLE_STATUSES = new Set<CampaignStatus>([
  'DRAFT',
  'PENDING_CONFIRMATION',
  'PENDING_APPROVAL',
]);

const MINIMUM_DAYS = 7;
const MINIMUM_BUDGET = money(10_000);
const MAX_CREATIVE_BYTES = 25 * 1024 * 1024;
const ACCEPTED_TYPES = {
  'image/png': 'png',
  'application/pdf': 'pdf',
} as const;

/** Pilot rates per verified km, charged to the advertiser (₹5 / ₹2 / ₹1). */
const ADVERTISER_RATES = {
  prime: money(ADVERTISER_RATE.prime),
  secondary: money(ADVERTISER_RATE.secondary),
  network: money(ADVERTISER_RATE.network),
};
const KM_PER_VEHICLE_DAY = 80;

export interface CampaignView {
  id: string;
  name: string;
  brandName: string;
  status: string;
  city: string;
  vehicleType: CampaignVehicleType;
  startDate: string;
  endDate: string;
  budget: string;
  spent: string;
  remaining: string;
  zonePrime: string;
  zoneSecondary: string;
  zoneNetwork: string;
  zonePrimeKm: string;
  zoneSecondaryKm: string;
  locations: CampaignLocation[];
  zonePolygons: ZonePolygons;
  requestedVehicleIds: string[];
  targetKm: string | null;
  creativeKey: string | null;
  creativeFileName: string | null;
  vehicleCount: number;
  verifiedKm: number;
  impressions: number;
}

export interface AdminCampaignView extends CampaignView {
  advertiser: { id: string; legalName: string; brandName: string };
  createdBy: string;
  submittedAt: string;
}

export async function listForAdvertiser(input: {
  advertiserId: string;
  page: number;
  pageSize: number;
  status?: string;
}): Promise<{ items: CampaignView[]; page: number; pageSize: number; total: number }> {
  const where = {
    advertiserId: input.advertiserId,
    ...(input.status ? { status: input.status } : {}),
  };

  const { rows, count } = await Campaign.findAndCountAll({
    where,
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    offset: (input.page - 1) * input.pageSize,
    limit: input.pageSize,
  });

  return {
    items: await withTotals(rows.map(toView)),
    page: input.page,
    pageSize: input.pageSize,
    total: count,
  };
}

export async function createForAdvertiser(input: {
  advertiserId: string;
  createdBy: string;
  name: string;
  brandName: string;
  city: string;
  vehicleType: CampaignVehicleType;
  startDate: string;
  endDate: string;
  zonePrimeKm?: string;
  zoneSecondaryKm?: string;
  locations?: CampaignLocation[];
  zonePolygons?: ZonePolygons;
  requestedVehicleIds?: string[];
  targetKm?: string;
  creativeKey?: string;
  ip: string | null;
}): Promise<CampaignView> {
  assertDates(input.startDate, input.endDate);
  const zones = zoneBudgets(input);
  if (zones.budget.lt(MINIMUM_BUDGET)) {
    throw new BadRequestError('Minimum campaign budget is ₹10,000 (Prime km × ₹5 + Secondary km × ₹2).');
  }

  const requestedVehicleIds = await assertRequestedVehicles(
    input.requestedVehicleIds ?? [],
    input.vehicleType,
  );

  const targetKm = input.targetKm && input.targetKm !== '' ? input.targetKm : null;
  const creative = input.creativeKey
    ? await resolveOwnedCreative(input.createdBy, input.creativeKey)
    : null;

  const created = await Campaign.create({
    advertiserId: input.advertiserId,
    name: input.name,
    brandName: input.brandName,
    city: input.city,
    vehicleType: input.vehicleType,
    startDate: input.startDate,
    endDate: input.endDate,
    budgetAmount: toLedger(zones.budget),
    spentAmount: toLedger(money(0)),
    zoneBudgetPrime: toLedger(zones.prime),
    zoneBudgetSecondary: toLedger(zones.secondary),
    zoneBudgetNetwork: toLedger(money(0)),
    zoneKmPrime: toLedger(zones.primeKm),
    zoneKmSecondary: toLedger(zones.secondaryKm),
    locations: input.locations ?? [],
    zonePolygons: input.zonePolygons ?? {},
    requestedVehicleIds,
    targetKm,
    creativeKey: creative?.key ?? null,
    creativeFileName: creative?.fileName ?? null,
    creativeContentType: creative?.contentType ?? null,
    creativeByteSize: creative?.byteSize ?? null,
    status: 'PENDING_APPROVAL',
    createdBy: input.createdBy,
  });

  await audit.record({
    action: 'campaign.submitted',
    entityType: 'campaign',
    entityId: created.id,
    after: { name: created.name, budget: created.budgetAmount, city: created.city },
    actorUserId: input.createdBy,
    ip: input.ip,
  });

  const advertiser = await Advertiser.findByPk(input.advertiserId);
  await notifications.notifyStaff({
    kind: 'CAMPAIGN',
    title: 'New campaign awaiting review',
    body: `${advertiser?.brandName ?? 'An advertiser'} submitted “${created.name}”.`,
    href: '/campaign-review',
  });

  return withTotal(toView(created));
}

export async function getForAdvertiser(
  advertiserId: string,
  id: string,
): Promise<CampaignView> {
  return withTotal(toView(await loadOwned(advertiserId, id)));
}

export async function updateForAdvertiser(input: {
  advertiserId: string;
  id: string;
  actorUserId: string;
  name: string;
  brandName: string;
  city: string;
  vehicleType: CampaignVehicleType;
  startDate: string;
  endDate: string;
  zonePrimeKm?: string;
  zoneSecondaryKm?: string;
  locations?: CampaignLocation[];
  zonePolygons?: ZonePolygons;
  requestedVehicleIds?: string[];
  targetKm?: string;
  creativeKey?: string;
  ip: string | null;
}): Promise<CampaignView> {
  const row = await loadOwned(input.advertiserId, input.id);
  if (!EDITABLE_STATUSES.has(row.status)) {
    throw new ConflictError('This campaign can no longer be edited.');
  }

  assertDates(input.startDate, input.endDate);
  const zones = zoneBudgets(input);
  if (zones.budget.lt(MINIMUM_BUDGET)) {
    throw new BadRequestError('Minimum campaign budget is ₹10,000 (Prime km × ₹5 + Secondary km × ₹2).');
  }

  const requestedVehicleIds = await assertRequestedVehicles(
    input.requestedVehicleIds ?? [],
    input.vehicleType,
  );

  const targetKm = input.targetKm && input.targetKm !== '' ? input.targetKm : null;
  const creative = input.creativeKey
    ? await resolveOwnedCreative(input.actorUserId, input.creativeKey)
    : null;

  await row.update({
    name: input.name,
    brandName: input.brandName,
    city: input.city,
    vehicleType: input.vehicleType,
    startDate: input.startDate,
    endDate: input.endDate,
    budgetAmount: toLedger(zones.budget),
    zoneBudgetPrime: toLedger(zones.prime),
    zoneBudgetSecondary: toLedger(zones.secondary),
    zoneBudgetNetwork: toLedger(money(0)),
    zoneKmPrime: toLedger(zones.primeKm),
    zoneKmSecondary: toLedger(zones.secondaryKm),
    locations: input.locations ?? [],
    zonePolygons: input.zonePolygons ?? {},
    requestedVehicleIds,
    targetKm,
    ...(creative
      ? {
          creativeKey: creative.key,
          creativeFileName: creative.fileName,
          creativeContentType: creative.contentType,
          creativeByteSize: creative.byteSize,
        }
      : {}),
  });

  await audit.record({
    action: 'campaign.updated',
    entityType: 'campaign',
    entityId: row.id,
    after: { name: row.name, budget: row.budgetAmount, city: row.city },
    actorUserId: input.actorUserId,
    ip: input.ip,
  });

  return withTotal(toView(row));
}

export async function listForAdmin(input: {
  page: number;
  pageSize: number;
  status?: string;
}): Promise<{ items: AdminCampaignView[]; page: number; pageSize: number; total: number }> {
  const where = input.status ? { status: input.status } : {};

  const { rows, count } = await Campaign.findAndCountAll({
    where,
    include: [{ model: Advertiser, as: 'advertiser', required: true }],
    distinct: true,
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    offset: (input.page - 1) * input.pageSize,
    limit: input.pageSize,
  });

  return {
    items: await withTotals(rows.map(toAdminView)),
    page: input.page,
    pageSize: input.pageSize,
    total: count,
  };
}

export async function getForAdmin(id: string): Promise<AdminCampaignView> {
  return withTotal(toAdminView(await loadCampaign(id)));
}

// ------------------------------------------------------- production pipeline

interface Announcement {
  title: string;
  body: string;
}

/**
 * One step of the campaign pipeline as operations performs it (AC-34.10).
 *
 * These were eight near-identical functions, and the part that kept being left
 * out was the driver. A driver whose vehicle is wrapped has more riding on a
 * pause than the advertiser does — their kilometres stop counting — and had no
 * way to learn of one except by noticing their earnings had stopped. Making
 * the audience part of the step's declaration means adding a step cannot
 * quietly skip them.
 */
interface Step {
  from: CampaignStatus[];
  to: CampaignStatus;
  /** Audit action: dotted, past tense. */
  action: string;
  /** Said when the campaign is not in `from`. */
  refuse: string;
  advertiser: (campaign: Campaign, reason: string) => Announcement;
  /** Omitted where no driver can be carrying the campaign yet. */
  driver?: (campaign: Campaign, reason: string) => Announcement;
  /**
   * Ends live assignments. A finished campaign that leaves them live holds
   * its vehicles booked forever — availability is read from the assignment,
   * not from the vehicle row (AC-22.4a).
   */
  releasesVehicles?: boolean;
}

const STEPS = {
  approve: {
    from: ['PENDING_APPROVAL'],
    to: 'APPROVED',
    action: 'campaign.approved',
    refuse: 'Only a campaign in review can be approved.',
    advertiser: (c) => ({
      title: 'Campaign approved',
      body: `“${c.name}” has been approved. The ads have been sent to the printer.`,
    }),
    // Vehicles are assigned after approval, so nobody is carrying it yet.
  },
  printReady: {
    from: ['APPROVED'],
    to: 'AWAITING_INSTALLATION',
    action: 'campaign.print_ready',
    refuse: 'Only a campaign at the printer can be marked print-ready.',
    advertiser: (c) => ({
      title: 'Ads are ready to install',
      body: `Print for “${c.name}” has arrived. We are installing the ads on vehicles.`,
    }),
    driver: (c) => ({
      title: 'Your wrap is ready',
      body: `The print for “${c.name}” has arrived. We will be in touch to fit it to your vehicle.`,
    }),
  },
  installed: {
    from: ['AWAITING_INSTALLATION'],
    to: 'ACTIVE',
    action: 'campaign.installed',
    refuse: 'Only a campaign being installed can be marked installed.',
    advertiser: (c) => ({
      title: 'Ads are installed',
      body: `“${c.name}” is now live on vehicles.`,
    }),
    driver: (c) => ({
      title: 'Your campaign is live',
      body: `“${c.name}” is running. Start a trip and every verified kilometre earns.`,
    }),
  },
  reject: {
    from: ['PENDING_APPROVAL'],
    to: 'CANCELLED',
    action: 'campaign.rejected',
    refuse: 'Only a campaign in review can be rejected.',
    advertiser: (c, reason) => ({
      title: 'Campaign not approved',
      body: `“${c.name}” was rejected. ${reason}`,
    }),
    driver: (c) => ({
      title: 'Campaign cancelled',
      body: `“${c.name}” will not go ahead. Your vehicle is free for the next campaign.`,
    }),
    releasesVehicles: true,
  },

  /*
   * The four below existed in the status enum and in every status badge the
   * three clients draw, and nothing had ever written them. A campaign could
   * be started and never stopped.
   */
  pause: {
    from: ['ACTIVE', 'BUDGET_WARNING'],
    to: 'PAUSED',
    action: 'campaign.paused',
    refuse: 'Only a running campaign can be paused.',
    advertiser: (c, reason) => ({
      title: 'Campaign paused',
      body: `“${c.name}” is paused and no kilometres are being billed. ${reason}`,
    }),
    driver: (c) => ({
      title: 'Campaign paused',
      body: `“${c.name}” is paused, so kilometres are not counting for now. Leave the wrap on — we will tell you when it restarts.`,
    }),
  },
  resume: {
    from: ['PAUSED'],
    to: 'ACTIVE',
    action: 'campaign.resumed',
    refuse: 'Only a paused campaign can be resumed.',
    advertiser: (c) => ({
      title: 'Campaign resumed',
      body: `“${c.name}” is running again and billing has restarted.`,
    }),
    driver: (c) => ({
      title: 'Campaign is running again',
      body: `“${c.name}” has restarted. Your kilometres count from now.`,
    }),
  },
  complete: {
    from: ['ACTIVE', 'PAUSED', 'BUDGET_WARNING'],
    to: 'COMPLETED',
    action: 'campaign.completed',
    refuse: 'Only a running or paused campaign can be completed.',
    advertiser: (c) => ({
      title: 'Campaign complete',
      body: `“${c.name}” has finished its run. The vehicles have been released.`,
    }),
    driver: (c) => ({
      title: 'Campaign finished',
      body: `“${c.name}” has ended. What you have earned is unaffected, and your vehicle is free for the next campaign.`,
    }),
    releasesVehicles: true,
  },
  stop: {
    from: ['ACTIVE', 'PAUSED', 'BUDGET_WARNING'],
    to: 'STOPPED',
    action: 'campaign.stopped',
    refuse: 'Only a running or paused campaign can be stopped.',
    advertiser: (c, reason) => ({
      title: 'Campaign stopped',
      body: `“${c.name}” was stopped before its end date. ${reason}`,
    }),
    driver: (c) => ({
      title: 'Campaign stopped',
      body: `“${c.name}” was stopped early, so kilometres stop counting now. What you have earned is unaffected.`,
    }),
    releasesVehicles: true,
  },
} satisfies Record<string, Step>;

interface StepInput {
  id: string;
  actorUserId: string;
  ip: string | null;
  reason?: string;
  /** A rule that belongs to one step only, checked after the status guard. */
  guard?: (campaign: Campaign) => void | Promise<void>;
}

async function runStep(step: Step, input: StepInput): Promise<AdminCampaignView> {
  const row = await loadCampaign(input.id);
  if (!step.from.includes(row.status)) throw new ConflictError(step.refuse);
  await input.guard?.(row);

  const reason = input.reason ?? '';
  const from = row.status;
  await row.update({ status: step.to });

  const released = step.releasesVehicles ? await releaseVehicles(row.id, reason) : [];

  await audit.record({
    action: step.action,
    entityType: 'campaign',
    entityId: row.id,
    before: { status: from },
    after: {
      status: step.to,
      ...(reason ? { reason } : {}),
      ...(released.length > 0 ? { releasedVehicles: released.length } : {}),
    },
    actorUserId: input.actorUserId,
    ip: input.ip,
  });

  await notifications.notifyAdvertiserUsers({
    advertiserId: row.advertiserId,
    kind: 'CAMPAIGN',
    ...step.advertiser(row, reason),
    href: '/campaigns',
  });

  if (step.driver) {
    /*
     * Everyone who was carrying it, read before the release above would have
     * emptied the list — a driver is owed the news that a campaign ended more
     * than the news that it started.
     */
    const driverIds = released.length > 0 ? released : await liveDriverIds(row.id);
    await notifications.notifyDrivers({
      driverIds,
      kind: 'CAMPAIGN',
      ...step.driver(row, reason),
      href: '/driver/campaign',
    });
  }

  return withTotal(toAdminView(await loadCampaign(row.id)));
}

/** Drivers whose vehicles are currently spoken for by this campaign. */
async function liveDriverIds(campaignId: string): Promise<string[]> {
  const rows = await CampaignVehicle.findAll({
    attributes: ['driverId'],
    where: { campaignId, status: { [Op.in]: LIVE_ASSIGNMENT } },
  });
  return rows.map((row) => row.driverId);
}

/**
 * Hands the vehicles back. Returns the drivers who were on them, because they
 * are exactly the people who need telling and the rows no longer say so.
 *
 * `ENDED` throughout, including for a vehicle that never got as far as being
 * wrapped: the campaign finishing is not the same event as operations taking
 * a driver off one, and `WITHDRAWN` is what the driver's view reads to tell
 * the two apart.
 */
async function releaseVehicles(campaignId: string, reason: string): Promise<string[]> {
  const rows = await CampaignVehicle.findAll({
    where: { campaignId, status: { [Op.in]: LIVE_ASSIGNMENT } },
  });
  await Promise.all(
    rows.map((row) =>
      row.update({
        status: 'ENDED',
        endedAt: new Date(),
        endReason: reason || 'The campaign ended.',
      }),
    ),
  );
  return rows.map((row) => row.driverId);
}

export async function approveForAdmin(input: {
  id: string;
  actorUserId: string;
  ip: string | null;
}): Promise<AdminCampaignView> {
  return runStep(STEPS.approve, {
    ...input,
    guard: (campaign) => {
      if (campaign.createdBy === input.actorUserId) {
        throw new ForbiddenError('The admin who created this campaign cannot approve it.');
      }
    },
  });
}

/**
 * Printer delivered the wraps. The published machine moves APPROVED →
 * AWAITING_INSTALLATION when vehicles are assigned; you cannot wrap a vehicle
 * without the print, so this is the campaign-level gate. Per-vehicle install
 * (AC-06) still happens after this.
 */
export async function markPrintReadyForAdmin(input: {
  id: string;
  actorUserId: string;
  ip: string | null;
}): Promise<AdminCampaignView> {
  return runStep(STEPS.printReady, input);
}

/**
 * Wraps are on the vehicles. Campaign-level until AC-06 records each
 * installation with photos; you still cannot skip print or review.
 *
 * And there have to be vehicles. Nothing used to check, so a campaign could be
 * walked review → print → installed without a single vehicle assigned to it
 * and would sit there reading `ACTIVE`: live on nothing, unable to bill a
 * kilometre, while the driver whose vehicle the advertiser had asked for was
 * still on `Requested` waiting to be confirmed by a step that had been skipped
 * (AC-34.10). The advertiser's screen said the campaign was running. It was
 * the only screen that thought so.
 */
export async function markInstalledForAdmin(input: {
  id: string;
  actorUserId: string;
  ip: string | null;
}): Promise<AdminCampaignView> {
  return runStep(STEPS.installed, {
    ...input,
    guard: async (campaign) => {
      const assigned = await CampaignVehicle.count({
        where: { campaignId: campaign.id, status: { [Op.in]: LIVE_ASSIGNMENT } },
      });
      if (assigned === 0) {
        throw new ConflictError(
          'No vehicle is assigned to this campaign, so there is nothing the wraps could be on. Assign the vehicles first.',
        );
      }
    },
  });
}

export async function rejectForAdmin(input: {
  id: string;
  reason: string;
  actorUserId: string;
  ip: string | null;
}): Promise<AdminCampaignView> {
  return runStep(STEPS.reject, input);
}

/**
 * Stops the meter without undressing the vehicles (AC-34.10).
 *
 * Tracking eligibility requires a running campaign, so this is what actually
 * halts billable kilometres; the wrap stays on and the assignment stays live
 * so the same vehicles resume rather than being re-recruited.
 */
export async function pauseForAdmin(input: {
  id: string;
  reason: string;
  actorUserId: string;
  ip: string | null;
}): Promise<AdminCampaignView> {
  return runStep(STEPS.pause, input);
}

export async function resumeForAdmin(input: {
  id: string;
  actorUserId: string;
  ip: string | null;
}): Promise<AdminCampaignView> {
  return runStep(STEPS.resume, input);
}

/** Ran its course. Distinct from stopped, which is a decision to cut it short. */
export async function completeForAdmin(input: {
  id: string;
  actorUserId: string;
  ip: string | null;
}): Promise<AdminCampaignView> {
  return runStep(STEPS.complete, input);
}

export async function stopForAdmin(input: {
  id: string;
  reason: string;
  actorUserId: string;
  ip: string | null;
}): Promise<AdminCampaignView> {
  return runStep(STEPS.stop, input);
}

export async function readAdminCreative(
  id: string,
): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
  const row = await loadCampaign(id);
  if (!row.creativeKey) throw new NotFoundError('Creative');
  const stored = await objectStore().get(row.creativeKey);
  if (!stored) throw new NotFoundError('Creative');
  return {
    bytes: stored.bytes,
    contentType: stored.contentType,
    fileName: row.creativeFileName ?? row.creativeKey.split('/').pop() ?? 'creative',
  };
}

async function loadCampaign(id: string): Promise<Campaign> {
  const row = await Campaign.findByPk(id, {
    include: [{ model: Advertiser, as: 'advertiser', required: true }],
  });
  if (!row) throw new NotFoundError('Campaign');
  return row;
}

async function loadOwned(advertiserId: string, id: string): Promise<Campaign> {
  const row = await Campaign.findOne({ where: { id, advertiserId } });
  if (!row) throw new NotFoundError('Campaign');
  return row;
}

export function estimate(input: {
  startDate: string;
  endDate: string;
  zonePrimeKm?: string;
  zoneSecondaryKm?: string;
}): {
  budget: string;
  estimatedKm: { prime: number; secondary: number; network: number };
  estimatedSpend: { prime: string; secondary: string; network: string; total: string };
  estimatedVehicles: number;
  estimatedDays: number;
} {
  assertDates(input.startDate, input.endDate);
  const zones = zoneBudgets(input);
  if (zones.budget.lte(0)) {
    throw new BadRequestError('Enter kilometres in Prime or Secondary.');
  }

  const days = inclusiveDays(input.startDate, input.endDate);
  const km = {
    prime: zones.primeKm,
    secondary: zones.secondaryKm,
    network: money(0),
  };
  const totalKm = km.prime.plus(km.secondary).plus(km.network);
  const vehicles = Math.max(1, Math.ceil(totalKm.div(days * KM_PER_VEHICLE_DAY).toNumber()));

  return {
    budget: toPayable(zones.budget),
    estimatedKm: {
      prime: Number(km.prime.toFixed(1)),
      secondary: Number(km.secondary.toFixed(1)),
      network: Number(km.network.toFixed(1)),
    },
    estimatedSpend: {
      prime: toPayable(zones.prime),
      secondary: toPayable(zones.secondary),
      network: toPayable(money(0)),
      total: toPayable(zones.budget),
    },
    estimatedVehicles: vehicles,
    estimatedDays: days,
  };
}

export async function storeCreative(input: {
  userId: string;
  fileName: string;
  contentType: string;
  bytes: Buffer;
}): Promise<{ storageKey: string; fileName: string; contentType: string; byteSize: number }> {
  const ext = ACCEPTED_TYPES[input.contentType as keyof typeof ACCEPTED_TYPES];
  if (!ext) throw new BadRequestError('Accepted: PDF or PNG, up to 25 MB.');
  if (input.bytes.length === 0) throw new BadRequestError('The file is empty.');
  if (input.bytes.length > MAX_CREATIVE_BYTES) {
    throw new BadRequestError('File must be 25 MB or smaller.');
  }

  const key = `${input.userId}/${randomUUID()}.${ext}`;
  await objectStore().put(key, input.bytes, input.contentType);

  return {
    storageKey: key,
    fileName: input.fileName,
    contentType: input.contentType,
    byteSize: input.bytes.length,
  };
}

export async function readOwnedCreative(
  userId: string,
  key: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  assertOwnedKey(userId, key);
  const stored = await objectStore().get(key);
  if (!stored) throw new NotFoundError('Creative');
  return stored;
}

async function resolveOwnedCreative(
  userId: string,
  key: string,
): Promise<{ key: string; fileName: string; contentType: string; byteSize: number }> {
  assertOwnedKey(userId, key);
  const stored = await objectStore().get(key);
  if (!stored) throw new BadRequestError('Upload the creative again before submitting.');
  return {
    key,
    fileName: key.split('/')[1] ?? key,
    contentType: stored.contentType,
    byteSize: stored.bytes.length,
  };
}

function assertOwnedKey(userId: string, key: string): void {
  if (!key.startsWith(`${userId}/`) || key.includes('..')) {
    throw new ForbiddenError('That file does not belong to this account.');
  }
}

async function assertRequestedVehicles(
  ids: string[],
  category: CampaignVehicleType,
): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];

  const rows = await Vehicle.findAll({
    where: {
      id: { [Op.in]: unique },
      category,
      status: { [Op.notIn]: ['REMOVED', 'REJECTED'] },
    },
  });

  if (rows.length !== unique.length) {
    throw new BadRequestError(
      'One or more selected vehicles are not available for this campaign.',
    );
  }

  return unique;
}

function assertDates(startDate: string, endDate: string): void {
  if (endDate < startDate) {
    throw new BadRequestError('End date cannot be before the start date.');
  }
  if (inclusiveDays(startDate, endDate) < MINIMUM_DAYS) {
    throw new BadRequestError(`A campaign must run for at least ${String(MINIMUM_DAYS)} days.`);
  }
}

function inclusiveDays(startDate: string, endDate: string): number {
  return (
    (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000 + 1
  );
}

function zoneBudgets(input: { zonePrimeKm?: string; zoneSecondaryKm?: string }) {
  const primeKm = money(input.zonePrimeKm || 0);
  const secondaryKm = money(input.zoneSecondaryKm || 0);
  if (primeKm.lt(0) || secondaryKm.lt(0)) {
    throw new BadRequestError('Zone kilometres cannot be negative.');
  }
  const prime = primeKm.times(ADVERTISER_RATES.prime);
  const secondary = secondaryKm.times(ADVERTISER_RATES.secondary);
  return {
    primeKm,
    secondaryKm,
    prime,
    secondary,
    budget: prime.plus(secondary),
  };
}

function toView(row: Campaign): CampaignView {
  const budget = money(row.budgetAmount);
  const spent = money(row.spentAmount);
  return {
    id: row.id,
    name: row.name,
    brandName: row.brandName,
    status: row.status,
    city: row.city,
    vehicleType: row.vehicleType,
    startDate: String(row.startDate).slice(0, 10),
    endDate: String(row.endDate).slice(0, 10),
    budget: toPayable(budget),
    spent: toPayable(spent),
    remaining: toPayable(budget.minus(spent)),
    zonePrime: toPayable(money(row.zoneBudgetPrime ?? 0)),
    zoneSecondary: toPayable(money(row.zoneBudgetSecondary ?? 0)),
    zoneNetwork: toPayable(money(row.zoneBudgetNetwork ?? 0)),
    zonePrimeKm: money(row.zoneKmPrime ?? 0).toFixed(1),
    zoneSecondaryKm: money(row.zoneKmSecondary ?? 0).toFixed(1),
    locations: row.locations ?? [],
    zonePolygons: row.zonePolygons ?? {},
    requestedVehicleIds: row.requestedVehicleIds ?? [],
    targetKm: row.targetKm,
    creativeKey: row.creativeKey,
    creativeFileName: row.creativeFileName,
    vehicleCount: (row.requestedVehicleIds ?? []).length,
    verifiedKm: 0,
    impressions: 0,
  };
}

/**
 * Fill in what the campaign has actually had driven for it.
 *
 * `verifiedKm` was a literal zero and `spent` came from `campaigns.spent_amount`,
 * a column nothing has ever written — so an advertiser watching a live campaign
 * saw a budget draining at exactly no rupees per hour. Both are now summed from
 * `trip_segments`, which is the only place the answer exists and, per AC-00,
 * the only place it may come from: a spend figure held as its own number is a
 * spend figure that can disagree with the kilometres behind it.
 */
async function withTotals<T extends CampaignView>(views: T[]): Promise<T[]> {
  if (views.length === 0) return views;
  const totals = await tracking.campaignTotalsFor(views.map((view) => view.id));

  return views.map((view) => {
    const total = totals.get(view.id);
    if (!total) return view;

    const spent = money(total.spend);
    return {
      ...view,
      verifiedKm: total.verifiedKm,
      spent: toPayable(spent),
      remaining: toPayable(money(view.budget).minus(spent)),
    };
  });
}

async function withTotal<T extends CampaignView>(view: T): Promise<T> {
  return (await withTotals([view]))[0] as T;
}

function toAdminView(row: Campaign): AdminCampaignView {
  const advertiser = row.advertiser;
  if (!advertiser) throw new NotFoundError('Advertiser');
  return {
    ...toView(row),
    advertiser: {
      id: advertiser.id,
      legalName: advertiser.legalName,
      brandName: advertiser.brandName,
    },
    createdBy: row.createdBy,
    submittedAt: row.createdAt.toISOString(),
  };
}
