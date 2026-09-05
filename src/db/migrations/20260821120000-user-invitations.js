'use strict';

/**
 * Migration 009 — invitations, so a password is never sent to a customer.
 *
 * An advertiser account is created by operations (AC-32.2), which leaves the
 * question of how the customer first gets in. The obvious answer — the admin
 * picks a password and emails it — has two faults that do not go away with a
 * better email template. A password sent by mail stays in that mailbox in plain
 * text through every forward, backup and export, long after it should have been
 * rotated. And it means a member of staff knows a customer's password, so
 * "only they could have done this" stops being true of an account that is about
 * to hold a funded wallet.
 *
 * Instead the admin creates the account and the platform sends a link. The link
 * carries 256 bits of randomness, is single-use, expires, and the only thing it
 * authorises is choosing a password. Nothing secret is ever in the message.
 *
 * Only the SHA-256 of the token is stored, exactly as with `user_sessions`: a
 * dump of this table cannot be replayed against the live system.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE user_invitations (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- SHA-256 of the token. The token itself exists only in the email.
        token_hash  TEXT        NOT NULL UNIQUE,
        expires_at  TIMESTAMPTZ NOT NULL,
        accepted_at TIMESTAMPTZ,
        -- Set when a resend supersedes this one, so the older link stops working
        -- the moment a newer is issued.
        revoked_at  TIMESTAMPTZ,
        created_by  UUID        REFERENCES users(id),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT ck_invitation_not_both CHECK (
          accepted_at IS NULL OR revoked_at IS NULL)
      );

      /*
       * At most one usable invitation per user, enforced here rather than in
       * application logic. Two live links would mean an invitation that was
       * deliberately superseded still works, which is the whole point of
       * resending after a suspected mis-delivery.
       */
      CREATE UNIQUE INDEX uq_invitation_live ON user_invitations (user_id)
        WHERE accepted_at IS NULL AND revoked_at IS NULL;

      CREATE INDEX ix_invitations_user ON user_invitations (user_id, created_at DESC);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS user_invitations;');
  },
};
