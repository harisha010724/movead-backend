'use strict';

/**
 * Migration 019 — driver mobile sessions.
 *
 * The driver app cannot use the portal's cookie. It holds a short-lived access
 * token in memory and a rotating refresh token in the Keystore, so the same
 * session row now has to serve two very different clients.
 *
 * `client` is what tells them apart, and the difference is not cosmetic. A web
 * session dies after twelve hours and two idle hours because it lives in a
 * browser someone can walk away from. A driver's phone is in their pocket, the
 * app tracks in the background through a shift and is reopened the next
 * morning; applying the browser's rules to it would sign them out daily for no
 * security gained. A mobile session is bounded by the refresh token's own
 * expiry and by revocation instead.
 *
 * Existing rows are all browser sessions, hence the default.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE user_sessions
         ADD COLUMN client TEXT NOT NULL DEFAULT 'web';

       ALTER TABLE user_sessions
         ADD CONSTRAINT user_sessions_client_check
         CHECK (client IN ('web','mobile'));

       -- Only the driver app signs in this way. An admin session created as
       -- 'mobile' would silently opt out of the thirty-minute idle window that
       -- an unattended operations terminal depends on.
       ALTER TABLE user_sessions
         ADD CONSTRAINT user_sessions_mobile_is_driver_check
         CHECK (client = 'web' OR audience = 'driver');`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE user_sessions DROP CONSTRAINT user_sessions_mobile_is_driver_check;
       ALTER TABLE user_sessions DROP CONSTRAINT user_sessions_client_check;
       ALTER TABLE user_sessions DROP COLUMN client;`,
    );
  },
};
