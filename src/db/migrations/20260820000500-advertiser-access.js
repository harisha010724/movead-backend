'use strict';

/**
 * Migration 006 — advertiser portal access.
 *
 * The permission catalogue in migration 004 is entirely admin actions, because
 * admin was the only portal that existed. AC-33 lists what an advertiser may
 * do, and those need keys of their own before an advertiser user can be
 * granted anything.
 *
 * Two properties matter more than the list itself:
 *
 *   Advertiser permissions are a disjoint set. No key is shared with the admin
 *   catalogue, so `requirePermission('campaign.approve')` can never accidentally
 *   pass for an advertiser — even before the audience check runs (WEB-001).
 *
 *   Scope is not a permission. `advertiser.campaign.read` says an advertiser may
 *   read campaigns; it says nothing about *whose*. That is enforced by
 *   `users.advertiser_id`, checked before permissions rather than after
 *   (ADV-002), because a permission the whole role holds cannot express "only
 *   my own rows".
 */

const ADVERTISER_PERMISSIONS = [
  ['advertiser.campaign.create', 'Create a campaign for their own account (AC-01)'],
  ['advertiser.campaign.read', 'View their own campaigns'],
  ['advertiser.campaign.confirm', 'Confirm a campaign admin created on their behalf (AC-34.4)'],
  ['advertiser.vehicle.select', 'Request vehicles for a campaign (AC-22.4)'],
  ['advertiser.vehicle.read', 'View vehicles assigned to their campaigns'],
  ['advertiser.tracking.read', 'Track their own vehicles on a live map'],
  ['advertiser.report.read', 'View and export reports for their own campaigns'],
  ['advertiser.wallet.read', 'View the wallet balance and ledger'],
  ['advertiser.wallet.topup', 'Add funds to the prepaid wallet (AC-26)'],
  ['advertiser.order.place', 'Place an order, committing budget from the wallet'],
  ['advertiser.pricing.configure', 'Configure zone pricing for their campaigns (AC-02)'],
  ['advertiser.user.read', 'View users on their own advertiser account'],
];

/**
 * One role for MVP, mirroring AC-31.2's single Super Admin. Splitting it into
 * a viewer and a buyer is a data change, exactly as it is on the admin side.
 */
const ADVERTISER_ROLE = 'ADVERTISER';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(
        `INSERT INTO permissions (key, description)
         SELECT * FROM UNNEST($1::text[], $2::text[])
         ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;`,
        {
          bind: [
            ADVERTISER_PERMISSIONS.map(([key]) => key),
            ADVERTISER_PERMISSIONS.map(([, text]) => text),
          ],
          transaction,
        },
      );

      await sequelize.query(
        `INSERT INTO roles (key, description, is_system)
         VALUES ($1, $2, true)
         ON CONFLICT (key) DO NOTHING;`,
        {
          bind: [
            ADVERTISER_ROLE,
            'Full access to one advertiser account. The only advertiser role in MVP.',
          ],
          transaction,
        },
      );

      // Only the advertiser keys. Migration 004's "every permission" grant to
      // SUPER_ADMIN must not be repeated here, or the two roles would collapse
      // into one and WEB-001 would have nothing left to separate.
      await sequelize.query(
        `INSERT INTO role_permissions (role_id, permission_key)
         SELECT r.id, p.key
         FROM   roles r
         JOIN   permissions p ON p.key LIKE 'advertiser.%'
         WHERE  r.key = $1
         ON CONFLICT DO NOTHING;`,
        { bind: [ADVERTISER_ROLE], transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DELETE FROM role_permissions WHERE permission_key LIKE 'advertiser.%';
       DELETE FROM roles WHERE key = $1;
       DELETE FROM permissions WHERE key LIKE 'advertiser.%';`,
      { bind: [ADVERTISER_ROLE] },
    );
  },
};
