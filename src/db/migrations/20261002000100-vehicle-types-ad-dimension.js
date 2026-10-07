'use strict';

/**
 * Wider fleet (bus, truck, tempo) and a wrap size on the campaign.
 *
 * Existing CAB / AUTO rows stay as they are. New values are added to both
 * vehicle enums so a campaign cannot ask for a type the fleet table cannot hold.
 * ad_dimension is nullable so campaigns already on the road do not need a size.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TYPE campaign_vehicle_type ADD VALUE IF NOT EXISTS 'BUS';
      ALTER TYPE campaign_vehicle_type ADD VALUE IF NOT EXISTS 'TRUCK';
      ALTER TYPE campaign_vehicle_type ADD VALUE IF NOT EXISTS 'TEMPO';
      ALTER TYPE vehicle_category ADD VALUE IF NOT EXISTS 'BUS';
      ALTER TYPE vehicle_category ADD VALUE IF NOT EXISTS 'TRUCK';
      ALTER TYPE vehicle_category ADD VALUE IF NOT EXISTS 'TEMPO';
    `);

    await queryInterface.addColumn('campaigns', 'ad_dimension', {
      type: queryInterface.sequelize.Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('campaigns', 'ad_dimension');
  },
};
