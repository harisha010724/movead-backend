'use strict';

/**
 * Migration 004 — the permission catalogue and the Super Admin role.
 *
 * A migration rather than a seeder, because the application depends on these
 * keys existing: `requirePermission('payout.release')` resolves against this
 * data, so an environment missing it is broken rather than merely empty.
 *
 * The list is AC-32's nine admin actions decomposed into the things a check
 * can guard, plus the user-management and audit keys the portal itself needs.
 * Every one is granted to SUPER_ADMIN today (AC-31); the point is that the
 * checks are already written against permissions, so splitting the role later
 * is an INSERT rather than a sweep through every route (ADM-028).
 */

const PERMISSIONS = [
  ['driver.create', 'Create a driver account on their behalf'],
  ['driver.read', 'View driver profiles and onboarding state'],
  ['driver.approve', 'Approve or reject a driver, with a reason'],
  ['driver.suspend', 'Suspend a driver, stopping any active tracking'],

  ['vehicle.read', 'View vehicles and their approval state'],
  ['vehicle.approve', 'Approve or reject a vehicle, with a reason'],
  ['vehicle.suspend', 'Suspend an approved vehicle'],

  ['document.read', 'View uploaded documents'],
  ['document.verify', 'Verify or reject a document, with a reason'],

  ['advertiser.create', 'Create an advertiser account'],
  ['advertiser.read', 'View advertiser accounts'],
  ['advertiser.activate', 'Activate or suspend an advertiser'],

  ['campaign.create', "Create a campaign on an advertiser's behalf"],
  ['campaign.read', 'View campaigns'],
  ['campaign.approve', 'Approve a campaign for launch'],
  ['campaign.assign', 'Assign a campaign to a vehicle'],

  ['installation.review', 'View installation evidence'],
  ['installation.approve', 'Approve or reject an installation, with a reason'],

  ['segment.review', 'Resolve flagged kilometres'],
  ['trip.audit', 'Replay a trip on a map'],

  ['payout.run', 'Prepare a payout run'],
  ['payout.release', 'Release a payout run — requires a second approver'],
  ['wallet.adjust', 'Post a wallet adjustment — requires a second approver'],
  ['rate.change', 'Change a rate card — requires a second approver'],

  ['user.create', 'Create a staff or advertiser user'],
  ['user.read', 'View users'],
  ['user.suspend', 'Suspend a user'],

  ['audit.read', 'Read the audit trail'],
];

const SUPER_ADMIN = 'SUPER_ADMIN';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(
        `INSERT INTO permissions (key, description)
         SELECT * FROM UNNEST($1::text[], $2::text[])
         ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;`,
        {
          bind: [PERMISSIONS.map(([key]) => key), PERMISSIONS.map(([, text]) => text)],
          transaction,
        },
      );

      await sequelize.query(
        `INSERT INTO roles (key, description, is_system)
         VALUES ($1, $2, true)
         ON CONFLICT (key) DO NOTHING;`,
        {
          bind: [SUPER_ADMIN, 'Full platform access. The only admin role in MVP (AC-31).'],
          transaction,
        },
      );

      // Every permission, granted to the one role. Re-runnable, so a later
      // migration that adds permissions can repeat this statement verbatim.
      await sequelize.query(
        `INSERT INTO role_permissions (role_id, permission_key)
         SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
         WHERE  r.key = $1
         ON CONFLICT DO NOTHING;`,
        { bind: [SUPER_ADMIN], transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE key = $1);
       DELETE FROM roles WHERE key = $1;
       DELETE FROM permissions;`,
      { bind: [SUPER_ADMIN] },
    );
  },
};
