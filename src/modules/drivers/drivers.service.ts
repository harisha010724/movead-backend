import { randomUUID } from 'node:crypto';

import { UniqueConstraintError, type Transaction } from 'sequelize';

import { sequelize } from '../../db/sequelize';
import { config } from '../../shared/config';
import { zoneForPoint } from '../../shared/geo';
import { ConflictError, NotFoundError, UnprocessableError } from '../../shared/errors';
import * as audit from '../audit/audit.service';
import { type ZonePolygons } from '../campaigns/campaigns.model';
import { generateLoginPassword, hashPassword } from '../identity/credentials';
import { User } from '../identity/identity.model';
import * as identityRepo from '../identity/identity.repository';
import * as mail from '../mail/mail.service';
import { objectStore } from '../storage';
import * as tracking from '../tracking/tracking.service';

import {
  Driver,
  DocumentRecord,
  DriverConsent,
  Vehicle,
  type DocumentKind,
  type DocumentStatus,
  type DriverStatus,
  type FuelType,
  type VehicleCategory,
  type VehicleStatus,
} from './drivers.model';
import * as repo from './drivers.repository';

/**
 * Driver onboarding and the admin review that gates it (AC-04, AC-05, AC-32).
 *
 * The rule the whole module is built around: **a rejection carries a reason,
 * and the driver is told what it was.** AC-05.5 requires it, the database
 * refuses the row without it, and every reject path here takes the reason as a
 * required argument rather than an option.
 *
 * The admin creates the driver record; the driver fills in their own details
 * afterwards from the app. Those driver-facing endpoints arrive with driver
 * authentication — the service methods they need are already here and simply
 * take a `driverId` rather than reading one from an admin's request.
 */

export interface Actor {
  userId: string;
  ip: string | null;
  createdByName?: string;
}

const DRIVER_ROLE = 'DRIVER';

// ------------------------------------------------------------------- drivers

export interface VehicleInput {
  registrationNumber: string;
  category: VehicleCategory;
  bodyType?: string | null;
  makeModel?: string | null;
  colour?: string | null;
  manufactureYear?: number | null;
  fuelType?: FuelType | null;
}

export interface DriverLocationInput {
  city?: string;
  label: string;
  lat: number;
  lng: number;
}

/**
 * The vehicle is optional but, when given, is created in the same transaction.
 *
 * Onboarding is one act to the admin: a name, a number and a plate, entered on
 * one form. Split across two commits, a plate already taken (AC-05.7) would
 * leave a driver with no vehicle behind and the mobile number spent, so the
 * obvious retry — resubmit the form with a corrected plate — would fail on the
 * mobile instead. Both rows or neither.
 */
export interface OnboardedDriver {
  driver: Driver;
  vehicle: Vehicle | null;
  user: { id: string; email: string; status: 'ACTIVE' };
  invitationEmailed: boolean;
}

export async function createDriver(
  input: {
    mobile: string;
    name: string;
    email: string;
    vehicle?: VehicleInput | null;
    location?: DriverLocationInput;
  },
  actor: Actor,
): Promise<OnboardedDriver> {
  if (await repo.findDriverByMobile(input.mobile)) {
    throw new ConflictError('A driver with that mobile number already exists.', {
      fields: ['mobile'],
    });
  }

  const pin = locationColumns(input.location);

  const created = await sequelize
    .transaction(async (transaction) => {
      const driver = await Driver.create(
        {
          mobile: input.mobile,
          name: input.name,
          // AC-04.7: on creation a driver is PENDING and cannot receive campaigns.
          status: 'PENDING',
          photoKey: null,
          suspendedReason: null,
          rejectionReason: null,
          city: pin.city,
          baseLat: pin.baseLat,
          baseLng: pin.baseLng,
          baseLabel: pin.baseLabel,
        },
        { transaction },
      );

      await audit.record(
        {
          action: 'driver.created',
          entityType: 'driver',
          entityId: driver.id,
          after: { mobile: driver.mobile, name: driver.name, email: input.email },
          actorUserId: actor.userId,
          ip: actor.ip,
        },
        transaction,
      );

      const vehicle = input.vehicle
        ? await createVehicle(driver.id, input.vehicle, actor, transaction)
        : null;

      const password = generateLoginPassword();
      const user = await identityRepo.createUser(
        {
          email: input.email,
          fullName: input.name,
          passwordHash: await hashPassword(password),
          driverId: driver.id,
          status: 'ACTIVE',
        },
        transaction,
      );

      await identityRepo.grantRole(user.id, DRIVER_ROLE, actor.userId, transaction);

      await audit.record(
        {
          action: 'driver.user_invited',
          entityType: 'user',
          entityId: user.id,
          after: { email: user.email, driverId: driver.id, role: DRIVER_ROLE },
          actorUserId: actor.userId,
          ip: actor.ip,
        },
        transaction,
      );

      return {
        driver,
        vehicle,
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
        },
        password,
      };
    })
    .catch((error: unknown) => {
      if (error instanceof UniqueConstraintError) {
        const fields = Object.keys(error.fields);
        if (fields.some((field) => /email/i.test(field))) {
          throw new ConflictError('That email address is already registered.', { fields: ['email'] });
        }
      }
      throw error;
    });

  const emailed = await mail.sendDriverInvitation({
    fullName: created.user.fullName,
    email: created.user.email,
    password: created.password,
    portalUrl: config.portals.driver,
    invitedBy: actor.createdByName ?? 'MoveAd Operations',
  });

  return {
    driver: created.driver,
    vehicle: created.vehicle,
    user: { id: created.user.id, email: created.user.email, status: 'ACTIVE' },
    invitationEmailed: emailed,
  };
}

/**
 * The driver's own edits, and the admin's corrections, take the same path.
 *
 * The mobile is editable because it is the ops contact most often mistyped.
 * It is refused once they are past PENDING, by which point they have used the
 * account and changing it underneath them would break operations contact.
 */
export async function updateDriverProfile(
  driverId: string,
  changes: { name?: string; mobile?: string; photoKey?: string; location?: DriverLocationInput },
  actor: Actor,
): Promise<Driver> {
  const driver = await require_(driverId);
  const before = { name: driver.name, mobile: driver.mobile, photoKey: driver.photoKey };

  if (changes.mobile !== undefined && changes.mobile !== driver.mobile) {
    if (driver.status !== 'PENDING') {
      throw new UnprocessableError(
        'mobile_locked',
        'The mobile number can only be corrected while the driver is still pending. They have signed in with it.',
      );
    }

    const holder = await repo.findDriverByMobile(changes.mobile);
    if (holder) {
      throw new ConflictError('A driver with that mobile number already exists.', {
        fields: ['mobile'],
      });
    }

    driver.mobile = changes.mobile;
  }

  if (changes.name !== undefined) driver.name = changes.name;
  if (changes.photoKey !== undefined) driver.photoKey = changes.photoKey;
  if (changes.location) applyLocation(driver, changes.location);
  await driver.save();

  await audit.record({
    action: 'driver.updated',
    entityType: 'driver',
    entityId: driver.id,
    before,
    after: { name: driver.name, mobile: driver.mobile, photoKey: driver.photoKey },
    actorUserId: actor.userId,
    ip: actor.ip,
  });

  return driver;
}

/**
 * Removes a driver from the platform. Archives rather than deletes.
 *
 * `audit_log` references this row and is append-only (AC-31.5), so an actual
 * DELETE would either erase the trail or fail on the foreign key. Setting
 * `deleted_at` takes them out of every list and every guard while leaving an
 * auditor something to read — and, because the unique indexes are conditional
 * (migration 008), frees their mobile number and plate for re-use.
 *
 * Their vehicles go to REMOVED, a state the enum already had for exactly this.
 */
