'use strict';

/**
 * Migration 025 — advertiser report exports.
 *
 * The file lives in object storage; this table is the receipt. A row is what
 * the Recent exports list shows, and what a download is authorised against.
 * Seven days later the row is no longer served. The bytes may linger on disk
 * until a later sweep; they are not readable without the row.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TYPE report_export_type AS ENUM (
        'proof-pack',
        'billing-statement',
        'zone-summary',
        'vehicle-summary',
        'km-detail'
      );

      CREATE TYPE report_export_format AS ENUM ('html', 'csv');

      CREATE TABLE report_exports (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        advertiser_id UUID NOT NULL REFERENCES advertisers(id),
        campaign_id   UUID NOT NULL REFERENCES campaigns(id),
        type          report_export_type NOT NULL,
        format        report_export_format NOT NULL,
        from_date     DATE NOT NULL,
        to_date       DATE NOT NULL,
        file_name     TEXT NOT NULL,
        content_type  TEXT NOT NULL,
        byte_size     INTEGER NOT NULL CHECK (byte_size >= 0),
        storage_key   TEXT NOT NULL,
        checksum      TEXT NOT NULL,
        generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at    TIMESTAMPTZ NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT ck_report_export_range CHECK (to_date >= from_date)
      );

      CREATE INDEX ix_report_exports_advertiser
        ON report_exports (advertiser_id, generated_at DESC);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS report_exports;
      DROP TYPE IF EXISTS report_export_format;
      DROP TYPE IF EXISTS report_export_type;
    `);
  },
};
