'use strict';

/**
 * Migration 018 — campaign-to-vehicle assignment and per-vehicle installation.
 *
 * Until now `campaigns.requested_vehicle_ids` held an advertiser's *request*
 * (AC-22.4) and nothing turned it into an assignment. This is the table its
 * migration comment promised, plus the installation record AC-06 requires.
 *
 * Two rules are enforced here rather than in a service, because they are the
 * ones that cost money when they break:
 *
 *   AC-22.6 / AC-16 — a vehicle is on at most one live campaign at a time. A
 *   partial unique index makes a second live assignment impossible, so a
 *   kilometre can never be claimed by two advertisers.
 *
 *   AC-06.12 — the installer who uploads evidence cannot be the admin who
 *   approves it. A check constraint refuses the row outright.
 *
 * Installation is per vehicle, not per campaign, because AC-06.10 says the
 * campaign becomes active "for that vehicle only" on approval. Ten vehicles on
 * one campaign go live independently as each wrap is signed off.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TYPE assignment_status AS ENUM (
        'ASSIGNED','ACCEPTED','INSTALLING','ACTIVE','ENDED','WITHDRAWN');

      CREATE TYPE installation_status AS ENUM (
        'SCHEDULED','IN_PROGRESS','SUBMITTED','APPROVED','REJECTED');

      CREATE TYPE installation_photo_angle AS ENUM ('FRONT','REAR','LEFT','RIGHT');

      CREATE TABLE campaign_vehicles (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id     UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        vehicle_id      UUID NOT NULL REFERENCES vehicles(id),
        -- Denormalised from the vehicle so a driver's campaign list is one
        -- index lookup, and so history survives a vehicle changing hands.
        driver_id       UUID NOT NULL REFERENCES drivers(id),
        status          assignment_status NOT NULL DEFAULT 'ASSIGNED',
        assigned_by     UUID NOT NULL REFERENCES users(id),
        assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        accepted_at     TIMESTAMPTZ,
        activated_at    TIMESTAMPTZ,
        ended_at        TIMESTAMPTZ,
        end_reason      TEXT,
        -- AC-22.3: assigning a vehicle that fails a requirement needs a stated
        -- reason. Null means the vehicle met every requirement.
        override_reason TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT uq_campaign_vehicle UNIQUE (campaign_id, vehicle_id),
        CONSTRAINT ck_assignment_ended CHECK (
          status NOT IN ('ENDED','WITHDRAWN') OR end_reason IS NOT NULL)
      );

      -- AC-22.6 and AC-16, enforced by the database. 'ENDED' and 'WITHDRAWN'
      -- are excluded so a vehicle can be reassigned once it leaves a campaign,
      -- while history is preserved.
      CREATE UNIQUE INDEX uq_vehicle_live_assignment
        ON campaign_vehicles (vehicle_id)
        WHERE status IN ('ASSIGNED','ACCEPTED','INSTALLING','ACTIVE');

      CREATE INDEX ix_campaign_vehicles_campaign ON campaign_vehicles (campaign_id, status);
      CREATE INDEX ix_campaign_vehicles_driver   ON campaign_vehicles (driver_id, status);

      CREATE TABLE installations (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        -- One installation per assignment. A rejected one returns to
        -- IN_PROGRESS and its photos are replaced (AC-06.9) rather than a
        -- second row being created, so "the installation" stays unambiguous.
        campaign_vehicle_id UUID NOT NULL UNIQUE
                            REFERENCES campaign_vehicles(id) ON DELETE CASCADE,
        status              installation_status NOT NULL DEFAULT 'SCHEDULED',
        scheduled_for       TIMESTAMPTZ,
        submitted_at        TIMESTAMPTZ,
        submitted_by        UUID REFERENCES users(id),
        reviewed_at         TIMESTAMPTZ,
        reviewed_by         UUID REFERENCES users(id),
        rejection_reason    TEXT,
        -- AC-06.13: a wrap that comes off or is damaged deactivates the
        -- vehicle on this campaign.
        removed_at          TIMESTAMPTZ,
        removed_reason      TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

        -- AC-06.12: separation of duties. Whoever installed it cannot sign it
        -- off, even if they hold both permissions.
        CONSTRAINT ck_installation_separate_actors CHECK (
          reviewed_by IS NULL OR submitted_by IS NULL OR reviewed_by <> submitted_by),
        CONSTRAINT ck_installation_rejection CHECK (
          (status = 'REJECTED') = (rejection_reason IS NOT NULL)),
        CONSTRAINT ck_installation_removed CHECK (
          (removed_at IS NULL) = (removed_reason IS NULL))
      );

      CREATE INDEX ix_installations_status ON installations (status);

      CREATE TABLE installation_photos (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        installation_id UUID NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
        angle           installation_photo_angle NOT NULL,
        -- A storage key, never a URL, for the same reason as driver photos.
        storage_key     TEXT NOT NULL,
        file_name       TEXT NOT NULL,
        content_type    TEXT NOT NULL,
        byte_size       INTEGER NOT NULL CHECK (byte_size > 0),
        uploaded_by     UUID NOT NULL REFERENCES users(id),
        uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

        -- Re-uploading an angle replaces it, which is what correcting a
        -- rejected installation means in practice.
        CONSTRAINT uq_installation_photo_angle UNIQUE (installation_id, angle)
      );

      INSERT INTO permissions (key, description) VALUES
        ('installation.upload', 'Upload installation evidence for a wrapped vehicle')
      ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

      INSERT INTO role_permissions (role_id, permission_key)
      SELECT r.id, 'installation.upload' FROM roles r WHERE r.key = 'SUPER_ADMIN'
      ON CONFLICT DO NOTHING;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM role_permissions WHERE permission_key = 'installation.upload';
      DELETE FROM permissions WHERE key = 'installation.upload';

      DROP TABLE IF EXISTS installation_photos;
      DROP TABLE IF EXISTS installations;
      DROP TABLE IF EXISTS campaign_vehicles;

      DROP TYPE IF EXISTS installation_photo_angle;
      DROP TYPE IF EXISTS installation_status;
      DROP TYPE IF EXISTS assignment_status;
    `);
  },
};
