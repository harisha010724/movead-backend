'use strict';

/**
 * Migration 013 — planned kilometres for Prime and Secondary.
 *
 * The advertiser enters target KM. Budget is KM × the fixed rate
 * (₹5 Prime, ₹2 Secondary). Network is leftover geography at ₹1/km and
 * has no planned KM.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE campaigns
        ADD COLUMN zone_km_prime     NUMERIC(12,4) NOT NULL DEFAULT 0
          CHECK (zone_km_prime >= 0),
        ADD COLUMN zone_km_secondary NUMERIC(12,4) NOT NULL DEFAULT 0
          CHECK (zone_km_secondary >= 0);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE campaigns
        DROP COLUMN IF EXISTS zone_km_prime,
        DROP COLUMN IF EXISTS zone_km_secondary;
    `);
  },
};
