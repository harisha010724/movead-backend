'use strict';

/**
 * Migration 012 — campaign locations and drawn zone outlines.
 *
 * Each searched place is stored with lat/lng so ads can be tied to those
 * points. Drawn polygons are GeoJSON-shaped paths per pricing tier. PostGIS
 * geography columns come later; JSONB is enough to persist what the map sends.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE campaigns
        ADD COLUMN locations     JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN zone_polygons JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE campaigns
        DROP COLUMN IF EXISTS locations,
        DROP COLUMN IF EXISTS zone_polygons;
    `);
  },
};
