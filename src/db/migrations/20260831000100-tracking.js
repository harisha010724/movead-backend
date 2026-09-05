'use strict';

/**
 * Migration 020 — the tracking pipeline: sessions, GPS points, and the
 * classified segments that turn a drive into money.
 *
 * This is the table set AC-00 rests on. Every rupee on an invoice and every
 * rupee in a payout has to be traceable back to the GPS that produced it, so
 * the aggregate is never stored without its components: a segment carries its
 * own distance, its own zone, the rates in force when it was driven, and both
 * sides of the money. Totals are sums over these rows and are never written
 * anywhere as a figure in their own right.
 *
 * Three rules are enforced here rather than in a service, because these are
 * the ones that cost money when they break:
 *
 *   AC-08.6 / AC-16.6 — one active session per driver, and one per vehicle.
 *   Partial unique indexes, so a second phone or a replayed start cannot open
 *   a parallel session and bill the same journey twice.
 *
 *   AC-19.4 / AC-16.10 — offline sync is idempotent. A fix carries the id the
 *   phone gave it, unique within its session, so re-uploading a batch that
 *   already landed stores nothing new. The phone deletes its buffer only on a
 *   confirmed 2xx, which means it re-sends whenever a response is lost.
 *
 *   AC-16.3 / AC-16.9 — a pair of points yields its parts exactly once. A
 *   unique key over (from, to, part) makes a duplicate kilometre a constraint
 *   violation rather than an accounting discrepancy nobody notices.
 *
 * PostGIS is still not here, for the reasons migration 001 gives. The geometry
 * this needs — great-circle distance and clipping a segment against a polygon
 * edge — is a few dozen lines in `src/shared/geo.ts`, and keeping it in
 * process means the calculation is unit-testable without a database.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TYPE tracking_session_status AS ENUM ('ACTIVE','ENDED');

      /* AC-11.1. The thresholds themselves are configuration, not schema. */
      CREATE TYPE gps_quality AS ENUM ('ELIGIBLE','QUESTIONABLE','REJECTED');

      CREATE TYPE segment_zone AS ENUM ('PRIME','SECONDARY','NETWORK');

      /*
       * Whether this distance is money, and if not, why not.
       *
       * Kept separate from the zone because quality and geography are
       * independent: collapsing them into one field, as AC-13.1's list of four
       * classifications reads, would leave no way to say which zone a held
       * kilometre was driven in — and that is exactly what a reviewer needs in
       * order to release it.
       */
      CREATE TYPE segment_state AS ENUM ('BILLABLE','PENDING_REVIEW','NON_BILLABLE');

      CREATE TABLE tracking_sessions (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id           UUID NOT NULL REFERENCES drivers(id),
        vehicle_id          UUID NOT NULL REFERENCES vehicles(id),
        campaign_id         UUID NOT NULL REFERENCES campaigns(id),
        -- The assignment this session earns against, so a segment can be tied
        -- to the exact booking even after the vehicle moves to another campaign.
        campaign_vehicle_id UUID NOT NULL REFERENCES campaign_vehicles(id),
        status              tracking_session_status NOT NULL DEFAULT 'ACTIVE',

        -- AC-08.5: the billing boundary. AC-08.7: a session begun with no
        -- signal keeps its *local* start when it finally syncs, because the
        -- driver was already driving; upload time must not move the boundary.
        started_at          TIMESTAMPTZ NOT NULL,
        ended_at            TIMESTAMPTZ,
        end_reason          TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT ck_session_ended CHECK ((status = 'ENDED') = (ended_at IS NOT NULL))
      );

      -- AC-08.6: "on one device or across devices" — which is only true if the
      -- database says so. AC-16.6 says the same thing about the vehicle.
      CREATE UNIQUE INDEX uq_driver_active_session
        ON tracking_sessions (driver_id) WHERE status = 'ACTIVE';
      CREATE UNIQUE INDEX uq_vehicle_active_session
        ON tracking_sessions (vehicle_id) WHERE status = 'ACTIVE';

      CREATE INDEX ix_sessions_campaign ON tracking_sessions (campaign_id, started_at);

      CREATE TABLE gps_points (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id        UUID NOT NULL REFERENCES tracking_sessions(id) ON DELETE CASCADE,

        -- The id the phone minted for this fix. AC-19.4.
        client_point_id   UUID NOT NULL,

        -- AC-19.3: when it was captured, which is what it bills against.
        -- received_at is when it reached us, and is diagnostic only.
        recorded_at       TIMESTAMPTZ NOT NULL,
        received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

        lat               NUMERIC(10,7) NOT NULL,
        lon               NUMERIC(10,7) NOT NULL,
        accuracy_m        NUMERIC(8,2) NOT NULL,
        speed_mps         NUMERIC(8,2),
        heading_deg       NUMERIC(6,2),

        -- AC-18: the operating system's own mock-location flag, carried
        -- through rather than trusted away.
        is_mock           BOOLEAN NOT NULL DEFAULT false,

        -- AC-11.5: the classification is stored, so a threshold change can be
        -- reasoned about against what was decided at the time.
        quality           gps_quality NOT NULL,

        -- AC-10.5: what the handset thought the distance was. Kept for
        -- comparison and never used to bill (AC-10.4).
        device_distance_m NUMERIC(12,2),

        CONSTRAINT uq_gps_point_client UNIQUE (session_id, client_point_id)
      );

      CREATE INDEX ix_gps_points_session_time ON gps_points (session_id, recorded_at);

      CREATE TABLE trip_segments (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id        UUID NOT NULL REFERENCES tracking_sessions(id) ON DELETE CASCADE,

        -- Denormalised so the driver's earnings and the campaign's spend are
        -- each one index lookup, and so both survive the session being purged.
        campaign_id       UUID NOT NULL REFERENCES campaigns(id),
        driver_id         UUID NOT NULL REFERENCES drivers(id),
        vehicle_id        UUID NOT NULL REFERENCES vehicles(id),

        from_point_id     UUID NOT NULL REFERENCES gps_points(id) ON DELETE CASCADE,
        to_point_id       UUID NOT NULL REFERENCES gps_points(id) ON DELETE CASCADE,

        -- AC-21: one pair of fixes crossing a zone edge produces several
        -- segments, one per zone, in travel order.
        part_index        SMALLINT NOT NULL DEFAULT 0,

        started_at        TIMESTAMPTZ NOT NULL,
        ended_at          TIMESTAMPTZ NOT NULL,

        distance_km       NUMERIC(12,6) NOT NULL CHECK (distance_km >= 0),
        zone              segment_zone NOT NULL,
        state             segment_state NOT NULL,

        -- AC-14.4 and AC-15.4: the rates *in force at the time of travel*,
        -- written onto the row. A later rate change cannot reprice a kilometre
        -- that has already been driven, because nothing recomputes this.
        advertiser_rate   NUMERIC(8,4) NOT NULL CHECK (advertiser_rate >= 0),
        driver_rate       NUMERIC(8,4) NOT NULL CHECK (driver_rate >= 0),
        advertiser_charge NUMERIC(14,4) NOT NULL CHECK (advertiser_charge >= 0),
        driver_earning    NUMERIC(14,4) NOT NULL CHECK (driver_earning >= 0),

        -- AC-12.3: whether this pair spans a point that was thrown away. The
        -- choice has to be recorded on the segment, not merely made.
        bridged           BOOLEAN NOT NULL DEFAULT false,

        -- AC-18.3: which rule held it, and on what evidence.
        flag_reason       TEXT,

        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

        -- AC-16.3: the pair is consumed. A replayed batch cannot mint a second
        -- copy of a kilometre that has already been allocated.
        CONSTRAINT uq_trip_segment_part UNIQUE (from_point_id, to_point_id, part_index),

        -- AC-07.2, AC-11.4, AC-18.2: anything not billable carries no money at
        -- all. Not "is not paid out" as a matter of process — cannot hold a
        -- non-zero amount as a matter of schema.
        CONSTRAINT ck_segment_money CHECK (
          state = 'BILLABLE' OR (advertiser_charge = 0 AND driver_earning = 0)),

        CONSTRAINT ck_segment_flagged CHECK (
          state <> 'PENDING_REVIEW' OR flag_reason IS NOT NULL),

        CONSTRAINT ck_segment_order CHECK (ended_at >= started_at)
      );

      CREATE INDEX ix_trip_segments_session  ON trip_segments (session_id, started_at);
      CREATE INDEX ix_trip_segments_campaign ON trip_segments (campaign_id, state);
      CREATE INDEX ix_trip_segments_driver   ON trip_segments (driver_id, started_at);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS trip_segments;
      DROP TABLE IF EXISTS gps_points;
      DROP TABLE IF EXISTS tracking_sessions;

      DROP TYPE IF EXISTS segment_state;
      DROP TYPE IF EXISTS segment_zone;
      DROP TYPE IF EXISTS gps_quality;
      DROP TYPE IF EXISTS tracking_session_status;
    `);
  },
};