export async function deleteDriver(
  driverId: string,
  reason: string,
  actor: Actor,
): Promise<Driver> {
  const driver = await require_(driverId);

  return sequelize.transaction(async (transaction) => {
    const vehicles = await repo.vehiclesFor(driverId);

    for (const vehicle of vehicles) {
      if (vehicle.status === 'REMOVED') continue;

      const from = vehicle.status;
      vehicle.status = 'REMOVED';
      await vehicle.save({ transaction });

      await repo.recordVehicleTransition(
        {
          vehicleId: vehicle.id,
          fromStatus: from,
          toStatus: 'REMOVED',
          reason,
          actorUserId: actor.userId,
        },
        transaction,
      );
    }

    driver.deletedAt = new Date();
    driver.deletedReason = reason;
    await driver.save({ transaction });

    // Free the sign-in address so the same person can be onboarded again.
    // The login row stays for the audit trail; only the mailbox is released.
    const login = await User.findOne({ where: { driverId }, transaction });
    if (login) {
      login.status = 'DISABLED';
      login.email = `deleted+${login.id}@invalid.movead`;
      await login.save({ transaction });
      await identityRepo.revokeAllSessionsFor(login.id, 'driver_deleted');
    }

    await audit.record(
      {
        action: 'driver.deleted',
        entityType: 'driver',
        entityId: driver.id,
        before: { status: driver.status, mobile: driver.mobile },
        after: { deletedAt: driver.deletedAt, reason, vehiclesRemoved: vehicles.length },
        actorUserId: actor.userId,
        ip: actor.ip,
      },
      transaction,
    );

    return driver;
  });
}

/**
 * AC-32.4. Approval is refused unless the driver's own mandatory documents are
 * verified — approving someone whose licence has not been looked at is the
 * exact mistake the review step exists to prevent.
 */
export async function approveDriver(driverId: string, actor: Actor): Promise<Driver> {
  const driver = await require_(driverId);
  const outstanding = (await driverChecklist(driverId)).filter(
    (item) => item.isMandatory && item.status !== 'verified',
  );

  if (outstanding.length > 0) {
    throw new UnprocessableError(
      'documents_outstanding',
      'Verify the driver’s documents before approving them.',
      { outstanding: outstanding.map((item) => ({ kind: item.kind, status: item.status })) },
    );
  }

  return transitionDriver(driver, 'APPROVED', null, actor, 'driver.approved');
}

/**
 * Rejection returns the driver to PENDING with the reason recorded, rather
 * than to a terminal state: AC-05.5 gives them the right to correct and
 * resubmit, so there has to be something to resubmit into.
 */
export async function rejectDriver(
  driverId: string,
  reason: string,
  actor: Actor,
): Promise<Driver> {
  const driver = await require_(driverId);
  driver.rejectionReason = reason;

  return transitionDriver(driver, 'PENDING', reason, actor, 'driver.rejected');
}

export async function suspendDriver(
  driverId: string,
  reason: string,
  actor: Actor,
): Promise<Driver> {
  const driver = await require_(driverId);
  driver.suspendedReason = reason;

  return transitionDriver(driver, 'SUSPENDED', reason, actor, 'driver.suspended');
}

export async function reinstateDriver(driverId: string, actor: Actor): Promise<Driver> {
  const driver = await require_(driverId);

  if (driver.status !== 'SUSPENDED') {
    throw new UnprocessableError('not_suspended', 'That driver is not suspended.');
  }

  driver.suspendedReason = null;
  return transitionDriver(driver, 'APPROVED', null, actor, 'driver.reinstated');
}

// ------------------------------------------------------------------ vehicles

export async function addVehicle(
  driverId: string,
  input: VehicleInput,
  actor: Actor,
): Promise<Vehicle> {
  await require_(driverId);

  return sequelize.transaction((transaction) => createVehicle(driverId, input, actor, transaction));
}

/**
 * Corrects a vehicle's details. Refused once it is past PENDING.
 *
 * A mistyped plate has to be fixable — it is four characters typed from a phone
 * call, and getting it wrong reserves the wrong vehicle. But once documents
 * have been verified they were verified *against* a plate, and quietly swapping
 * it afterwards would carry that approval over to a different vehicle. That is
 * the fraud AC-05.7 exists to prevent, so past PENDING the answer is reject and
 * re-add, which leaves a trail.
 */
export async function updateVehicle(
  vehicleId: string,
  changes: Partial<VehicleInput>,
  actor: Actor,
): Promise<Vehicle> {
  const vehicle = await repo.findVehicle(vehicleId);
  if (!vehicle) throw new NotFoundError('No such vehicle.');

  if (vehicle.status !== 'PENDING') {
    throw new UnprocessableError(
      'vehicle_not_editable',
      `A vehicle can only be corrected while PENDING; this one is ${vehicle.status}. Reject it and add the correct vehicle instead.`,
    );
  }

  const before = {
    registrationNumber: vehicle.registrationNumber,
    category: vehicle.category,
  };

  if (changes.registrationNumber !== undefined) {
    vehicle.registrationNumber = changes.registrationNumber.toUpperCase().replace(/[\s-]/g, '');
  }
  if (changes.category !== undefined) vehicle.category = changes.category;
  if (changes.bodyType !== undefined) vehicle.bodyType = changes.bodyType ?? null;
  if (changes.makeModel !== undefined) vehicle.makeModel = changes.makeModel ?? null;
  if (changes.colour !== undefined) vehicle.colour = changes.colour ?? null;
  if (changes.manufactureYear !== undefined) {
    vehicle.manufactureYear = changes.manufactureYear ?? null;
  }
  if (changes.fuelType !== undefined) vehicle.fuelType = changes.fuelType ?? null;

  // The conditional unique index turns a taken plate into a 409 here, the same
  // as it does on create.
  await vehicle.save();

  await audit.record({
    action: 'vehicle.updated',
    entityType: 'vehicle',
    entityId: vehicle.id,
    before,
    after: { registrationNumber: vehicle.registrationNumber, category: vehicle.category },
    actorUserId: actor.userId,
    ip: actor.ip,
  });

  return vehicle;
}

/**
 * The insert itself, without the driver lookup, so that it can be reused by
 * `createDriver` inside a transaction that has just created the driver and
 * would not find it committed yet.
 */
async function createVehicle(
  driverId: string,
  input: VehicleInput,
  actor: Actor,
  transaction: Transaction,
): Promise<Vehicle> {
  // Uppercase, no spaces — the plate on the vehicle and the plate in the
  // database have to be the same string for the uniqueness check to mean
  // anything (AC-05.7).
  const registrationNumber = input.registrationNumber.toUpperCase().replace(/[\s-]/g, '');

  const vehicle = await Vehicle.create(
    {
      registrationNumber,
      category: input.category,
      bodyType: input.bodyType ?? null,
      makeModel: input.makeModel ?? null,
      colour: input.colour ?? null,
      manufactureYear: input.manufactureYear ?? null,
      fuelType: input.fuelType ?? null,
      driverId,
      status: 'PENDING',
      imageKey: null,
      rejectionReason: null,
      suspendedReason: null,
    },
    { transaction },
  );

  await repo.recordVehicleTransition(
    {
      vehicleId: vehicle.id,
      fromStatus: null,
      toStatus: 'PENDING',
      reason: null,
      actorUserId: actor.userId,
    },
    transaction,
  );

  await audit.record(
    {
      action: 'vehicle.created',
      entityType: 'vehicle',
      entityId: vehicle.id,
      after: { registrationNumber, driverId },
      actorUserId: actor.userId,
      ip: actor.ip,
    },
    transaction,
  );

  return vehicle;
}

/**
 * The vehicle pipeline of AC-05.2:
 *
 *   PENDING → DOCUMENTS_VERIFIED → APPROVED
 *
 * Each step is a separate admin decision, and each is refused out of order.
 * Skipping straight to APPROVED would make "documents verified" a label rather
 * than a gate.
 */
const VEHICLE_TRANSITIONS: Partial<Record<VehicleStatus, VehicleStatus[]>> = {
  PENDING: ['DOCUMENTS_VERIFIED', 'REJECTED'],
  DOCUMENTS_VERIFIED: ['APPROVED', 'REJECTED', 'PENDING'],
  APPROVED: ['SUSPENDED', 'REJECTED', 'PENDING'],
  AVAILABLE: ['SUSPENDED', 'PENDING'],
  ASSIGNED: ['SUSPENDED'],
  INSTALLING: ['SUSPENDED'],
  ACTIVE: ['SUSPENDED'],
  SUSPENDED: ['APPROVED'],
  REJECTED: ['PENDING'],
};

export async function verifyVehicleDocuments(vehicleId: string, actor: Actor): Promise<Vehicle> {
  const vehicle = await requireVehicle(vehicleId);
  const outstanding = (await vehicleChecklist(vehicleId)).filter(
    (item) => item.isMandatory && item.status !== 'verified',
  );

  if (outstanding.length > 0) {
    throw new UnprocessableError(
      'documents_outstanding',
      'Every mandatory document must be verified first.',
      { outstanding: outstanding.map((item) => ({ kind: item.kind, status: item.status })) },
    );
  }

  return moveVehicle(vehicle, 'DOCUMENTS_VERIFIED', null, actor, 'vehicle.documents_verified');
}

