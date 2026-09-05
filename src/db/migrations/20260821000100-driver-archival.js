'use strict';

/**
 * Migration 008 — deleting a driver, without destroying the record of them.
 *
 * A driver cannot be removed with DELETE. `audit_log.actor_driver_id` references
 * them, and the audit trail is append-only by design (AC-31.5: every action is
 * attributable, never to "the system"). Cascading the delete would erase the
 * evidence; blocking on the foreign key would make the button simply not work.
 * Once trips, earnings and payouts exist the same argument gets stronger, not
 * weaker — you cannot pay someone and then have no record of who they were.
 *
 * So a delete archives. The row stays, `deleted_at` is set, and every query
 * that feeds a screen filters it out. To the admin the driver is gone; to an
 * auditor they are still there with a reason attached.
 *
 * Two unique constraints have to become conditional for that to be usable. A
 * mobile number and a registration plate are unique platform-wide (AC-05.7),
 * but if an archived driver kept holding theirs, deleting a mistyped record
 * would permanently burn the correct number — and re-onboarding the same real
 * person would be impossible.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE drivers
        ADD COLUMN deleted_at     TIMESTAMPTZ,
        ADD COLUMN deleted_reason TEXT,
        -- The same bargain as every other destructive action here: a rejection,
        -- a suspension and now an archival all carry the reason in the row.
        ADD CONSTRAINT ck_drivers_deletion CHECK (
          deleted_at IS NULL OR deleted_reason IS NOT NULL);

      -- Live drivers only. An archived row keeps its mobile for the record but
      -- stops reserving it, so the number can be onboarded again.
      ALTER TABLE drivers DROP CONSTRAINT uq_drivers_mobile;
      CREATE UNIQUE INDEX uq_drivers_mobile_live
        ON drivers (mobile) WHERE deleted_at IS NULL;

      -- Same for the plate. REMOVED already existed in vehicle_status and is
      -- exactly this state: the vehicle is off the platform, and the plate it
      -- used is free for whoever is driving it now.
      ALTER TABLE vehicles DROP CONSTRAINT uq_vehicles_registration;
      CREATE UNIQUE INDEX uq_vehicles_registration_live
        ON vehicles (registration_number) WHERE status <> 'REMOVED';

      CREATE INDEX ix_drivers_live ON drivers (created_at DESC) WHERE deleted_at IS NULL;
    `);

    // Deleting is not suspending: one stops a driver working, the other takes
    // them off the platform. Separate keys so the two can be split between
    // roles later without touching a route (ADM-028).
    await queryInterface.sequelize.query(
      `INSERT INTO permissions (key, description)
       VALUES ('driver.delete', 'Remove a driver from the platform, with a reason')
       ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

       INSERT INTO role_permissions (role_id, permission_key)
       SELECT r.id, 'driver.delete' FROM roles r WHERE r.key = 'SUPER_ADMIN'
       ON CONFLICT DO NOTHING;`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM role_permissions WHERE permission_key = 'driver.delete';
      DELETE FROM permissions WHERE key = 'driver.delete';

      DROP INDEX IF EXISTS ix_drivers_live;

      DROP INDEX IF EXISTS uq_vehicles_registration_live;
      ALTER TABLE vehicles ADD CONSTRAINT uq_vehicles_registration UNIQUE (registration_number);

      -- Restoring the unconditional constraint needs the archived rows gone,
      -- since two of them may share a mobile by then.
      DELETE FROM drivers WHERE deleted_at IS NOT NULL;
      DROP INDEX IF EXISTS uq_drivers_mobile_live;
      ALTER TABLE drivers ADD CONSTRAINT uq_drivers_mobile UNIQUE (mobile);

      ALTER TABLE drivers
        DROP CONSTRAINT ck_drivers_deletion,
        DROP COLUMN deleted_reason,
        DROP COLUMN deleted_at;
    `);
  },
};
