'use strict';

/**
 * Migration 014 — driver operating location.
 *
 * Advertisers see available vehicles by whether this pin sits inside a
 * campaign's Prime or Secondary outline. Stored as lat/lng, not PostGIS:
 * PostGIS is still a later zones dependency, and a point-in-polygon check
 * against the campaign JSONB paths is enough for this matching step.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE drivers
        ADD COLUMN city       TEXT          NOT NULL DEFAULT 'Bengaluru',
        ADD COLUMN base_lat   NUMERIC(10,7),
        ADD COLUMN base_lng   NUMERIC(10,7),
        ADD COLUMN base_label TEXT;

      ALTER TABLE drivers
        ADD CONSTRAINT drivers_base_location_pair
          CHECK ((base_lat IS NULL) = (base_lng IS NULL));
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE drivers
        DROP CONSTRAINT IF EXISTS drivers_base_location_pair,
        DROP COLUMN IF EXISTS city,
        DROP COLUMN IF EXISTS base_lat,
        DROP COLUMN IF EXISTS base_lng,
        DROP COLUMN IF EXISTS base_label;
    `);
  },
};