export function approveVehicle(vehicleId: string, actor: Actor): Promise<Vehicle> {
  return requireVehicle(vehicleId).then((vehicle) =>
    moveVehicle(vehicle, 'APPROVED', null, actor, 'vehicle.approved'),
  );
}

export async function rejectVehicle(
  vehicleId: string,
  reason: string,
  actor: Actor,
): Promise<Vehicle> {
  const vehicle = await requireVehicle(vehicleId);
  vehicle.rejectionReason = reason;

  return moveVehicle(vehicle, 'REJECTED', reason, actor, 'vehicle.rejected');
}

/**
 * AC-05.8. Suspension stops the vehicle earning; stopping any live tracking
 * session belongs to the tracking module and hangs off this transition once
 * that module exists.
 */
export async function suspendVehicle(
  vehicleId: string,
  reason: string,
  actor: Actor,
): Promise<Vehicle> {
  const vehicle = await requireVehicle(vehicleId);
  vehicle.suspendedReason = reason;

  return moveVehicle(vehicle, 'SUSPENDED', reason, actor, 'vehicle.suspended');
}

export async function reinstateVehicle(vehicleId: string, actor: Actor): Promise<Vehicle> {
  const vehicle = await requireVehicle(vehicleId);
  vehicle.suspendedReason = null;

  return moveVehicle(vehicle, 'APPROVED', null, actor, 'vehicle.reinstated');
}

// ----------------------------------------------------------------- documents

/**
 * Registers an uploaded document. A current document of the same kind is
 * superseded rather than replaced, so a rejected copy survives for the appeal
 * and the audit trail keeps both.
 *
 * The bytes themselves are uploaded straight to object storage; this records
 * only the key. Media never passes through Express (architecture Part 12.3).
 */
export async function registerDocument(
  input: {
    kind: DocumentKind;
    driverId?: string;
    vehicleId?: string;
    storageKey: string;
    contentType: string;
    byteSize: number;
    documentNumber?: string;
    issuedOn?: string;
    expiresOn?: string;
  },
  actor: Actor,
): Promise<DocumentRecord> {
  const owner = input.driverId ? { driverId: input.driverId } : { vehicleId: input.vehicleId };

  if (input.driverId) await require_(input.driverId);
  else if (input.vehicleId) await requireVehicle(input.vehicleId);
  else throw new UnprocessableError('owner_required', 'A document belongs to a driver or vehicle.');

  const created = await sequelize.transaction(async (transaction) => {
    const previous = await repo.findCurrentDocument(owner, input.kind, transaction);

    /**
     * The predecessor steps aside before the replacement is inserted. Only one
     * document per owner and kind may be current, and the partial unique index
     * enforcing that is checked per statement — so creating the new row first
     * would collide with the old one even inside a transaction. The back
     * pointer is filled in afterwards, once there is an id to point at.
     */
    if (previous) {
      previous.supersededAt = new Date();
      await previous.save({ transaction });
    }

    const created = await DocumentRecord.create(
      {
        kind: input.kind,
        driverId: input.driverId ?? null,
        vehicleId: input.vehicleId ?? null,
        storageKey: input.storageKey,
        contentType: input.contentType,
        byteSize: input.byteSize,
        status: 'UPLOADED',
        documentNumber: input.documentNumber ?? null,
        issuedOn: input.issuedOn ?? null,
        expiresOn: input.expiresOn ?? null,
        reviewedAt: null,
        reviewedBy: null,
        rejectionReason: null,
        supersededAt: null,
        supersededBy: null,
      },
      { transaction },
    );

    if (previous) {
      previous.supersededBy = created.id;
      await previous.save({ transaction });
    }

    await audit.record(
      {
        action: 'document.uploaded',
        entityType: 'document',
        entityId: created.id,
        after: { kind: created.kind, supersedes: previous?.id ?? null },
        actorUserId: actor.userId,
        ip: actor.ip,
      },
      transaction,
    );

    return created;
  });

  /*
   * AC-04.2. The driver moves out of PENDING once the whole mandatory set is
   * in, not on the first upload — otherwise the review queue fills with drivers
   * who have supplied a licence and nothing else, and "Documents submitted"
   * stops meaning anything to the operator reading it.
   *
   * A vehicle document counts towards its driver's set, so the owning driver is
   * resolved through the vehicle when the upload was filed against one.
   */
  await refreshSubmissionState(await owningDriverId(input));

  return created;
}

async function owningDriverId(input: {
  driverId?: string;
  vehicleId?: string;
}): Promise<string | null> {
  if (input.driverId) return input.driverId;
  if (!input.vehicleId) return null;

  const vehicle = await Vehicle.findByPk(input.vehicleId);
  return vehicle?.driverId ?? null;
}

export async function verifyDocument(documentId: string, actor: Actor): Promise<DocumentRecord> {
  const document = await requireDocument(documentId);

  if (document.supersededAt) {
    throw new UnprocessableError('superseded', 'That document has been replaced by a newer one.');
  }

  // AC-05.6: an expired document cannot be verified. Waving one through today
  // would make the vehicle billable on a certificate that has already lapsed.
  if (document.expiresOn && document.expiresOn < today()) {
    throw new UnprocessableError('expired', 'That document has expired. Ask for a current one.');
  }

  document.status = 'VERIFIED';
  document.reviewedAt = new Date();
  document.reviewedBy = actor.userId;
  document.rejectionReason = null;
  await document.save();

  await audit.record({
    action: 'document.verified',
    entityType: 'document',
    entityId: document.id,
    after: { kind: document.kind },
    actorUserId: actor.userId,
    ip: actor.ip,
  });

  return document;
}

export async function rejectDocument(
  documentId: string,
  reason: string,
  actor: Actor,
): Promise<DocumentRecord> {
  const document = await requireDocument(documentId);

  document.status = 'REJECTED';
  document.reviewedAt = new Date();
  document.reviewedBy = actor.userId;
  document.rejectionReason = reason;
  await document.save();

  await audit.record({
    action: 'document.rejected',
    entityType: 'document',
    entityId: document.id,
    after: { kind: document.kind, reason },
    actorUserId: actor.userId,
    ip: actor.ip,
  });

  return document;
}

/**
 * The review screen's checklist.
 *
 * `missing` and `expiring` are computed rather than stored: `missing` is the
 * absence of a row for a required kind, and `expiring` is a date thirty days
 * out. Storing either would mean a nightly job racing the screen to tell the
 * truth (database design Part 5.4).
 */
export type ChecklistStatus =
  'missing' | 'uploaded' | 'verified' | 'rejected' | 'expiring' | 'expired';

export interface ChecklistItem {
  kind: DocumentKind;
  isMandatory: boolean;
  status: ChecklistStatus;
  documentId: string | null;
  expiresOn: string | null;
  rejectionReason: string | null;
  /**
   * Enough for the review screen to render the file without a second request:
   * whether to draw an image or a PDF frame, and how recently it arrived.
   */
  contentType: string | null;
  uploadedAt: string | null;
}

export function driverChecklist(driverId: string): Promise<ChecklistItem[]> {
  return checklist('DRIVER', { driverId });
}

export function vehicleChecklist(vehicleId: string): Promise<ChecklistItem[]> {
  return checklist('VEHICLE', { vehicleId });
}

async function checklist(
  owner: 'DRIVER' | 'VEHICLE',
  scope: { driverId?: string; vehicleId?: string },
): Promise<ChecklistItem[]> {
  const [required, held] = await Promise.all([
    repo.requiredDocuments(owner),
    repo.currentDocuments(scope),
  ]);

  return required.map((requirement) => {
    const document = held.find((item) => item.kind === requirement.kind);

    return {
      kind: requirement.kind,
      isMandatory: requirement.isMandatory,
      status: statusOf(document),
      documentId: document?.id ?? null,
      expiresOn: document?.expiresOn ?? null,
      rejectionReason: document?.rejectionReason ?? null,
      contentType: document?.contentType ?? null,
      uploadedAt: document?.uploadedAt?.toISOString() ?? null,
    };
  });
}

const EXPIRY_WARNING_DAYS = 30;

