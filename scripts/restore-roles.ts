import process from 'node:process';

import { QueryTypes } from 'sequelize';

import { sequelize } from '../src/db/sequelize';

/**
 * Repairs a database whose `roles` rows have gone missing while the migrations
 * still report `up`, which leaves bootstrap failing with a 500:
 *
 *   Role SUPER_ADMIN is missing. Has migration 004 run?
 *
 * It replays the role inserts and grants from migrations 004, 006, 010 and 017
 * verbatim, so the result is the state a fresh `db:migrate` produces. Every
 * statement is idempotent, so running it on a healthy database changes nothing.
 *
 * Local development only.
 */

/**
 * Migration 006's twelve advertiser-portal keys. Migration 004 granted
 * SUPER_ADMIN every permission that existed *at that point*, which is all of
 * them except these — hence 29 rather than 41.
 */
const ADVERTISER_PORTAL_KEYS = [
  'advertiser.campaign.create',
  'advertiser.campaign.read',
  'advertiser.campaign.confirm',
  'advertiser.vehicle.select',
  'advertiser.vehicle.read',
  'advertiser.tracking.read',
  'advertiser.report.read',
  'advertiser.wallet.read',
  'advertiser.wallet.topup',
  'advertiser.order.place',
  'advertiser.pricing.configure',
  'advertiser.user.read',
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run against production.');
  }

  console.log(`database: ${sequelize.getDatabaseName()}`);

  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `INSERT INTO roles (key, description, is_system) VALUES
         ($1, 'Full platform access. The only admin role in MVP (AC-31).', true),
         ($2, 'Full access to one advertiser account. The only advertiser role in MVP.', true),
         ($3, 'Web login for one driver. Audience, not permissions, gates the portal.', true)
       ON CONFLICT (key) DO NOTHING;`,
      { bind: ['SUPER_ADMIN', 'ADVERTISER', 'DRIVER'], transaction },
    );

    // Migration 004's cross join, minus the keys migration 006 added later.
    await sequelize.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT r.id, p.key
       FROM   roles r CROSS JOIN permissions p
       WHERE  r.key = 'SUPER_ADMIN'
         AND  p.key <> ALL($1::text[])
       ON CONFLICT DO NOTHING;`,
      { bind: [ADVERTISER_PORTAL_KEYS], transaction },
    );

    // Migration 006, reproduced as written — including the fact that its
    // LIKE also matches the three admin keys advertiser.create/read/activate.
    await sequelize.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT r.id, p.key
       FROM   roles r
       JOIN   permissions p ON p.key LIKE 'advertiser.%'
       WHERE  r.key = 'ADVERTISER'
       ON CONFLICT DO NOTHING;`,
      { transaction },
    );
  });

  const summary = await sequelize.query<{ key: string; n: number }>(
    `SELECT r.key, count(rp.permission_key)::int AS n
     FROM   roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
     GROUP  BY r.key ORDER BY r.key;`,
    { type: QueryTypes.SELECT },
  );

  for (const row of summary) console.log(`${row.key}: ${String(row.n)} permissions`);

  await sequelize.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
