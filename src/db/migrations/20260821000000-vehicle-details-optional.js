'use strict';

/**
 * Migration 007 — vehicle descriptive details become optional.
 *
 * AC-04 lists what a registration captures: mobile, OTP, name, profile photo,
 * vehicle type, registration number, licence, vehicle documents, payout details
 * and tracking consent. Body type, make and model, colour, manufacture year and
 * fuel type are on none of those lists — migration 005 required them anyway,
 * which made it impossible for an admin to open an account under AC-32.1
 * without inventing five facts they have no way of knowing over a phone call.
 *
 * The plate stays mandatory, because it is the one field that has to be unique
 * platform-wide (AC-05.7) and reserving it is the point of creating the row.
 *
 * The year check survives as a constraint on the values that *are* supplied;
 * NULL passes a CHECK, so no rewrite is needed for it to keep meaning what it
 * meant.
 */

const OPTIONAL_COLUMNS = ['body_type', 'make_model', 'colour', 'manufacture_year', 'fuel_type'];

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      OPTIONAL_COLUMNS.map((column) => `ALTER TABLE vehicles ALTER COLUMN ${column} DROP NOT NULL;`).join(
        '\n',
      ),
    );
  },

  async down(queryInterface) {
    // Reinstating NOT NULL would fail on any row created since, so the blanks
    // are filled first. 'UNKNOWN' is deliberately not a plausible value: it
    // should be obvious in a report that the data was never collected.
    await queryInterface.sequelize.query(`
      UPDATE vehicles SET
        body_type        = COALESCE(body_type, 'UNKNOWN'),
        make_model       = COALESCE(make_model, 'UNKNOWN'),
        colour           = COALESCE(colour, 'UNKNOWN'),
        manufacture_year = COALESCE(manufacture_year, 1990),
        fuel_type        = COALESCE(fuel_type, 'UNKNOWN');

      ${OPTIONAL_COLUMNS.map((column) => `ALTER TABLE vehicles ALTER COLUMN ${column} SET NOT NULL;`).join('\n')}
    `);
  },
};
