'use strict';

/**
 * Migration 016 — in-app notifications.
 *
 * One row is one audience: either a staff user or a driver, never both
 * (database design Part 12.1). Campaign submission writes one row per
 * active admin so the review queue is not the only place they hear about it.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TYPE notification_kind AS ENUM (
        'TRACKING','EARNING','CAMPAIGN','PAYOUT','VERIFICATION','SYSTEM');

      CREATE TABLE notifications (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id  UUID REFERENCES drivers(id) ON DELETE CASCADE,
        user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
        kind       notification_kind NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT,
        href       TEXT,
        read_at    TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ck_notification_audience CHECK (num_nonnulls(driver_id, user_id) = 1)
      );

      CREATE INDEX ix_notifications_user_unread
        ON notifications (user_id, created_at DESC)
        WHERE read_at IS NULL AND user_id IS NOT NULL;

      CREATE INDEX ix_notifications_driver_unread
        ON notifications (driver_id, created_at DESC)
        WHERE read_at IS NULL AND driver_id IS NOT NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS notifications;
      DROP TYPE IF EXISTS notification_kind;
    `);
  },
};
