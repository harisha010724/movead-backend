import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../../db/sequelize';

/** Models for driver onboarding (database design Part 5). */

export type DriverStatus = 'PENDING' | 'DOCUMENTS_SUBMITTED' | 'APPROVED' | 'SUSPENDED';

export type VehicleStatus =
  | 'PENDING'
  | 'DOCUMENTS_VERIFIED'
  | 'APPROVED'
  | 'AVAILABLE'
  | 'ASSIGNED'
  | 'INSTALLING'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'REJECTED'
  | 'REMOVED';

export type VehicleCategory = 'AUTO' | 'CAB';
/** Constrained by `vehicles_fuel_type_known`, migration 022. */
export type FuelType = 'PETROL' | 'DIESEL' | 'CNG' | 'LPG' | 'ELECTRIC' | 'HYBRID';
export type DocumentKind = 'RC' | 'LICENCE' | 'INSURANCE' | 'POLLUTION' | 'PERMIT' | 'OTHER';
export type DocumentStatus = 'UPLOADED' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
export type PayoutMethod = 'BANK' | 'UPI';
export type ConsentKind = 'LOCATION_TRACKING';
export type ConsentAction = 'GRANTED' | 'WITHDRAWN';

export class Driver extends Model<InferAttributes<Driver>, InferCreationAttributes<Driver>> {
  declare id: CreationOptional<string>;
  declare mobile: string;
  declare name: string;
  declare photoKey: string | null;
  declare status: DriverStatus;
  declare suspendedReason: string | null;
  declare rejectionReason: string | null;
  declare joinedAt: CreationOptional<Date>;
  /** Pilot city. One value today; kept so a second city does not need a new column. */
  declare city: CreationOptional<string>;
  /** Operating pin. Null on rows created before location was collected. */
  declare baseLat: string | null;
  declare baseLng: string | null;
  declare baseLabel: string | null;
  /**
   * Home address and payout details — AC-04.1, collected from the phone rather
   * than at onboard, because operations does not know either of them.
   */
  declare addressLine1: CreationOptional<string | null>;
  declare addressLine2: CreationOptional<string | null>;
  declare addressCity: CreationOptional<string | null>;
  declare addressState: CreationOptional<string | null>;
  declare addressPincode: CreationOptional<string | null>;
  declare payoutMethod: CreationOptional<PayoutMethod | null>;
  declare bankAccountName: CreationOptional<string | null>;
  declare bankAccountNumber: CreationOptional<string | null>;
  declare bankIfsc: CreationOptional<string | null>;
  declare upiId: CreationOptional<string | null>;
  /** Archived, not erased — the audit trail references this row. Migration 008. */
  declare deletedAt: CreationOptional<Date | null>;
  declare deletedReason: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Driver.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    mobile: { type: DataTypes.TEXT, allowNull: false, unique: true },
    name: { type: DataTypes.TEXT, allowNull: false },
    photoKey: { type: DataTypes.TEXT, allowNull: true },
    status: {
      type: DataTypes.ENUM('PENDING', 'DOCUMENTS_SUBMITTED', 'APPROVED', 'SUSPENDED'),
      allowNull: false,
    },
    suspendedReason: { type: DataTypes.TEXT, allowNull: true },
    rejectionReason: { type: DataTypes.TEXT, allowNull: true },
    joinedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    city: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'Bengaluru' },
    baseLat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    baseLng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    baseLabel: { type: DataTypes.TEXT, allowNull: true },
    addressLine1: { type: DataTypes.TEXT, allowNull: true },
    addressLine2: { type: DataTypes.TEXT, allowNull: true },
    addressCity: { type: DataTypes.TEXT, allowNull: true },
    addressState: { type: DataTypes.TEXT, allowNull: true },
    addressPincode: { type: DataTypes.TEXT, allowNull: true },
    payoutMethod: { type: DataTypes.ENUM('BANK', 'UPI'), allowNull: true },
    bankAccountName: { type: DataTypes.TEXT, allowNull: true },
    bankAccountNumber: { type: DataTypes.TEXT, allowNull: true },
    bankIfsc: { type: DataTypes.TEXT, allowNull: true },
    upiId: { type: DataTypes.TEXT, allowNull: true },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
    deletedReason: { type: DataTypes.TEXT, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'drivers', timestamps: true },
);

