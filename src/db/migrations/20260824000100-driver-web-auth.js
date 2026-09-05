'use strict';

/**
 * Migration 017 — driver web portal login.
 *
 * Drivers already have a `drivers` row. The web portal needs the same identity
 * the advertiser portal uses: a `users` row, an invitation, then email +
 * password. `users.driver_id` is the counterpart of `users.advertiser_id`.
 *
 * Staff: both FKs null. Advertiser: advertiser_id set. Driver: driver_id set.
 * The check refuses an account that is both, which would make audience
 * ambiguous.
 *
 * The DRIVER role exists so a login can be granted something; the portal
 * itself is gated by session audience, not by a permission name.
 */

const DRIVER_ROLE = 'DRIVER';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(
        `ALTER TABLE users
           ADD COLUMN driver_id UUID REFERENCES drivers(id);

         CREATE UNIQUE INDEX uq_users_driver_id
           ON users (driver_id)
           WHERE driver_id IS NOT NULL;

         ALTER TABLE users
           ADD CONSTRAINT ck_users_single_scope
           CHECK (NOT (advertiser_id IS NOT NULL AND driver_id IS NOT NULL));

         ALTER TABLE user_sessions
           DROP CONSTRAINT user_sessions_audience_check;

         ALTER TABLE user_sessions
           ADD CONSTRAINT user_sessions_audience_check
           CHECK (audience IN ('admin','advertiser','driver'));`,
        { transaction },
      );

      await sequelize.query(
        `INSERT INTO roles (key, description, is_system)
         VALUES ($1, $2, true)
         ON CONFLICT (key) DO NOTHING;`,
        {
          bind: [DRIVER_ROLE, 'Web login for one driver. Audience, not permissions, gates the portal.'],
          transaction,
        },
      );
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`DELETE FROM roles WHERE key = $1;`, {
        bind: [DRIVER_ROLE],
        transaction,
      });

      await sequelize.query(
        `ALTER TABLE user_sessions
           DROP CONSTRAINT user_sessions_audience_check;

         ALTER TABLE user_sessions
           ADD CONSTRAINT user_sessions_audience_check
           CHECK (audience IN ('admin','advertiser'));

         ALTER TABLE users DROP CONSTRAINT ck_users_single_scope;
         DROP INDEX IF EXISTS uq_users_driver_id;
         ALTER TABLE users DROP COLUMN driver_id;`,
        { transaction },
      );
    });
  },
};
