'use strict';

/**
 * Migration 015 — vehicles the advertiser asked to wrap.
 *
 * This is a request, not an assignment (AC-22.4). Admin still confirms.
 * Stored as UUID[] on the campaign until campaign_vehicles exists.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE campaigns
        ADD COLUMN requested_vehicle_ids UUID[] NOT NULL DEFAULT '{}';
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE campaigns
        DROP COLUMN IF EXISTS requested_vehicle_ids;
    `);
  },
};
