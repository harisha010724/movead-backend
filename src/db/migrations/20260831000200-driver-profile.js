'use strict';

/**
 * Migration 021 — the half of AC-04 that lives on the driver's own phone.
 *
 * Three things arrive together because they are the three fields AC-04.1 lists
 * and admin onboarding deliberately does not collect: a home address, payout
 * details, and consent to be tracked.
 *
 * Consent is an append-only log rather than a column. AC-04.3 wants it
 * "explicit, recorded, and timestamped", and AC-04.5 makes it withdrawable —
 * which means the question is never "does this driver consent?" on its own but
 * "did they consent while that kilometre was being billed?". A boolean cannot
 * answer the second one, and by the time anybody asks, the boolean has been
 * overwritten.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TYPE driver_payout_method AS ENUM ('BANK', 'UPI');
      CREATE TYPE driver_consent_kind  AS ENUM ('LOCATION_TRACKING');
      CREATE TYPE driver_consent_action AS ENUM ('GRANTED', 'WITHDRAWN');

      ALTER TABLE drivers
        ADD COLUMN address_line1       TEXT,
        ADD COLUMN address_line2       TEXT,
        ADD COLUMN address_city        TEXT,
        ADD COLUMN address_state       TEXT,
        ADD COLUMN address_pincode     TEXT,
        ADD COLUMN payout_method       driver_payout_method,
        ADD COLUMN bank_account_name   TEXT,
        ADD COLUMN bank_account_number TEXT,
        ADD COLUMN bank_ifsc           TEXT,
        ADD COLUMN upi_id              TEXT;

      -- Format rules, per AC-04.1's "validated for format". They are here as
      -- well as in Zod because a payout that fails at the bank fails days
      -- later, against a driver who has already done the work.
      ALTER TABLE drivers
        ADD CONSTRAINT drivers_pincode_format
          CHECK (address_pincode IS NULL OR address_pincode ~ '^[1-9][0-9]{5}$'),
        ADD CONSTRAINT drivers_ifsc_format
          CHECK (bank_ifsc IS NULL OR bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
        ADD CONSTRAINT drivers_account_number_format
          CHECK (bank_account_number IS NULL OR bank_account_number ~ '^[0-9]{9,18}$'),
        ADD CONSTRAINT drivers_upi_format
          CHECK (upi_id IS NULL OR upi_id ~ '^[a-zA-Z0-9._-]{2,64}@[a-zA-Z]{2,32}$');

      -- A payout method is only chosen once the fields it needs are present.
      -- Half a bank account is worse than none: it looks payable and is not.
      ALTER TABLE drivers
        ADD CONSTRAINT drivers_payout_complete CHECK (
          payout_method IS NULL
          OR (payout_method = 'BANK'
              AND bank_account_name   IS NOT NULL
              AND bank_account_number IS NOT NULL
              AND bank_ifsc           IS NOT NULL)
          OR (payout_method = 'UPI' AND upi_id IS NOT NULL)
        );

      CREATE TABLE driver_consents (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id     UUID NOT NULL REFERENCES drivers(id),
        kind          driver_consent_kind   NOT NULL,
        action        driver_consent_action NOT NULL,
        recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        -- What the driver was shown when they agreed. Consent to a disclosure
        -- nobody kept a version of is not evidence of anything (AC-04.4).
        policy_version TEXT NOT NULL,
        source        TEXT NOT NULL,
        ip            TEXT
      );

      CREATE INDEX idx_driver_consents_current
        ON driver_consents (driver_id, kind, recorded_at DESC);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS driver_consents;

      ALTER TABLE drivers
        DROP CONSTRAINT IF EXISTS drivers_payout_complete,
        DROP CONSTRAINT IF EXISTS drivers_upi_format,
        DROP CONSTRAINT IF EXISTS drivers_account_number_format,
        DROP CONSTRAINT IF EXISTS drivers_ifsc_format,
        DROP CONSTRAINT IF EXISTS drivers_pincode_format,
        DROP COLUMN IF EXISTS upi_id,
        DROP COLUMN IF EXISTS bank_ifsc,
        DROP COLUMN IF EXISTS bank_account_number,
        DROP COLUMN IF EXISTS bank_account_name,
        DROP COLUMN IF EXISTS payout_method,
        DROP COLUMN IF EXISTS address_pincode,
        DROP COLUMN IF EXISTS address_state,
        DROP COLUMN IF EXISTS address_city,
        DROP COLUMN IF EXISTS address_line2,
        DROP COLUMN IF EXISTS address_line1;

      DROP TYPE IF EXISTS driver_consent_action;
      DROP TYPE IF EXISTS driver_consent_kind;
      DROP TYPE IF EXISTS driver_payout_method;
    `);
  },
};
