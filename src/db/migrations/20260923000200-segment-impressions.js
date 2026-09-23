'use strict';

/**
 * Migration 024 — the modelled audience for a segment that has already been
 * priced.
 *
 * Deliberately not a set of columns on `trip_segments`. That table's promise
 * is the one migration 020 spells out: a kilometre carries the rates in force
 * when it was driven, and nothing recomputes it. Impressions are the opposite
 * kind of number — a model output that is expected to improve — and holding
 * the two in one row forces a choice between freezing a figure known to be
 * improvable and restating rows in the table whose entire value is that it
 * never restates.
 *
 * Keyed by segment *and* model version, so improving the model is an insert
 * rather than an update. Every figure an advertiser has already been shown
 * stays exactly as it was shown, a campaign can be pinned to the version it
 * was sold on, and two versions can be compared over the same driving before
 * anyone is asked to move to the newer one.
 *
 * Every input is stored beside the output, which is the whole point. A
 * disputed number six weeks later is answered by reading one row — not by
 * re-running the model and hoping the coefficients have not moved underneath
 * it. The row is the evidence; the code is only how it got there.
 *
 * Rows exist only for billable segments. An impression is a claim about an
 * advertisement someone was charged for, so a kilometre the platform declined
 * to bill is not a kilometre it should be reporting an audience for.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE segment_impressions (
        segment_id    UUID NOT NULL REFERENCES trip_segments(id) ON DELETE CASCADE,

        -- Which set of assumptions produced this. src/impressions/coefficients.ts.
        model_version TEXT NOT NULL,

        impressions   NUMERIC(14,4) NOT NULL CHECK (impressions >= 0),

        -- The inputs, in the order the model applies them. Stored as computed
        -- rather than as configured: a coefficient can be looked up in the
        -- source, but what it was multiplied by cannot be.
        vehicles_per_km        NUMERIC(10,2) NOT NULL CHECK (vehicles_per_km >= 0),
        in_vehicle_persons_km  NUMERIC(10,2) NOT NULL CHECK (in_vehicle_persons_km >= 0),
        pedestrian_density     NUMERIC(10,2) NOT NULL CHECK (pedestrian_density >= 0),
        persons_present_km     NUMERIC(10,2) NOT NULL CHECK (persons_present_km >= 0),
        line_of_sight_share    NUMERIC(5,4)  NOT NULL CHECK (line_of_sight_share BETWEEN 0 AND 1),
        wrap_quality           NUMERIC(5,4)  NOT NULL CHECK (wrap_quality BETWEEN 0 AND 1),
        daypart_factor         NUMERIC(5,4)  NOT NULL CHECK (daypart_factor BETWEEN 0 AND 1),

        -- The speed comparison the density was read from, kept so the
        -- congestion claim can be checked without recomputing it.
        observed_kmh  NUMERIC(8,2) NOT NULL CHECK (observed_kmh >= 0),
        baseline_kmh  NUMERIC(8,2) NOT NULL CHECK (baseline_kmh > 0),

        -- Which rung of the fallback ladder the baseline came from. A figure
        -- resting on a per-zone default is a weaker claim than one resting on
        -- four thousand observations of that cell in that hour, and an
        -- advertiser reading the working is entitled to know which it has.
        --
        -- A CHECK rather than an enum type: this is diagnostic provenance, not
        -- a state a row moves through, and it should be free to gain a rung
        -- without a migration that rewrites a type.
        baseline_source TEXT NOT NULL
          CHECK (baseline_source IN ('CELL_HOUR','CELL','ZONE_DEFAULT')),

        computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

        PRIMARY KEY (segment_id, model_version)
      );

      -- The recompute asks "which billable segments have no row at this
      -- version yet", which is an anti-join on exactly this pair.
      CREATE INDEX ix_segment_impressions_version
        ON segment_impressions (model_version, segment_id);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS segment_impressions;
    `);
  },
};