export class Vehicle extends Model<InferAttributes<Vehicle>, InferCreationAttributes<Vehicle>> {
  declare id: CreationOptional<string>;
  declare driverId: string;
  declare registrationNumber: string;
  declare category: VehicleCategory;
  // Optional because AC-04 never asks for them: an admin opening an account
  // under AC-32.1 knows the plate, not the paint. The driver fills these in
  // from the app (UI-015), or nobody does.
  declare bodyType: string | null;
  declare makeModel: string | null;
  declare colour: string | null;
  declare manufactureYear: number | null;
  declare fuelType: FuelType | null;
  declare imageKey: string | null;
  /**
   * Derived from `imageKey`, so that every payload carrying a vehicle carries
   * something an `<img>` can be pointed at. The key is an object-store path
   * and is no use to a browser, and a client that built this URL itself would
   * be the second place the route is written down.
   */
  declare imageUrl: CreationOptional<string | null>;
  declare status: VehicleStatus;
  declare rejectionReason: string | null;
  declare suspendedReason: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare driver?: Driver;
}

Vehicle.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    driverId: { type: DataTypes.UUID, allowNull: false },
    registrationNumber: { type: DataTypes.TEXT, allowNull: false, unique: true },
    category: { type: DataTypes.ENUM('AUTO', 'CAB'), allowNull: false },
    bodyType: { type: DataTypes.TEXT, allowNull: true },
    makeModel: { type: DataTypes.TEXT, allowNull: true },
    colour: { type: DataTypes.TEXT, allowNull: true },
    manufactureYear: { type: DataTypes.SMALLINT, allowNull: true },
    fuelType: { type: DataTypes.TEXT, allowNull: true },
    imageKey: { type: DataTypes.TEXT, allowNull: true },
    imageUrl: {
      type: DataTypes.VIRTUAL,
      get(this: Vehicle): string | null {
        return this.imageKey ? `/v1/admin/vehicles/${this.id}/photo` : null;
      },
    },
    status: {
      type: DataTypes.ENUM(
        'PENDING',
        'DOCUMENTS_VERIFIED',
        'APPROVED',
        'AVAILABLE',
        'ASSIGNED',
        'INSTALLING',
        'ACTIVE',
        'SUSPENDED',
        'REJECTED',
        'REMOVED',
      ),
      allowNull: false,
    },
    rejectionReason: { type: DataTypes.TEXT, allowNull: true },
    suspendedReason: { type: DataTypes.TEXT, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'vehicles', timestamps: true },
);

export class VehicleStatusEvent extends Model<
  InferAttributes<VehicleStatusEvent>,
  InferCreationAttributes<VehicleStatusEvent>
> {
  declare id: CreationOptional<string>;
  declare vehicleId: string;
  declare fromStatus: VehicleStatus | null;
  declare toStatus: VehicleStatus;
  declare reason: string | null;
  declare actorUserId: string | null;
  declare createdAt: CreationOptional<Date>;
}