function statusOf(document: DocumentRecord | undefined): ChecklistStatus {
  if (!document) return 'missing';
  if (document.status === 'REJECTED') return 'rejected';
  if (document.status === 'UPLOADED') return 'uploaded';

  if (document.expiresOn) {
    if (document.expiresOn < today()) return 'expired';
    if (document.expiresOn < addDays(EXPIRY_WARNING_DAYS)) return 'expiring';
  }

  return document.status === 'VERIFIED' ? 'verified' : 'uploaded';
}

// ------------------------------------------ the driver's own documents (AC-04)

/**
 * What the driver is asked for, from their side of the glass.
 *
 * The admin checklist splits by owner because the review screen reviews a
 * driver and a vehicle separately. The driver has one wallet: their licence and
 * their vehicle's papers are all documents *they* photograph, and asking them
 * to understand which table a row hangs off would be an implementation detail
 * leaking into an onboarding flow. So this returns one list, and `owner` is
 * carried only so the upload path knows where to file it.
 */
export interface DriverDocumentItem {
  kind: DocumentKind;
  owner: 'DRIVER' | 'VEHICLE';
  isMandatory: boolean;
  /** Whether this kind lapses, and therefore whether an expiry date is required. */
  expires: boolean;
  status: ChecklistStatus;
  documentId: string | null;
  expiresOn: string | null;
  rejectionReason: string | null;
  uploadedAt: string | null;
}

export async function driverDocuments(driverId: string): Promise<DriverDocumentItem[]> {
  await require_(driverId);
  const vehicle = (await repo.vehiclesFor(driverId))[0] ?? null;

  const own = await ownerDocuments('DRIVER', { driverId });

  // A driver with no vehicle on file is asked only for their own papers. The
  // alternative — listing four documents they cannot possibly supply — would
  // read as a permanent block.
  const vehicles = vehicle ? await ownerDocuments('VEHICLE', { vehicleId: vehicle.id }) : [];

  return [...own, ...vehicles];
}

async function ownerDocuments(
  owner: 'DRIVER' | 'VEHICLE',
  scope: { driverId?: string; vehicleId?: string },
): Promise<DriverDocumentItem[]> {
  const [required, held] = await Promise.all([
    repo.requiredDocuments(owner),
    repo.currentDocuments(scope),
  ]);

  return required.map((requirement) => {
    const document = held.find((item) => item.kind === requirement.kind);

    return {
      kind: requirement.kind,
      owner,
      isMandatory: requirement.isMandatory,
      expires: requirement.expires,
      status: statusOf(document),
      documentId: document?.id ?? null,
      expiresOn: document?.expiresOn ?? null,
      rejectionReason: document?.rejectionReason ?? null,
      uploadedAt: document?.uploadedAt?.toISOString() ?? null,
    };
  });
}

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/**
 * Whitelisted by declared content type, as the creative and photo paths are.
 * A phone camera produces JPEG; a scanned licence or an insurance certificate
 * mailed by the insurer is usually a PDF, and refusing those would send the
 * driver to a converter app.
 */
const ACCEPTED_DOCUMENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
} as const;

export interface DriverDocumentUpload {
  driverId: string;
  kind: DocumentKind;
  contentType: string;
  bytes: Buffer;
  documentNumber?: string;
  expiresOn?: string;
}

/**
 * AC-04.1 — the driver supplies their own paperwork from their own handset.
 *
 * Bytes land in the same object store the creatives use, keyed by the driver so
 * one cannot read another's. The row is then written through `registerDocument`
 * so that supersession, the audit entry and the status transition behave
 * identically whether the upload came from the driver or from operations.
 */
export async function uploadDriverDocument(
  input: DriverDocumentUpload,
  actor: Actor,
): Promise<DriverDocumentItem> {
  const extension =
    ACCEPTED_DOCUMENT_TYPES[input.contentType as keyof typeof ACCEPTED_DOCUMENT_TYPES];

  if (!extension) {
    throw new UnprocessableError(
      'unsupported_type',
      'Upload a photo (JPEG, PNG or WebP) or a PDF.',
    );
  }
  if (input.bytes.length === 0) throw new UnprocessableError('empty_file', 'That file is empty.');
  if (input.bytes.length > MAX_DOCUMENT_BYTES) {
    throw new UnprocessableError('file_too_large', 'Each document must be 10 MB or smaller.');
  }

  const requirement = await requirementFor(input.kind);
  const owner = await ownerScopeFor(input.driverId, requirement.owner);

  /*
   * AC-05.6 blocks verification of a lapsed document, which would leave the
   * driver waiting on a review that can only ever be refused. Cheaper to refuse
   * the upload and say why, while they are still holding the paper.
   */
  if (requirement.expires) {
    if (!input.expiresOn) {
      throw new UnprocessableError(
        'expiry_required',
        'Enter the expiry date printed on this document.',
      );
    }
    if (input.expiresOn < today()) {
      throw new UnprocessableError(
        'already_expired',
        'That document has already expired. Upload a current one.',
      );
    }
  }

  const key = `${input.driverId}/${randomUUID()}.${extension}`;
  await objectStore().put(key, input.bytes, input.contentType);

  await registerDocument(
    {
      kind: input.kind,
      ...owner,
      storageKey: key,
      contentType: input.contentType,
      byteSize: input.bytes.length,
      ...(input.documentNumber ? { documentNumber: input.documentNumber } : {}),
      // A kind that does not lapse keeps a null expiry even if one is sent.
      ...(requirement.expires && input.expiresOn ? { expiresOn: input.expiresOn } : {}),
    },
    actor,
  );

  const refreshed = await driverDocuments(input.driverId);
  const item = refreshed.find((row) => row.kind === input.kind);
  if (!item) throw new NotFoundError('Document');
  return item;
}

/**
 * The bytes, for an operator reviewing them.
 *
 * Unscoped on purpose, unlike the driver's own read below: verifying a licence
 * means looking at it, and an operator holding `document.read` is trusted with
 * any of them. Who looked is answerable through the audit trail rather than
 * through a narrower query.
 */
export async function readDocument(
  documentId: string,
): Promise<{ bytes: Buffer; contentType: string; kind: DocumentKind }> {
  const document = await requireDocument(documentId);

  const stored = await objectStore().get(document.storageKey);
  /*
   * A row whose bytes are gone is not the same as a row that never existed —
   * it means storage and the database have diverged, which is worth saying
   * rather than reporting as a plain missing document.
   */
  if (!stored) {
    throw new NotFoundError('Document file');
  }

  return { bytes: stored.bytes, contentType: stored.contentType, kind: document.kind };
}

/** The bytes the driver sent, back to the driver who sent them. */
export async function readDriverDocument(
  driverId: string,
  documentId: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  const document = await requireDocument(documentId);
  const vehicleIds = (await repo.vehiclesFor(driverId)).map((vehicle) => vehicle.id);

  const owned =
    document.driverId === driverId ||
    (document.vehicleId !== null && vehicleIds.includes(document.vehicleId));

  // Not a 403: whether a document id exists is itself not this driver's
  // business, and a 404 answers both cases the same way.
  if (!owned) throw new NotFoundError('Document');

  const stored = await objectStore().get(document.storageKey);
  if (!stored) throw new NotFoundError('Document');

  return { bytes: stored.bytes, contentType: stored.contentType };
}

async function requirementFor(
  kind: DocumentKind,
): Promise<{ owner: 'DRIVER' | 'VEHICLE'; expires: boolean }> {
  for (const owner of ['DRIVER', 'VEHICLE'] as const) {
    const match = (await repo.requiredDocuments(owner)).find((row) => row.kind === kind);
    if (match) return { owner, expires: match.expires };
  }

  // `OTHER` lives in the enum but not in `required_documents`, so there is no
  // requirement to file it against and nothing asked the driver for it.
  throw new UnprocessableError('unknown_kind', 'That is not a document we ask drivers for.');
}

async function ownerScopeFor(
  driverId: string,
  owner: 'DRIVER' | 'VEHICLE',
): Promise<{ driverId: string } | { vehicleId: string }> {
  if (owner === 'DRIVER') return { driverId };

  const vehicle = (await repo.vehiclesFor(driverId))[0];
  if (!vehicle) {
    throw new UnprocessableError(
      'no_vehicle',
      'Your vehicle is not on file yet. Contact operations before uploading vehicle papers.',
    );
  }

  return { vehicleId: vehicle.id };
}

/**
 * AC-04.2 — `Documents submitted` should mean submitted, all of them.
 *
 * This runs after the insert has committed rather than inside it: completeness
 * spans the driver's own papers and their vehicle's, and the checklist reads
 * that decide it cannot see an uncommitted row.
 */
