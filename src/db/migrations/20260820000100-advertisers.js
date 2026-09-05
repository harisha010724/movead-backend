'use strict';

/**
 * Migration 002 — advertisers.
 *
 * Ahead of identity because `users.advertiser_id` points here: an
 * advertiser-portal user is scoped to one advertiser, and that scope is
 * checked before permissions rather than after (database design Part 4.1).
 *
 * Only the account itself is created. Wallets and the ledger arrive with the
 * billing migration, which is where the money invariants belong.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TYPE advertiser_status AS ENUM ('ONBOARDING','ACTIVE','SUSPENDED','CLOSED');

      CREATE TABLE advertisers (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        legal_name      TEXT NOT NULL,
        brand_name      TEXT NOT NULL,
        gstin           TEXT,
        pan             TEXT,
        billing_email   CITEXT NOT NULL,
        billing_address JSONB,
        status          advertiser_status NOT NULL DEFAULT 'ONBOARDING',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT ck_advertisers_gstin CHECK (
          gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$')
      );
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS advertisers;
      DROP TYPE IF EXISTS advertiser_status;
    `);
  },
};
