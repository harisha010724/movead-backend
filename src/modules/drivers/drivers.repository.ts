import { Op, QueryTypes, Transaction } from 'sequelize';

import { sequelize } from '../../db/sequelize';
import { Campaign } from '../campaigns/campaigns.model';
import { CampaignVehicle, LIVE_ASSIGNMENT } from '../installations/installations.model';

import {
  Driver,
  DocumentRecord,
  Vehicle,
  VehicleStatusEvent,
  type DocumentKind,
  type DriverStatus,
  type VehicleStatus,
} from './drivers.model';

/**
 * Archived drivers are invisible to every read that feeds a screen or a guard.
 *
 * The row survives because the audit trail points at it (migration 008), but a
 * deleted driver must not appear in the queue, must not be approvable, and must
 * not block the re-use of their mobile number. Filtering in one place rather
 * than at each call site is what stops one of those three being forgotten.
 */
const live = { deletedAt: null };

export function findDriver(id: string): Promise<Driver | null> {
  return Driver.findOne({ where: { id, ...live } });
}

/** Includes archived rows. Only for reads that are *about* the archive. */
export function findDriverIncludingDeleted(id: string): Promise<Driver | null> {
  return Driver.findByPk(id);
}

export function findDriverByMobile(mobile: string): Promise<Driver | null> {
  return Driver.findOne({ where: { mobile, ...live } });
}

export interface DriverListQuery {
  status?: DriverStatus;
  /** Matches a name fragment or a mobile number. */
  search?: string;
  limit: number;
  /** Keyset cursor: the `created_at` of the last row of the previous page. */
  cursor?: string;
}

export async function listDrivers(query: DriverListQuery): Promise<Driver[]> {
  const where: Record<string, unknown> = { ...live };

  if (query.status) where.status = query.status;
  if (query.search) {
    where[Op.or as unknown as string] = [
      { name: { [Op.iLike]: `%${query.search}%` } },
      { mobile: { [Op.like]: `%${query.search}%` } },
    ];
  }
  if (query.cursor) where.createdAt = { [Op.lt]: new Date(query.cursor) };

  return Driver.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit: query.limit,
  });
}

export function findVehicle(id: string): Promise<Vehicle | null> {
  return Vehicle.findByPk(id);
}

export function vehiclesFor(driverId: string): Promise<Vehicle[]> {
  return Vehicle.findAll({ where: { driverId }, order: [['createdAt', 'ASC']] });
}

/**
 * Live vehicles of a type whose driver has an operating pin.
 *
 * Status filter is "not gone": REMOVED, REJECTED and SUSPENDED never match a
 * campaign zone. The caller decides whether PENDING is visible.
 */
export function vehiclesWithBaseLocation(category?: Vehicle['category']): Promise<Vehicle[]> {
  return Vehicle.findAll({
    where: {
      ...(category ? { category } : {}),
      status: { [Op.notIn]: ['REMOVED', 'REJECTED', 'SUSPENDED'] },
    },
    include: [
      {
        model: Driver,
        as: 'driver',
        required: true,
        where: {
          deletedAt: null,
          baseLat: { [Op.not]: null },
          baseLng: { [Op.not]: null },
          status: { [Op.notIn]: ['SUSPENDED'] },
        },
      },
    ],
    order: [['createdAt', 'ASC']],
  });
}

/**
 * Which of the given vehicles are spoken for, and until when.
 *
 * A vehicle is booked because a **live assignment** holds it (AC-22.6) — not
 * because of anything on the vehicle row. Nothing writes `ASSIGNED`,
 * `INSTALLING` or `ACTIVE` to `vehicles.status`: those values exist in the enum
 * but no code path sets them, so availability read from the status alone
 * reported every assigned vehicle as free. This is the read that makes the
 * answer true.
 *
 * The assignment ends when its campaign does, so the date is the campaign's
 * end date. A buyer told only "Booked" has to ring someone to learn when that
 * stops being true; the date lets them plan the next flight themselves.
 *
 * One query for the whole list. Asking per row is the N+1 that makes the
 * picker slow exactly when a zone is busy, which is when it is most looked at.
 *
 * A vehicle carrying two live campaigns cannot exist — a partial unique index
 * forbids it — but if one ever did, the later date wins, because that is when
 * it is genuinely free.
 */
