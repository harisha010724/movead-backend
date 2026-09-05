'use strict';

/**
 * Migration 022 — `fuel_type` becomes an answer rather than a sentence.
 *
 * Nothing has ever written to this column: migration 005 made it NOT NULL,
 * migration 007 gave up and made it optional, and admin onboarding does not
 * ask. It is about to be filled in by drivers typing on phones, and the moment
 * that happens the difference between `CNG`, `cng` and `C.N.G.` stops being
 * cosmetic — it is the difference between a column you can group by and one
 * you can only read.
 *
 * Six values, because in India there are six. `HYBRID` is here rather than
 * folded into `PETROL` because it is the answer a driver will look for, and a
 * driver who cannot find their own fuel picks the wrong one.
 *
 * A check constraint rather than a Postgres enum: the set will grow, and
 * adding a value to a CHECK is one statement against a table with no rewrite,
 * while `ALTER TYPE ... ADD VALUE` cannot run inside a transaction.
 */

const FUEL_TYPES = ['PETROL', 'DIESEL', 'CNG', 'LPG', 'ELECTRIC', 'HYBRID'];

module.exports = {
  async up(queryInterface) {
    const allowed = FUEL_TYPES.map((value) => `'${value}'`).join(', ');

    await queryInterface.sequelize.query(`
      -- Every row is null today, in every environment we know of. The upcase
      -- is here for the one we do not: it is free, and it turns 'Petrol' into
      -- a row that survives the constraint below instead of blocking it.
      UPDATE vehicles
         SET fuel_type = upper(btrim(fuel_type))
       WHERE fuel_type IS NOT NULL;

      -- Anything that still does not match is not a fuel we recognise, and
      -- guessing at it here would bake the guess in. Cleared, so the driver is
      -- asked once rather than shown something wrong forever.
      UPDATE vehicles
         SET fuel_type = NULL
       WHERE fuel_type IS NOT NULL
         AND fuel_type NOT IN (${allowed});

      ALTER TABLE vehicles
        ADD CONSTRAINT vehicles_fuel_type_known
        CHECK (fuel_type IS NULL OR fuel_type IN (${allowed}));
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_fuel_type_known;
    `);
  },
};
