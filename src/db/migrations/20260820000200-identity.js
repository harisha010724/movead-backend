'use strict';

/**
 * Migration 003 — identity and access.
 *
 * Staff and advertiser users, the permission graph, web sessions and the audit
 * trail. Drivers authenticate by mobile and OTP and share none of this except
 * the audit log (database design Part 4).
 *
 * Two tables here are additions to the published design, both recorded in
 * MoveAd-Database-Design.md §4.5:
 *
 *   user_sessions   The design covers driver refresh tokens but not web
 *                   sessions, which architecture Part 12.1 requires to be
 *                   httpOnly cookies with an idle timeout. An opaque,
 *                   server-side session is what makes "log this admin out
 *                   now" possible; a self-contained JWT cannot be revoked.
 *   login_attempts  Not a table — brute-force state lives on `users`
 *                   (`failed_attempts`, `locked_until`), exactly as designed.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TYPE user_status AS ENUM ('INVITED','ACTIVE','SUSPENDED','DISABLED');

      CREATE TABLE users (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email            CITEXT      NOT NULL,
        password_hash    TEXT        NOT NULL,
        full_name        TEXT        NOT NULL,
        -- NULL for staff; set for advertiser-portal users.
        advertiser_id    UUID        REFERENCES advertisers(id),
        totp_secret_enc  BYTEA,
        totp_enabled_at  TIMESTAMPTZ,
        status           user_status NOT NULL DEFAULT 'INVITED',
        last_login_at    TIMESTAMPTZ,
        failed_attempts  SMALLINT    NOT NULL DEFAULT 0,
        locked_until     TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT uq_users_email UNIQUE (email),
        CONSTRAINT ck_users_attempts CHECK (failed_attempts >= 0)
      );

      CREATE INDEX ix_users_advertiser ON users (advertiser_id) WHERE advertiser_id IS NOT NULL;

      -- AC-31 collapses admin to one Super Admin role; ADM-028 requires that
      -- to be reversible. Storing permissions from day one makes reintroducing
      -- granular roles a data change rather than an edit to every route.
      CREATE TABLE permissions (
        key         TEXT PRIMARY KEY,
        description TEXT NOT NULL
      );

      CREATE TABLE roles (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key         TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        is_system   BOOLEAN NOT NULL DEFAULT false
      );

      CREATE TABLE role_permissions (
        role_id        UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        permission_key TEXT NOT NULL REFERENCES permissions(key),
        PRIMARY KEY (role_id, permission_key)
      );

      CREATE TABLE user_roles (
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_id    UUID NOT NULL REFERENCES roles(id),
        granted_by UUID REFERENCES users(id),
        granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, role_id)
      );

      -- Web portal sessions. The cookie holds an opaque random token; only its
      -- SHA-256 is stored, so a database leak does not hand over live sessions.
      CREATE TABLE user_sessions (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash    TEXT NOT NULL UNIQUE,
        -- WEB-001 at the session layer: an advertiser session presented to an
        -- admin endpoint is rejected before any permission is consulted.
        audience      TEXT NOT NULL CHECK (audience IN ('admin','advertiser')),
        issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        -- Slides forward on use. Idle timeout is measured from here; admin
        -- gets a shorter one than advertiser (architecture Part 12.1).
        last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        -- Absolute ceiling. A session that stays busy still ends.
        expires_at    TIMESTAMPTZ NOT NULL,
        revoked_at    TIMESTAMPTZ,
        revoke_reason TEXT,
        ip            INET,
        user_agent    TEXT
      );

      CREATE INDEX ix_sessions_live ON user_sessions (user_id) WHERE revoked_at IS NULL;

      CREATE TABLE audit_log (
        id              BIGSERIAL PRIMARY KEY,
        actor_user_id   UUID REFERENCES users(id),
        -- The FK to drivers is added by the drivers migration; that table does
        -- not exist yet and the audit trail must not wait for it.
        actor_driver_id UUID,
        action          TEXT NOT NULL,
        entity_type     TEXT NOT NULL,
        entity_id       TEXT NOT NULL,
        before          JSONB,
        after           JSONB,
        request_id      TEXT,
        ip              INET,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX ix_audit_entity ON audit_log (entity_type, entity_id, created_at DESC);
      CREATE INDEX ix_audit_actor  ON audit_log (actor_user_id, created_at DESC)
        WHERE actor_user_id IS NOT NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS audit_log;
      DROP TABLE IF EXISTS user_sessions;
      DROP TABLE IF EXISTS user_roles;
      DROP TABLE IF EXISTS role_permissions;
      DROP TABLE IF EXISTS roles;
      DROP TABLE IF EXISTS permissions;
      DROP TABLE IF EXISTS users;
      DROP TYPE IF EXISTS user_status;
    `);
  },
};