export async function bookedUntilFor(vehicleIds: string[]): Promise<Map<string, string>> {
  if (vehicleIds.length === 0) return new Map();

  const rows = await CampaignVehicle.findAll({
    attributes: ['vehicleId'],
    where: { vehicleId: { [Op.in]: vehicleIds }, status: { [Op.in]: LIVE_ASSIGNMENT } },
    include: [{ model: Campaign, as: 'campaign', required: true, attributes: ['endDate'] }],
  });

  const byVehicle = new Map<string, string>();
  for (const row of rows) {
    const endDate = row.campaign?.endDate;
    if (!endDate) continue;
    const known = byVehicle.get(row.vehicleId);
    if (!known || endDate > known) byVehicle.set(row.vehicleId, endDate);
  }

  return byVehicle;
}

/**
 * The first vehicle of each of the given drivers, keyed by driver.
 *
 * One query for the whole page rather than one per row: the onboarding queue
 * shows a plate against every driver, and doing that per row is the N+1 that
 * makes a review screen slow exactly when the queue is long.
 *
 * "First" is oldest, which for now is the only one — a driver with two vehicles
 * is possible in the schema but not yet in any flow.
 */
export async function firstVehiclesFor(driverIds: string[]): Promise<Map<string, Vehicle>> {
  if (driverIds.length === 0) return new Map();

  const rows = await Vehicle.findAll({
    where: { driverId: { [Op.in]: driverIds } },
    order: [['createdAt', 'ASC']],
  });

  const byDriver = new Map<string, Vehicle>();
  for (const row of rows) {
    if (!byDriver.has(row.driverId)) byDriver.set(row.driverId, row);
  }

  return byDriver;
}

export function recordVehicleTransition(
  event: {
    vehicleId: string;
    fromStatus: VehicleStatus | null;
    toStatus: VehicleStatus;
    reason: string | null;
    actorUserId: string | null;
  },
  transaction?: Transaction,
): Promise<VehicleStatusEvent> {
  return VehicleStatusEvent.create(event, { transaction });
}

export function vehicleHistory(vehicleId: string): Promise<VehicleStatusEvent[]> {
  return VehicleStatusEvent.findAll({
    where: { vehicleId },
    order: [['createdAt', 'DESC']],
  });
}

export function findDocument(id: string): Promise<DocumentRecord | null> {
  return DocumentRecord.findByPk(id);
}

/** Current means not superseded: a resubmission does not overwrite its predecessor. */
export function currentDocuments(owner: {
  driverId?: string;
  vehicleId?: string;
}): Promise<DocumentRecord[]> {
  return DocumentRecord.findAll({
    where: { ...owner, supersededAt: null },
    order: [['kind', 'ASC']],
  });
}

export function findCurrentDocument(
  owner: { driverId?: string; vehicleId?: string },
  kind: DocumentKind,
  transaction?: Transaction,
): Promise<DocumentRecord | null> {
  return DocumentRecord.findOne({
    where: { ...owner, kind, supersededAt: null },
    transaction,
    lock: transaction ? Transaction.LOCK.UPDATE : undefined,
  });
}

export interface RequiredDocument {
  kind: DocumentKind;
  owner: 'DRIVER' | 'VEHICLE';
  isMandatory: boolean;
  expires: boolean;
}

/**
 * Reference data, so a new city needing a permit is an INSERT rather than a
 * deployment (database design Part 5.4).
 */
export async function requiredDocuments(owner: 'DRIVER' | 'VEHICLE'): Promise<RequiredDocument[]> {
  const rows = await sequelize.query<{
    kind: DocumentKind;
    owner: 'DRIVER' | 'VEHICLE';
    is_mandatory: boolean;
    expires: boolean;
  }>('SELECT kind, owner, is_mandatory, expires FROM required_documents WHERE owner = $1', {
    bind: [owner],
    type: QueryTypes.SELECT,
  });

  return rows.map((row) => ({
    kind: row.kind,
    owner: row.owner,
    isMandatory: row.is_mandatory,
    expires: row.expires,
  }));
}
