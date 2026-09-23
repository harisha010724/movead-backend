'use strict';

/**
 * Migration 023 — free-flow speed baselines: the fleet as its own traffic
 * sensor.
 *
 * What a road's traffic is like at a given hour is ordinarily bought, from a
 * congestion feed or a traffic-volume dataset. It does not have to be. Every
 * billable segment already records how far a vehicle went and how long it
 * took, so the fleet is measuring the road every time it drives down it. The
 * 85th percentile of those observations, per cell per hour of the week, is
 * what the road looks like when it is clear — and a later vehicle's speed
 * against that reference is how congested it was at the time.
 *
 * This table is a derived cache and nothing else. Every row can be rebuilt
 * from `trip_segments` and `gps_points` by re-running the job that fills it,
 * and nothing bills off it. That is why it carries no foreign keys and why the
 * recompute is free to delete the lot and start again.
 *
 * `hour_of_week` is nullable on purpose. A row with an hour is the reading for
 * that cell in that hour; a row without one is the same cell across the whole
 * week, which is what a thinly-sampled hour falls back to before it falls back
 * to a flat per-zone default. Two partial unique indexes rather than one
 * composite, because `NULL` does not collide with itself in a unique index and
 * a cell would otherwise be free to accumulate any number of all-week rows.
 *
 * Both rungs are stored regardless of how thin the sample is, and the minimum
 * sample size is applied when the row is read rather than when it is written.
 * A floor enforced on write would mean changing the floor requires a full
 * recompute; enforced on read it is one constant in the service.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE speed_baselines (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        -- 'latIndex:lngIndex' at a hundredth of a degree. Computed by
        -- src/shared/geo.ts, in Node and in SQL, from the same constant.
        grid_key      TEXT NOT NULL,

        -- 0 = Monday 00:00 IST, 167 = Sunday 23:00. NULL = the whole week.
        hour_of_week  SMALLINT CHECK (hour_of_week BETWEEN 0 AND 167),

        free_flow_kmh NUMERIC(6,2) NOT NULL CHECK (free_flow_kmh > 0),

        -- How many segments the percentile was taken over. Read alongside the
        -- speed, never without it: a baseline from four observations and one
        -- from four thousand are not the same claim.
        sample_count  INTEGER NOT NULL CHECK (sample_count > 0),

        computed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX uq_speed_baseline_cell_hour
        ON speed_baselines (grid_key, hour_of_week) WHERE hour_of_week IS NOT NULL;

      CREATE UNIQUE INDEX uq_speed_baseline_cell
        ON speed_baselines (grid_key) WHERE hour_of_week IS NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS speed_baselines;
    `);
  },
};
