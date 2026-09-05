'use strict';

/**
 * Migration 010 — campaigns.
 *
 * Advertiser-created campaigns for the first slice of AC-01: name, city,
 * vehicle type, dates, budget and a creative key. Zones and rate cards are
 * later migrations; this table is the thing they will hang off.
 *
 * `creative_key` is a storage key, not a URL, so the file can move from
 * `campaign-images/` on disk to Azure Blob without rewriting rows.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TYPE campaign_status AS ENUM (
        'DRAFT','PENDING_CONFIRMATION','PENDING_APPROVAL','APPROVED',
        'AWAITING_INSTALLATION','ACTIVE','PAUSED','BUDGET_WARNING',
        'STOPPED','COMPLETED','CANCELLED');

      CREATE TYPE campaign_vehicle_type AS ENUM ('CAB','AUTO');

      CREATE TABLE campaigns (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        advertiser_id         UUID NOT NULL REFERENCES advertisers(id),
        name                  TEXT NOT NULL,
        brand_name            TEXT NOT NULL,
        city                  TEXT NOT NULL,
        vehicle_type          campaign_vehicle_type NOT NULL,
        creative_key          TEXT,
        creative_file_name    TEXT,
        creative_content_type TEXT,
        creative_byte_size    INTEGER,
        status                campaign_status NOT NULL DEFAULT 'PENDING_APPROVAL',
        start_date            DATE NOT NULL,
        end_date              DATE NOT NULL,
        budget_amount         NUMERIC(14,4) NOT NULL CHECK (budget_amount > 0),
        spent_amount          NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (spent_amount >= 0),
        target_km             NUMERIC(12,4),
        created_by            UUID NOT NULL REFERENCES users(id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT ck_campaign_dates CHECK (end_date >= start_date),
        CONSTRAINT ck_campaign_budget CHECK (spent_amount <= budget_amount)
      );

      CREATE INDEX ix_campaigns_advertiser ON campaigns (advertiser_id, status);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS campaigns;
      DROP TYPE IF EXISTS campaign_vehicle_type;
      DROP TYPE IF EXISTS campaign_status;
    `);
  },
};
