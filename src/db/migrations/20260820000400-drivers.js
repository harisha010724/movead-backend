'use strict';

/**
 * Migration 005 — drivers, vehicles and documents (database design Part 5).
 *
 * The constraints here are the acceptance criteria written where they cannot
 * be bypassed. A rejection without a reason (AC-05.5), a second driver
 * claiming a registered plate (AC-05.7) and a suspension with no explanation
 * are all rejected by the database rather than by whichever code path
 * happened to run.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TYPE driver_status AS ENUM ('PENDING','DOCUMENTS_SUBMITTED','APPROVED','SUSPENDED');

      CREATE TABLE drivers (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        mobile           TEXT          NOT NULL,
        name             TEXT          NOT NULL,
        -- An object-storage key, never a URL: media is served through
        -- short-lived presigned URLs, so a stored URL would bake in a bucket,
        -- a region and an expiry (architecture Part 12.3).
        photo_key        TEXT,
        status           driver_status NOT NULL DEFAULT 'PENDING',
        suspended_reason TEXT,
        rejection_reason TEXT,
        joined_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
        created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),

        CONSTRAINT uq_drivers_mobile UNIQUE (mobile),
        -- Indian mobile numbers are ten digits and never start below 6. The
        -- same rule the app validates with, enforced where it cannot be
        -- bypassed.
        CONSTRAINT ck_drivers_mobile CHECK (mobile ~ '^[6-9][0-9]{9}$'),
        CONSTRAINT ck_drivers_suspension CHECK (
          status <> 'SUSPENDED' OR suspended_reason IS NOT NULL)
      );

      -- Deferred from the identity migration: the audit trail had to exist
      -- before drivers did, so its driver FK is added now.
      ALTER TABLE audit_log
        ADD CONSTRAINT fk_audit_driver FOREIGN KEY (actor_driver_id) REFERENCES drivers(id);

      CREATE TYPE vehicle_status AS ENUM (
        'PENDING','DOCUMENTS_VERIFIED','APPROVED','AVAILABLE','ASSIGNED',
        'INSTALLING','ACTIVE','SUSPENDED','REJECTED','REMOVED');

      CREATE TYPE vehicle_category AS ENUM ('AUTO','CAB');

      CREATE TABLE vehicles (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id           UUID NOT NULL REFERENCES drivers(id),
        registration_number TEXT NOT NULL,
        category            vehicle_category NOT NULL,
        body_type           TEXT NOT NULL,
        make_model          TEXT NOT NULL,
        colour              TEXT NOT NULL,
        manufacture_year    SMALLINT NOT NULL,
        fuel_type           TEXT NOT NULL,
        image_key           TEXT,
        status              vehicle_status NOT NULL DEFAULT 'PENDING',
        rejection_reason    TEXT,
        suspended_reason    TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

        -- Platform-wide, not per driver: a plate identifies one physical
        -- vehicle, and two drivers claiming it is the fraud this stops.
        CONSTRAINT uq_vehicles_registration UNIQUE (registration_number),
        CONSTRAINT ck_vehicles_registration CHECK (
          registration_number ~ '^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$' OR
          registration_number ~ '^[0-9]{2}BH[0-9]{4}[A-Z]{1,2}$'),
        CONSTRAINT ck_vehicles_year CHECK (manufacture_year BETWEEN 1990 AND 2100),
        CONSTRAINT ck_vehicles_rejection CHECK (
          status <> 'REJECTED' OR rejection_reason IS NOT NULL),
        CONSTRAINT ck_vehicles_suspension CHECK (
          status <> 'SUSPENDED' OR suspended_reason IS NOT NULL)
      );

      CREATE INDEX ix_vehicles_driver ON vehicles (driver_id);
      CREATE INDEX ix_vehicles_status ON vehicles (status);

      -- AC-05.3: every stage is a recorded state with the admin and timestamp
      -- that set it. Disputes about when a vehicle became billable are settled
      -- by reading rows, not logs.
      CREATE TABLE vehicle_status_events (
        id            BIGSERIAL PRIMARY KEY,
        vehicle_id    UUID NOT NULL REFERENCES vehicles(id),
        from_status   vehicle_status,
        to_status     vehicle_status NOT NULL,
        reason        TEXT,
        actor_user_id UUID REFERENCES users(id),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT ck_vehicle_transition CHECK (from_status IS DISTINCT FROM to_status)
      );

      CREATE INDEX ix_vehicle_status_events ON vehicle_status_events (vehicle_id, created_at DESC);

      CREATE TYPE document_kind AS ENUM ('RC','LICENCE','INSURANCE','POLLUTION','PERMIT','OTHER');
      CREATE TYPE document_status AS ENUM ('UPLOADED','VERIFIED','REJECTED','EXPIRED');

      -- A licence belongs to a driver; an RC, insurance, pollution certificate
      -- and permit belong to a vehicle. One table with an exclusive-owner
      -- check keeps verification, expiry and reminders in one place.
      CREATE TABLE documents (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kind             document_kind   NOT NULL,
        driver_id        UUID REFERENCES drivers(id),
        vehicle_id       UUID REFERENCES vehicles(id),
        storage_key      TEXT            NOT NULL,
        content_type     TEXT            NOT NULL,
        byte_size        INTEGER         NOT NULL CHECK (byte_size > 0),
        status           document_status NOT NULL DEFAULT 'UPLOADED',
        document_number  TEXT,
        issued_on        DATE,
        expires_on       DATE,
        uploaded_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
        reviewed_at      TIMESTAMPTZ,
        reviewed_by      UUID REFERENCES users(id),
        rejection_reason TEXT,
        -- Resubmission supersedes rather than overwrites, so the rejected copy
        -- survives for the appeal.
        superseded_at    TIMESTAMPTZ,
        superseded_by    UUID REFERENCES documents(id),
        created_at       TIMESTAMPTZ     NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ     NOT NULL DEFAULT now(),

        CONSTRAINT ck_document_owner CHECK (num_nonnulls(driver_id, vehicle_id) = 1),
        CONSTRAINT ck_document_rejection CHECK (
          status <> 'REJECTED' OR rejection_reason IS NOT NULL),
        CONSTRAINT ck_document_review CHECK (
          (reviewed_at IS NULL) = (reviewed_by IS NULL))
      );

      CREATE UNIQUE INDEX uq_document_current_driver ON documents (driver_id, kind)
        WHERE superseded_at IS NULL AND driver_id IS NOT NULL;
      CREATE UNIQUE INDEX uq_document_current_vehicle ON documents (vehicle_id, kind)
        WHERE superseded_at IS NULL AND vehicle_id IS NOT NULL;

      CREATE INDEX ix_documents_expiry ON documents (expires_on)
        WHERE superseded_at IS NULL AND expires_on IS NOT NULL;

      -- Which kinds are required, and of whom, is reference data. Adding a
      -- permit requirement for a new city should not be a deployment.
      CREATE TABLE required_documents (
        kind         document_kind PRIMARY KEY,
        owner        TEXT    NOT NULL CHECK (owner IN ('DRIVER','VEHICLE')),
        is_mandatory BOOLEAN NOT NULL DEFAULT true,
        expires      BOOLEAN NOT NULL DEFAULT true
      );

      INSERT INTO required_documents (kind, owner, expires) VALUES
        ('LICENCE',   'DRIVER',  true),
        ('RC',        'VEHICLE', false),
        ('INSURANCE', 'VEHICLE', true),
        ('POLLUTION', 'VEHICLE', true),
        ('PERMIT',    'VEHICLE', true);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS fk_audit_driver;
      DROP TABLE IF EXISTS required_documents;
      DROP TABLE IF EXISTS documents;
      DROP TABLE IF EXISTS vehicle_status_events;
      DROP TABLE IF EXISTS vehicles;
      DROP TABLE IF EXISTS drivers;
      DROP TYPE IF EXISTS document_status;
      DROP TYPE IF EXISTS document_kind;
      DROP TYPE IF EXISTS vehicle_category;
      DROP TYPE IF EXISTS vehicle_status;
      DROP TYPE IF EXISTS driver_status;
    `);
  },
};
