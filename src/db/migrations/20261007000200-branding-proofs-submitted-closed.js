'use strict';

/**
 * Submitted wrap photos are published to the advertiser. They are no longer
 * an open check, so operations can ask for another set without approving first.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS ux_branding_proofs_open;
      CREATE UNIQUE INDEX ux_branding_proofs_open
        ON branding_proofs (campaign_vehicle_id)
        WHERE status IN ('REQUESTED', 'IN_PROGRESS', 'REJECTED');
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS ux_branding_proofs_open;
      CREATE UNIQUE INDEX ux_branding_proofs_open
        ON branding_proofs (campaign_vehicle_id)
        WHERE status IN ('REQUESTED', 'IN_PROGRESS', 'SUBMITTED', 'REJECTED');
    `);
  },
};