VehicleStatusEvent.init(
  {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    vehicleId: { type: DataTypes.UUID, allowNull: false },
    fromStatus: { type: DataTypes.TEXT, allowNull: true },
    toStatus: { type: DataTypes.TEXT, allowNull: false },
    reason: { type: DataTypes.TEXT, allowNull: true },
    actorUserId: { type: DataTypes.UUID, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: 'vehicle_status_events' },
);

export class DocumentRecord extends Model<
  InferAttributes<DocumentRecord>,
  InferCreationAttributes<DocumentRecord>
> {
  declare id: CreationOptional<string>;
  declare kind: DocumentKind;
  declare driverId: string | null;
  declare vehicleId: string | null;
  declare storageKey: string;
  declare contentType: string;
  declare byteSize: number;
  declare status: DocumentStatus;
  declare documentNumber: string | null;
  declare issuedOn: string | null;
  declare expiresOn: string | null;
  declare uploadedAt: CreationOptional<Date>;
  declare reviewedAt: Date | null;
  declare reviewedBy: string | null;
  declare rejectionReason: string | null;
  declare supersededAt: Date | null;
  declare supersededBy: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

DocumentRecord.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    kind: {
      type: DataTypes.ENUM('RC', 'LICENCE', 'INSURANCE', 'POLLUTION', 'PERMIT', 'OTHER'),
      allowNull: false,
    },
    driverId: { type: DataTypes.UUID, allowNull: true },
    vehicleId: { type: DataTypes.UUID, allowNull: true },
    storageKey: { type: DataTypes.TEXT, allowNull: false },
    contentType: { type: DataTypes.TEXT, allowNull: false },
    byteSize: { type: DataTypes.INTEGER, allowNull: false },
    status: {
      type: DataTypes.ENUM('UPLOADED', 'VERIFIED', 'REJECTED', 'EXPIRED'),
      allowNull: false,
    },
    documentNumber: { type: DataTypes.TEXT, allowNull: true },
    // DATEONLY, so an expiry is a calendar date rather than an instant that
    // shifts a day either way depending on the reader's timezone.
    issuedOn: { type: DataTypes.DATEONLY, allowNull: true },
    expiresOn: { type: DataTypes.DATEONLY, allowNull: true },
    uploadedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
    reviewedBy: { type: DataTypes.UUID, allowNull: true },
    rejectionReason: { type: DataTypes.TEXT, allowNull: true },
    supersededAt: { type: DataTypes.DATE, allowNull: true },
    supersededBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'documents', timestamps: true },
);

/**
 * AC-04.3 — consent, recorded and timestamped. Append-only: a withdrawal is a
 * new row, never an update, so "were they consenting on the 14th?" stays
 * answerable after they withdraw on the 15th.
 */
export class DriverConsent extends Model<
  InferAttributes<DriverConsent>,
  InferCreationAttributes<DriverConsent>
> {
  declare id: CreationOptional<string>;
  declare driverId: string;
  declare kind: ConsentKind;
  declare action: ConsentAction;
  declare recordedAt: CreationOptional<Date>;
  /** The disclosure they were shown. Consent to unknown wording proves nothing. */
  declare policyVersion: string;
  declare source: string;
  declare ip: CreationOptional<string | null>;
}

DriverConsent.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    driverId: { type: DataTypes.UUID, allowNull: false },
    kind: { type: DataTypes.ENUM('LOCATION_TRACKING'), allowNull: false },
    action: { type: DataTypes.ENUM('GRANTED', 'WITHDRAWN'), allowNull: false },
    recordedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    policyVersion: { type: DataTypes.TEXT, allowNull: false },
    source: { type: DataTypes.TEXT, allowNull: false },
    ip: { type: DataTypes.TEXT, allowNull: true },
  },
  { sequelize, tableName: 'driver_consents', timestamps: false },
);

Driver.hasMany(DriverConsent, { foreignKey: 'driverId' });
Driver.hasMany(Vehicle, { foreignKey: 'driverId', as: 'vehicles' });
Vehicle.belongsTo(Driver, { foreignKey: 'driverId', as: 'driver' });
Driver.hasMany(DocumentRecord, { foreignKey: 'driverId' });
Vehicle.hasMany(DocumentRecord, { foreignKey: 'vehicleId' });
Vehicle.hasMany(VehicleStatusEvent, { foreignKey: 'vehicleId' });
