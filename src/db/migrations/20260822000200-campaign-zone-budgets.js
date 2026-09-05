'use strict';

/**
 * Migration 011 — per-zone budgets on a campaign.
 *
 * The advertiser enters how much they will spend in Prime, Secondary and
 * Network. `budget_amount` stays the sum, so billing still has one ceiling.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE campaigns
        ADD COLUMN zone_budget_prime     NUMERIC(14,4) NOT NULL DEFAULT 0
          CHECK (zone_budget_prime >= 0),
        ADD COLUMN zone_budget_secondary NUMERIC(14,4) NOT NULL DEFAULT 0
          CHECK (zone_budget_secondary >= 0),
        ADD COLUMN zone_budget_network   NUMERIC(14,4) NOT NULL DEFAULT 0
          CHECK (zone_budget_network >= 0);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE campaigns
        DROP COLUMN IF EXISTS zone_budget_prime,
        DROP COLUMN IF EXISTS zone_budget_secondary,
        DROP COLUMN IF EXISTS zone_budget_network;
    `);
  },
};
