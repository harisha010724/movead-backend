'use strict';

/**
 * Migration 001 — core extensions.
 *
 * Everything else depends on these, so they come first (database design
 * Part 20). Each is load-bearing rather than convenient:
 *
 *   citext      case-insensitive email, so Rahul@x.com and rahul@x.com cannot
 *               both become accounts.
 *   pgcrypto    gen_random_uuid() and digest() for hashing tokens at rest.
 *   btree_gist  lets EXCLUDE constraints mix equality with a range, which is
 *               what stops two rate cards being effective at the same instant.
 *
 * All three are trusted extensions in PostgreSQL 16, so the database owner can
 * install them without superuser rights.
 *
 * PostGIS is deliberately not here. It is not a trusted extension, it needs a
 * separate install on Windows, and nothing before the zones migration has a
 * geography column — so requiring it now would block identity work for a
 * dependency identity does not have.
 */

const EXTENSIONS = ['citext', 'pgcrypto', 'btree_gist'];

module.exports = {
  async up(queryInterface) {
    for (const extension of EXTENSIONS) {
      await queryInterface.sequelize.query(`CREATE EXTENSION IF NOT EXISTS "${extension}";`);
    }
  },

  async down(queryInterface) {
    // Deliberately not dropped. Reversing this would cascade away every column
    // that depends on citext, which is never what an undo is asking for.
    await queryInterface.sequelize.query('SELECT 1;');
  },
};