async function refreshSubmissionState(driverId: string | null): Promise<void> {
  if (!driverId) return;

  const driver = await Driver.findByPk(driverId);
  if (!driver || driver.status !== 'PENDING') return;

  const outstanding = (await driverDocuments(driverId)).filter(
    (item) => item.isMandatory && (item.status === 'missing' || item.status === 'rejected'),
  );
  if (outstanding.length > 0) return;

  driver.status = 'DOCUMENTS_SUBMITTED';
  driver.rejectionReason = null;
  await driver.save();
}

// --------------------------------------------------------------------- reads

export interface DriverDetail {
  driver: Driver;
  vehicles: Vehicle[];
  driverDocuments: ChecklistItem[];
  vehicleDocuments: Record<string, ChecklistItem[]>;
}

export async function driverDetail(driverId: string): Promise<DriverDetail> {
  const driver = await require_(driverId);
  const vehicles = await repo.vehiclesFor(driverId);

  const vehicleDocuments: Record<string, ChecklistItem[]> = {};
  for (const vehicle of vehicles) {
    vehicleDocuments[vehicle.id] = await vehicleChecklist(vehicle.id);
  }

  return {
    driver,
    vehicles,
    driverDocuments: await driverChecklist(driverId),
    vehicleDocuments,
  };
}

/**
 * A driver as the onboarding queue shows them: their own row plus the vehicle,
 * because the queue lists a plate against every driver and a second request per
 * row to find it would be a strange thing to make the screen do.
 */
export interface DriverListItem {
  driver: Driver;
  vehicle: Vehicle | null;
}

export async function listDrivers(query: repo.DriverListQuery): Promise<DriverListItem[]> {
  const drivers = await repo.listDrivers(query);
  const vehicles = await repo.firstVehiclesFor(drivers.map((driver) => driver.id));

  return drivers.map((driver) => ({ driver, vehicle: vehicles.get(driver.id) ?? null }));
}

export function vehicleHistory(vehicleId: string) {
  return repo.vehicleHistory(vehicleId);
}

// ------------------------------------------------------------------- helpers

async function transitionDriver(
  driver: Driver,
  to: DriverStatus,
  reason: string | null,
  actor: Actor,
  action: string,
): Promise<Driver> {
  const from = driver.status;
  driver.status = to;
  if (to !== 'PENDING') driver.rejectionReason = null;
  await driver.save();

  await audit.record({
    action,
    entityType: 'driver',
    entityId: driver.id,
    before: { status: from },
    after: { status: to, reason },
    actorUserId: actor.userId,
    ip: actor.ip,
  });

  return driver;
}

async function moveVehicle(
  vehicle: Vehicle,
  to: VehicleStatus,
  reason: string | null,
  actor: Actor,
  action: string,
): Promise<Vehicle> {
  const from = vehicle.status;

  if (!(VEHICLE_TRANSITIONS[from] ?? []).includes(to)) {
    throw new UnprocessableError(
      'invalid_transition',
      `A vehicle cannot go from ${from} to ${to}.`,
      { from, to, allowed: VEHICLE_TRANSITIONS[from] ?? [] },
    );
  }

  return sequelize.transaction(async (transaction) => {
    vehicle.status = to;
    if (to !== 'REJECTED') vehicle.rejectionReason = null;
    await vehicle.save({ transaction });

    await repo.recordVehicleTransition(
      {
        vehicleId: vehicle.id,
        fromStatus: from,
        toStatus: to,
        reason,
        actorUserId: actor.userId,
      },
      transaction,
    );

    await audit.record(
      {
        action,
        entityType: 'vehicle',
        entityId: vehicle.id,
        before: { status: from },
        after: { status: to, reason },
        actorUserId: actor.userId,
        ip: actor.ip,
      },
      transaction,
    );

    return vehicle;
  });
}

/** Named with a trailing underscore because `require` is taken in CommonJS. */
async function require_(driverId: string): Promise<Driver> {
  const driver = await repo.findDriver(driverId);
  if (!driver) throw new NotFoundError('Driver');
  return driver;
}

async function requireVehicle(vehicleId: string): Promise<Vehicle> {
  const vehicle = await repo.findVehicle(vehicleId);
  if (!vehicle) throw new NotFoundError('Vehicle');
  return vehicle;
}

