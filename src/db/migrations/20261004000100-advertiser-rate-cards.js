'use strict';

/**
 * Per-advertiser rate cards, snapshotted onto each campaign at create.
 *
 * Platform defaults stay ₹5 / ₹2 / ₹1. A custom card is a new row, not an
 * in-place update: changing a customer's prices cannot reprice a campaign
 * already sold, and GPS keeps using the snapshot written at create.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE advertiser_rate_cards (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        advertiser_id  UUID NOT NULL REFERENCES advertisers(id),
        prime          NUMERIC(8,4) NOT NULL CHECK (prime >= 0),
        secondary      NUMERIC(8,4) NOT NULL CHECK (secondary >= 0),
        network        NUMERIC(8,4) NOT NULL CHECK (network >= 0),
        created_by     UUID NOT NULL REFERENCES users(id),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX ix_advertiser_rate_cards_advertiser
        ON advertiser_rate_cards (advertiser_id, created_at DESC);
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE campaigns
        ADD COLUMN rate_prime NUMERIC(8,4) NOT NULL DEFAULT 5,
        ADD COLUMN rate_secondary NUMERIC(8,4) NOT NULL DEFAULT 2,
        ADD COLUMN rate_network NUMERIC(8,4) NOT NULL DEFAULT 1;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE campaigns
        DROP COLUMN IF EXISTS rate_prime,
        DROP COLUMN IF EXISTS rate_secondary,
        DROP COLUMN IF EXISTS rate_network;
      DROP TABLE IF EXISTS advertiser_rate_cards;
    `);
  },
};
