'use strict';

/**
 * Driver-captured wrap photos with a server-stamped location.
 *
 * Installation evidence (AC-06) is still taken by operations. This table is
 * the mid-campaign check: the driver photographs the ads vehicle from the
 * required angles, the phone sends GPS with the file, and ops reviews it.
 * A rejected or overdue request pauses earning the same way a missing wrap
 * does — the kilometre is not owed until the photos are in.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TYPE branding_proof_status AS ENUM (
        'REQUESTED', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED'
      );

      CREATE TYPE branding_proof_angle AS ENUM (
        'FRONT', 'REAR', 'LEFT', 'RIGHT', 'AD_CLOSEUP'
      );

      CREATE TABLE branding_proofs (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_vehicle_id UUID NOT NULL REFERENCES campaign_vehicles(id),
        status              branding_proof_status NOT NULL DEFAULT 'REQUESTED',
        requested_by        UUID REFERENCES users(id),
        requested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        due_at              TIMESTAMPTZ NOT NULL,
        submitted_at        TIMESTAMPTZ,
        reviewed_at         TIMESTAMPTZ,
        reviewed_by         UUID REFERENCES users(id),
        rejection_reason    TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ck_branding_proof_rejected
          CHECK (status <> 'REJECTED' OR rejection_reason IS NOT NULL)
      );

      CREATE UNIQUE INDEX ux_branding_proofs_open
        ON branding_proofs (campaign_vehicle_id)
        WHERE status IN ('REQUESTED', 'IN_PROGRESS', 'SUBMITTED', 'REJECTED');

      CREATE INDEX ix_branding_proofs_status
        ON branding_proofs (status, submitted_at);

      CREATE TABLE branding_proof_photos (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        proof_id      UUID NOT NULL REFERENCES branding_proofs(id) ON DELETE CASCADE,
        angle         branding_proof_angle NOT NULL,
        storage_key   TEXT NOT NULL,
        file_name     TEXT NOT NULL,
        content_type  TEXT NOT NULL,
        byte_size     INTEGER NOT NULL CHECK (byte_size > 0),
        lat           NUMERIC(10,7) NOT NULL,
        lon           NUMERIC(10,7) NOT NULL,
        captured_at   TIMESTAMPTZ NOT NULL,
        uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (proof_id, angle)
      );

      INSERT INTO permissions (key, description)
      VALUES
        ('branding.review', 'Request and review driver wrap-photo checks'),
        ('branding.approve', 'Approve or reject a wrap-photo check')
      ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

      INSERT INTO role_permissions (role_id, permission_key)
      SELECT r.id, p.key
        FROM roles r
        CROSS JOIN permissions p
       WHERE r.key = 'SUPER_ADMIN'
         AND p.key IN ('branding.review', 'branding.approve')
      ON CONFLICT DO NOTHING;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM role_permissions
       WHERE permission_key IN ('branding.review', 'branding.approve');
      DELETE FROM permissions
       WHERE key IN ('branding.review', 'branding.approve');
      DROP TABLE IF EXISTS branding_proof_photos;
      DROP TABLE IF EXISTS branding_proofs;
      DROP TYPE IF EXISTS branding_proof_angle;
      DROP TYPE IF EXISTS branding_proof_status;
    `);
  },
};