async function requireDocument(documentId: string): Promise<DocumentRecord> {
  const document = await repo.findDocument(documentId);
  if (!document) throw new NotFoundError('Document');
  return document;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export type { DocumentStatus, DriverStatus, VehicleStatus };

export interface DriverLocationView {
  city: string;
  label: string;
  lat: number;
  lng: number;
}

export interface DriverView {
  id: string;
  mobile: string;
  name: string;
  photoKey: string | null;
  status: DriverStatus;
  suspendedReason: string | null;
  rejectionReason: string | null;
  joinedAt: string;
  city: string;
  location: DriverLocationView | null;
}

export function viewDriver(driver: Driver): DriverView {
  return {
    id: driver.id,
    mobile: driver.mobile,
    name: driver.name,
    photoKey: driver.photoKey,
    status: driver.status,
    suspendedReason: driver.suspendedReason,
    rejectionReason: driver.rejectionReason,
    joinedAt: driver.joinedAt.toISOString(),
    city: driver.city,
    location: locationView(driver),
  };
}

export function locationView(driver: Driver): DriverLocationView | null {
  if (driver.baseLat == null || driver.baseLng == null) return null;
  return {
    city: driver.city,
    label: driver.baseLabel ?? driver.city,
    lat: Number(driver.baseLat),
    lng: Number(driver.baseLng),
  };
}

/**
 * What a buyer can do with this vehicle right now.
 *
 * Derived here rather than in each screen: `booked` and `pending` are both
 * "not selectable" but for opposite reasons — one is working and one has never
 * been approved — and two clients deriving that separately eventually disagree
 * about which. The raw `status` is still returned for anyone who needs the
 * operational detail.
 */
export type VehicleAvailability = 'available' | 'booked' | 'pending';

const READY_VEHICLE: VehicleStatus[] = ['APPROVED', 'AVAILABLE'];
const WORKING_VEHICLE: VehicleStatus[] = ['ASSIGNED', 'INSTALLING', 'ACTIVE'];

/**
 * `booked` comes from the **assignment**, not from the vehicle row.
 *
 * `vehicles.status` has `ASSIGNED`, `INSTALLING` and `ACTIVE` in its enum and
 * nothing ever writes them — assignment creates a `campaign_vehicles` row and
 * leaves the vehicle `APPROVED`. Reading availability from the status alone
 * therefore called every assigned vehicle "Available", and the advertiser only
 * discovered otherwise when operations refused the assignment. The status
 * values are still honoured in case something starts setting them, but the
 * live assignment is what decides.
 */
function availabilityOf(status: VehicleStatus, assigned: boolean): VehicleAvailability {
  if (assigned || WORKING_VEHICLE.includes(status)) return 'booked';
  return READY_VEHICLE.includes(status) ? 'available' : 'pending';
}

export interface VehicleInZone {
  id: string;
  vehicleType: VehicleCategory;
  publicRef: string;
  registrationNumber: string;
  areaLabel: string;
  /** The onboard pin, so the picker can plot the vehicle beside its zone. */
  lat: number;
  lng: number;
  zone: 'prime' | 'secondary';
  status: VehicleStatus;
  availability: VehicleAvailability;
  /** When a `booked` vehicle comes free: the end date of the campaign on it. */
  bookedUntil?: string;
  /** Admin only. A name is personal information; a plate is not (ADV-039). */
  driverName?: string;
}

/**
 * Vehicles whose onboard pin sits inside the draft Prime or Secondary outline.
 *
 * **The plate is shown to advertisers; the driver's name is not.** `ADV-039`
 * withholds driver *personal information*, and the line now sits between the
 * vehicle and the person driving it: a buyer is entitled to know which vehicle
 * they are ordering, and an anonymous `VH-` reference was read as a placeholder
 * for missing data rather than as an identifier. Who is behind the wheel
 * remains an operations matter, so `driverName` is still admin-only.
 *
 * Both audiences see vehicles that are booked or still pending review, marked
 * as such: hiding them would tell an advertiser the area is empty when it is
 * merely busy, which is a different decision.
 */
export async function vehiclesInZones(input: {
  vehicleType: VehicleCategory;
  zonePolygons: ZonePolygons;
  revealIdentity: boolean;
}): Promise<{
  items: VehicleInZone[];
  primeCount: number;
  secondaryCount: number;
  availableCount: number;
}> {
  const rows = await repo.vehiclesWithBaseLocation(input.vehicleType);
  const inZone: { vehicle: (typeof rows)[number]; zone: 'prime' | 'secondary' }[] = [];

  for (const vehicle of rows) {
    const driver = vehicle.driver;
    if (!driver?.baseLat || !driver.baseLng) continue;

    const zone = zoneForPoint(
      { lat: Number(driver.baseLat), lng: Number(driver.baseLng) },
      input.zonePolygons,
    );
    if (!zone) continue;
    inZone.push({ vehicle, zone });
  }

  // One query for the whole list, and the thing that decides `booked`.
  const freeFrom = await repo.bookedUntilFor(inZone.map(({ vehicle }) => vehicle.id));

  const items: VehicleInZone[] = inZone.map(({ vehicle, zone }) => {
    const driver = vehicle.driver!;
    const bookedUntil = freeFrom.get(vehicle.id);

    return {
      id: vehicle.id,
      vehicleType: vehicle.category,
      publicRef: publicVehicleRef(vehicle.id),
      registrationNumber: vehicle.registrationNumber,
      areaLabel: driver.baseLabel ?? driver.city,
      lat: Number(driver.baseLat),
      lng: Number(driver.baseLng),
      zone,
      status: vehicle.status,
      availability: availabilityOf(vehicle.status, Boolean(bookedUntil)),
      ...(bookedUntil ? { bookedUntil } : {}),
      ...(input.revealIdentity ? { driverName: driver.name } : {}),
    };
  });

  return {
    items,
    primeCount: items.filter((row) => row.zone === 'prime').length,
    secondaryCount: items.filter((row) => row.zone === 'secondary').length,
    availableCount: items.filter((row) => row.availability === 'available').length,
  };
}

export interface AvailableFleetVehicle {
  id: string;
  vehicleType: VehicleCategory;
  publicRef: string;
  registrationNumber: string;
  areaLabel: string;
  city: string;
  lat: number;
  lng: number;
  status: VehicleStatus;
  availability: VehicleAvailability;
  /** When a `booked` vehicle comes free: the end date of the campaign on it. */
  bookedUntil?: string;
}

/**
 * Every onboarded vehicle with an operating pin. Advertisers browse this to
 * see where they can place ads. Named by its plate, as in `vehiclesInZones`;
 * the driver behind it is not named to anyone but an operator (ADV-039).
 */
export async function listAvailableFleet(input: {
  vehicleType?: VehicleCategory;
}): Promise<{ items: AvailableFleetVehicle[]; cabCount: number; autoCount: number }> {
  const rows = (await repo.vehiclesWithBaseLocation(input.vehicleType)).filter(
    (vehicle) => vehicle.driver?.baseLat && vehicle.driver.baseLng,
  );

  const freeFrom = await repo.bookedUntilFor(rows.map((row) => row.id));

  const items: AvailableFleetVehicle[] = rows.map((vehicle) => {
    const driver = vehicle.driver!;
    const bookedUntil = freeFrom.get(vehicle.id);

    return {
      id: vehicle.id,
      vehicleType: vehicle.category,
      publicRef: publicVehicleRef(vehicle.id),
      registrationNumber: vehicle.registrationNumber,
      areaLabel: driver.baseLabel ?? driver.city,
      city: driver.city,
      lat: Number(driver.baseLat),
      lng: Number(driver.baseLng),
      status: vehicle.status,
      availability: availabilityOf(vehicle.status, Boolean(bookedUntil)),
      ...(bookedUntil ? { bookedUntil } : {}),
    };
  });

  return {
    items,
    cabCount: items.filter((row) => row.vehicleType === 'CAB').length,
    autoCount: items.filter((row) => row.vehicleType === 'AUTO').length,
  };
}

function locationColumns(location?: DriverLocationInput) {
  if (!location) {
    return {
      city: 'Bengaluru',
      baseLat: null,
      baseLng: null,
      baseLabel: null,
    };
  }

  return {
    city: location.city?.trim() || 'Bengaluru',
    baseLat: location.lat.toFixed(7),
    baseLng: location.lng.toFixed(7),
    baseLabel: location.label.trim(),
  };
}

/**
 * A stable, opaque reference for one vehicle.
 *
 * This was the *only* thing an advertiser was told about a vehicle until
 * AC-22.4 put the plate on their side of the line. It stays in the payload for
 * logs and support conversations, where an id that survives a re-registration
 * is worth having, but it is no longer what a screen names a vehicle by.
 */
export function publicVehicleRef(id: string): string {
  return `VH-${id.replace(/-/g, '').slice(0, 4).toUpperCase()}`;
}

export interface DriverPortalProfile {
  id: string;
  name: string;
  mobile: string;
  /**
   * Lowercase, unlike the admin-facing `DriverStatus`. Every driver-facing
   * enum on this API is lowercase — `/v1/driver/campaign` set that — and both
   * clients already declare it that way. Leaking the database's casing here
   * would make those declarations quietly wrong.
   */
  status: 'pending' | 'documents_submitted' | 'approved' | 'suspended';
  /**
   * Why they are suspended or were rejected, verbatim, or null when the status
   * needs no explaining. A driver locked out of the app without being told the
   * reason has nothing to act on, which is the same principle as AC-05.5.
   */
  statusReason: string | null;
  canTrack: boolean;
  /**
   * A path, not an absolute URL, and null until the driver sends one. The
   * clients resolve it against their own base and attach the bearer token,
   * exactly as they do for the campaign creative.
   */
  photoUrl: string | null;
  joinedAt: string;
  vehicle: { registrationNumber: string; category: VehicleCategory; makeModel: string } | null;
  /**
   * The sign-in username. Read-only here on purpose (UI-013.5): a driver who
   * could change it could move their own account to a mailbox nobody audited.
   * Null only for the legacy rows that predate driver logins.
   */
  email: string | null;
  address: DriverAddress | null;
  /**
   * Masked (AC-04.6). The full account number is never in this payload — the
   * driver asks for it explicitly, and that request is a separate route.
   */
  payout: MaskedPayout | null;
  consent: { locationTracking: ConsentState };
}

export interface DriverAddress {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
}

export type MaskedPayout =
  | { method: 'BANK'; accountName: string; accountNumberMasked: string; ifsc: string }
  | { method: 'UPI'; upiIdMasked: string };

export interface ConsentState {
  granted: boolean;
  /** When the current state began. Null when they have never been asked. */
  recordedAt: string | null;
  policyVersion: string | null;
}

const PORTAL_STATUS: Record<DriverStatus, DriverPortalProfile['status']> = {
  PENDING: 'pending',
  DOCUMENTS_SUBMITTED: 'documents_submitted',
  APPROVED: 'approved',
  SUSPENDED: 'suspended',
};

export async function portalProfile(driverId: string): Promise<DriverPortalProfile> {
  const { driver, vehicles } = await driverDetail(driverId);
  const vehicle = vehicles[0] ?? null;
  const vehicleReady = Boolean(vehicle && READY_VEHICLE.includes(vehicle.status));
  const login = await User.findOne({ where: { driverId: driver.id } });

  return {
    id: driver.id,
    name: driver.name,
    mobile: driver.mobile,
    status: PORTAL_STATUS[driver.status],
    statusReason: driver.suspendedReason ?? driver.rejectionReason ?? null,
    canTrack: driver.status === 'APPROVED' && vehicleReady,
    photoUrl: driver.photoKey ? '/v1/driver/me/photo' : null,
    joinedAt: driver.joinedAt.toISOString(),
    vehicle: vehicle
      ? {
          registrationNumber: vehicle.registrationNumber,
          category: vehicle.category,
          makeModel: vehicle.makeModel ?? vehicle.category,
        }
      : null,
    email: login?.email ?? null,
    address: addressOf(driver),
    payout: maskPayout(driver),
    consent: { locationTracking: await consentState(driverId) },
  };
}

function addressOf(driver: Driver): DriverAddress | null {
  // The four mandatory parts arrive together or not at all, so line 1 standing
  // in for "an address exists" cannot go stale against the others.
  if (!driver.addressLine1 || !driver.addressCity || !driver.addressState) return null;

  return {
    line1: driver.addressLine1,
    line2: driver.addressLine2 ?? null,
    city: driver.addressCity,
    state: driver.addressState,
    pincode: driver.addressPincode ?? '',
  };
}

/**
 * AC-04.6 — masked after entry. The last four digits are kept because they are
 * how a driver recognises which of their accounts this is; everything before
 * them is what makes the number worth stealing.
 */
function maskPayout(driver: Driver): MaskedPayout | null {
  if (driver.payoutMethod === 'BANK' && driver.bankAccountNumber && driver.bankIfsc) {
    return {
      method: 'BANK',
      accountName: driver.bankAccountName ?? '',
      accountNumberMasked: maskTail(driver.bankAccountNumber),
      ifsc: driver.bankIfsc,
    };
  }

  if (driver.payoutMethod === 'UPI' && driver.upiId) {
    return { method: 'UPI', upiIdMasked: maskUpi(driver.upiId) };
  }

  return null;
}

function maskTail(value: string): string {
  return value.length <= 4 ? value : `${'\u2022'.repeat(value.length - 4)}${value.slice(-4)}`;
}

/** `ma••••••@okhdfcbank` — the handle is hidden, the bank is not. */
function maskUpi(upi: string): string {
  const [handle = '', bank = ''] = upi.split('@');
  const shown = handle.slice(0, 2);
  return `${shown}${'\u2022'.repeat(Math.max(handle.length - 2, 2))}@${bank}`;
}

async function consentState(driverId: string): Promise<ConsentState> {
  const latest = await DriverConsent.findOne({
    where: { driverId, kind: 'LOCATION_TRACKING' },
    order: [['recordedAt', 'DESC']],
  });

  if (!latest) return { granted: false, recordedAt: null, policyVersion: null };

  return {
    granted: latest.action === 'GRANTED',
    recordedAt: latest.recordedAt.toISOString(),
    policyVersion: latest.policyVersion,
  };
}

export interface PortalProfileUpdate {
  name?: string | undefined;
  address?: DriverAddressInput | null | undefined;
  payout?: PayoutInput | null | undefined;
}

export interface DriverAddressInput {
  line1: string;
  line2?: string | null | undefined;
  city: string;
  state: string;
  pincode: string;
}

export type PayoutInput =
  | { method: 'BANK'; accountName: string; accountNumber: string; ifsc: string }
  | { method: 'UPI'; upiId: string };

/**
 * The driver editing their own record — the first write on this API they are
 * allowed to make about themselves.
 *
 * Deliberately narrow. Mobile and email are absent because UI-013.5 makes them
 * admin-only, and status, approval and the operating pin are absent because a
 * driver moving their own pin chooses which zone rate they earn.
 */
export async function updatePortalProfile(
  driverId: string,
  input: PortalProfileUpdate,
  actor: Actor,
): Promise<DriverPortalProfile> {
  const driver = await require_(driverId);
  const before = { name: driver.name, address: addressOf(driver), payout: maskPayout(driver) };

  if (input.name !== undefined) driver.name = input.name;
  if (input.address !== undefined) applyAddress(driver, input.address);
  if (input.payout !== undefined) applyPayout(driver, input.payout);

  await driver.save();

  await audit.record({
    action: 'driver.profile_updated',
    entityType: 'driver',
    entityId: driver.id,
    before,
    // The masked view, never the account number: an audit row is read by more
    // people than the payout run is, and it is kept for longer.
    after: { name: driver.name, address: addressOf(driver), payout: maskPayout(driver) },
    actorUserId: actor.userId,
    ip: actor.ip,
  });

  return portalProfile(driverId);
}

function applyAddress(driver: Driver, address: DriverAddressInput | null): void {
  driver.addressLine1 = address?.line1 ?? null;
  driver.addressLine2 = address?.line2 ?? null;
  driver.addressCity = address?.city ?? null;
  driver.addressState = address?.state ?? null;
  driver.addressPincode = address?.pincode ?? null;
}

function applyPayout(driver: Driver, payout: PayoutInput | null): void {
  // Cleared wholesale before each write, so switching from a bank account to a
  // UPI id cannot leave the old account behind for a payout run to find.
  driver.payoutMethod = payout?.method ?? null;
  driver.bankAccountName = null;
  driver.bankAccountNumber = null;
  driver.bankIfsc = null;
  driver.upiId = null;

  if (payout?.method === 'BANK') {
    driver.bankAccountName = payout.accountName;
    driver.bankAccountNumber = payout.accountNumber;
    driver.bankIfsc = payout.ifsc.toUpperCase();
  }
  if (payout?.method === 'UPI') driver.upiId = payout.upiId;
}

/**
 * AC-04.6's "revealed only on an explicit action", enforced as a separate
 * request rather than as a client-side toggle over data already sent. A
 * masked field the payload carries in full is not masked, it is obscured.
 */
export async function revealPayout(driverId: string, actor: Actor): Promise<PayoutInput | null> {
  const driver = await require_(driverId);

  await audit.record({
    action: 'driver.payout_revealed',
    entityType: 'driver',
    entityId: driver.id,
    after: { method: driver.payoutMethod },
    actorUserId: actor.userId,
    ip: actor.ip,
  });

  if (driver.payoutMethod === 'BANK' && driver.bankAccountNumber && driver.bankIfsc) {
    return {
      method: 'BANK',
      accountName: driver.bankAccountName ?? '',
      accountNumber: driver.bankAccountNumber,
      ifsc: driver.bankIfsc,
    };
  }
  if (driver.payoutMethod === 'UPI' && driver.upiId) {
    return { method: 'UPI', upiId: driver.upiId };
  }

  return null;
}

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** No PDF here, unlike documents: this one is rendered as an avatar. */
const ACCEPTED_PHOTO_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

/** UI-013.6 — camera or gallery, from the driver's own phone. */
export async function uploadPortalPhoto(
  driverId: string,
  file: { contentType: string; bytes: Buffer },
  actor: Actor,
): Promise<DriverPortalProfile> {
  const extension = ACCEPTED_PHOTO_TYPES[file.contentType as keyof typeof ACCEPTED_PHOTO_TYPES];
  if (!extension) {
    throw new UnprocessableError('unsupported_type', 'Send a JPEG, PNG or WebP photo.');
  }
  if (file.bytes.length === 0) throw new UnprocessableError('empty_file', 'That file is empty.');
  if (file.bytes.length > MAX_PHOTO_BYTES) {
    throw new UnprocessableError('file_too_large', 'Your photo must be 5 MB or smaller.');
  }

  const driver = await require_(driverId);
  const key = `${driverId}/profile-${randomUUID()}.${extension}`;
  await objectStore().put(key, file.bytes, file.contentType);

  // The previous key is left in the store rather than deleted. Storage is
  // cheap; a driver whose photo vanished because a later upload half-failed is
  // a support conversation.
  driver.photoKey = key;
  await driver.save();

  await audit.record({
    action: 'driver.photo_updated',
    entityType: 'driver',
    entityId: driver.id,
    after: { photoKey: key },
    actorUserId: actor.userId,
    ip: actor.ip,
  });

  return portalProfile(driverId);
}

export async function readPortalPhoto(
  driverId: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  const driver = await require_(driverId);
  if (!driver.photoKey) throw new NotFoundError('Profile photo');

  const stored = await objectStore().get(driver.photoKey);
  if (!stored) throw new NotFoundError('Profile photo');

  return { bytes: stored.bytes, contentType: stored.contentType };
}

// ------------------------------------------------- the driver's own vehicle

export interface DriverPortalVehicle {
  id: string;
  registrationNumber: string;
  category: VehicleCategory;
  status: 'pending' | 'documents_verified' | 'approved' | 'rejected' | 'suspended';
  statusReason: string | null;
  canEarn: boolean;
  bodyType: string | null;
  makeModel: string | null;
  colour: string | null;
  manufactureYear: number | null;
  fuelType: FuelType | null;
  photoUrl: string | null;
}

/**
 * Ten admin statuses down to five the driver has a use for.
 *
 * The four working states collapse into `approved` because on the vehicle
 * screen they are one answer — it is cleared to earn. Which campaign it is
 * carrying belongs to My Campaign, and saying it in two vocabularies on two
 * screens is how the two end up disagreeing.
 */
const PORTAL_VEHICLE_STATUS: Record<VehicleStatus, DriverPortalVehicle['status']> = {
  PENDING: 'pending',
  DOCUMENTS_VERIFIED: 'documents_verified',
  APPROVED: 'approved',
  AVAILABLE: 'approved',
  ASSIGNED: 'approved',
  INSTALLING: 'approved',
  ACTIVE: 'approved',
  SUSPENDED: 'suspended',
  REJECTED: 'rejected',
  // Unreachable from a driver session — removal archives the driver too, so
  // nobody with a REMOVED vehicle can sign in to ask. Mapped rather than left
  // to crash if that ever stops being true.
  REMOVED: 'rejected',
};

/**
 * REMOVED is skipped rather than sorted last. It belongs to an archived driver
 * who cannot sign in, so this filter should never do anything — but "should
 * never" and "does not" are different, and the failure would be a driver
 * shown a vehicle that no longer exists.
 */
async function liveVehicleFor(driverId: string): Promise<Vehicle | null> {
  const vehicles = await repo.vehiclesFor(driverId);
  return vehicles.find((vehicle) => vehicle.status !== 'REMOVED') ?? null;
}

export async function portalVehicle(driverId: string): Promise<DriverPortalVehicle | null> {
  await require_(driverId);
  const vehicle = await liveVehicleFor(driverId);

  return vehicle ? portalVehicleView(vehicle) : null;
}

function portalVehicleView(vehicle: Vehicle): DriverPortalVehicle {
  return {
    id: vehicle.id,
    registrationNumber: vehicle.registrationNumber,
    category: vehicle.category,
    status: PORTAL_VEHICLE_STATUS[vehicle.status],
    statusReason: vehicle.rejectionReason ?? vehicle.suspendedReason ?? null,
    // Both lists, so this cannot disagree with the status above: everything
    // that maps to `approved` there earns here.
    canEarn:
      READY_VEHICLE.includes(vehicle.status) || WORKING_VEHICLE.includes(vehicle.status),
    bodyType: vehicle.bodyType,
    makeModel: vehicle.makeModel,
    colour: vehicle.colour,
    manufactureYear: vehicle.manufactureYear,
    fuelType: vehicle.fuelType,
    photoUrl: vehicle.imageKey ? '/v1/driver/me/vehicle/photo' : null,
  };
}

export interface PortalVehicleUpdate {
  bodyType?: string | null | undefined;
  makeModel?: string | null | undefined;
  colour?: string | null | undefined;
  manufactureYear?: number | null | undefined;
  fuelType?: FuelType | null | undefined;
}

/**
 * UI-015 and UI-016 — the driver describing their own vehicle.
 *
 * Allowed at every status, including APPROVED and mid-campaign, and that is
 * the decision worth defending. UI-016.5 says a change to "attributes that
 * affect verification" returns the vehicle to `Pending`; the two attributes
 * that do are the plate the documents were verified against and the category
 * the advertiser bought, and neither is reachable from here or from any other
 * driver endpoint. What is left cannot change *which* vehicle this is, so
 * demoting on it would take a driver off a live campaign for correcting the
 * spelling of their own paintwork — a punishment for accuracy, on the one
 * screen whose entire purpose is accuracy.
 *
 * The trail is the mitigation. Every change is audited with both sides, and
 * the operator reviewing the vehicle sees the current values next to the RC.
 */
export async function updatePortalVehicle(
  driverId: string,
  changes: PortalVehicleUpdate,
  actor: Actor,
): Promise<DriverPortalVehicle> {
  await require_(driverId);

  const vehicle = await liveVehicleFor(driverId);
  if (!vehicle) {
    throw new NotFoundError('Vehicle');
  }

  const before = describedBy(vehicle);

  if (changes.bodyType !== undefined) vehicle.bodyType = changes.bodyType ?? null;
  if (changes.makeModel !== undefined) vehicle.makeModel = changes.makeModel ?? null;
  if (changes.colour !== undefined) vehicle.colour = changes.colour ?? null;
  if (changes.manufactureYear !== undefined) {
    vehicle.manufactureYear = changes.manufactureYear ?? null;
  }
  if (changes.fuelType !== undefined) vehicle.fuelType = changes.fuelType ?? null;

  await vehicle.save();

  await audit.record({
    action: 'vehicle.described_by_driver',
    entityType: 'vehicle',
    entityId: vehicle.id,
    before,
    after: describedBy(vehicle),
    actorUserId: actor.userId,
    ip: actor.ip,
  });

  return portalVehicleView(vehicle);
}

/** The five the driver owns, and the status they owned them at. */
function describedBy(vehicle: Vehicle) {
  return {
    bodyType: vehicle.bodyType,
    makeModel: vehicle.makeModel,
    colour: vehicle.colour,
    manufactureYear: vehicle.manufactureYear,
    fuelType: vehicle.fuelType,
    // Recorded so a change made after approval is visible as one, without
    // needing the vehicle's status history joined alongside.
    vehicleStatus: vehicle.status,
  };
}

/** UI-014.2. The first thing ever to write `vehicles.image_key`. */
export async function uploadVehiclePhoto(
  driverId: string,
  file: { contentType: string; bytes: Buffer },
  actor: Actor,
): Promise<DriverPortalVehicle> {
  const extension = ACCEPTED_PHOTO_TYPES[file.contentType as keyof typeof ACCEPTED_PHOTO_TYPES];
  if (!extension) {
    throw new UnprocessableError('unsupported_type', 'Send a JPEG, PNG or WebP photo.');
  }
  if (file.bytes.length === 0) throw new UnprocessableError('empty_file', 'That file is empty.');
  if (file.bytes.length > MAX_PHOTO_BYTES) {
    throw new UnprocessableError('file_too_large', 'Your photo must be 5 MB or smaller.');
  }

  await require_(driverId);
  const vehicle = await liveVehicleFor(driverId);
  if (!vehicle) throw new NotFoundError('Vehicle');

  const key = `${driverId}/vehicle-${randomUUID()}.${extension}`;
  await objectStore().put(key, file.bytes, file.contentType);

  vehicle.imageKey = key;
  await vehicle.save();

  await audit.record({
    action: 'vehicle.photo_updated',
    entityType: 'vehicle',
    entityId: vehicle.id,
    after: { imageKey: key },
    actorUserId: actor.userId,
    ip: actor.ip,
  });

  return portalVehicleView(vehicle);
}

export async function readVehiclePhoto(
  driverId: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  await require_(driverId);
  const vehicle = await liveVehicleFor(driverId);
  if (!vehicle) throw new NotFoundError('Vehicle photo');

  return vehiclePhotoBytes(vehicle);
}

/**
 * The same bytes, for the operator. AC-32.4 asks them to verify the vehicle,
 * and a photo only its owner can open is a field the driver filled in for
 * nobody.
 */
export async function readVehiclePhotoById(
  vehicleId: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  return vehiclePhotoBytes(await requireVehicle(vehicleId));
}

async function vehiclePhotoBytes(
  vehicle: Vehicle,
): Promise<{ bytes: Buffer; contentType: string }> {
  if (!vehicle.imageKey) throw new NotFoundError('Vehicle photo');

  const stored = await objectStore().get(vehicle.imageKey);
  if (!stored) throw new NotFoundError('Vehicle photo');

  return { bytes: stored.bytes, contentType: stored.contentType };
}

/**
 * AC-23 — the driver's own figures.
 *
 * Summed from `trip_segments` on every read. This returned hardcoded zeros for
 * as long as there was no pipeline behind it, which was the honest answer
 * then; it is not any more.
 */
export function portalEarnings(driverId: string) {
  return tracking.earningsFor(driverId);
}

export async function portalEligibility(driverId: string) {
  const { driver, vehicles } = await driverDetail(driverId);
  const vehicle = vehicles[0];
  const vehicleApproved = Boolean(vehicle && READY_VEHICLE.includes(vehicle.status));

  const checks = [
    { id: 'vehicle_approved', label: 'Vehicle approved', passed: vehicleApproved },
    { id: 'campaign_assigned', label: 'Campaign assigned', passed: false },
    { id: 'ad_installed', label: 'Advertisement installed', passed: false },
    { id: 'installation_verified', label: 'Installation verified', passed: false },
    { id: 'campaign_active', label: 'Campaign active', passed: driver.status === 'APPROVED' },
  ];

  return { eligible: checks.every((check) => check.passed), checks };
}

function applyLocation(driver: Driver, location: DriverLocationInput): void {
  const pin = locationColumns(location);
  driver.city = pin.city;
  driver.baseLat = pin.baseLat;
  driver.baseLng = pin.baseLng;
  driver.baseLabel = pin.baseLabel;
}
