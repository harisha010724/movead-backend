import { sequelize } from '../../db/sequelize';
import { gridKeySql } from '../../shared/geo';
import { loggerFor } from '../../shared/logger';
import { IST, istHourOfWeek } from '../../shared/time';

import type { SegmentZone } from '../tracking/tracking.model';

/**
 * Traffic: what a road looks like when it is clear, learned from the fleet's
 * own driving.
 *
 * Nothing here bills. The baselines exist so that a later vehicle's speed can
 * be read as a congestion measurement rather than as a bare number, which is
 * what turns a kilometre into an audience. Every row is derived and every row
 * is disposable — the recompute rebuilds the table from the segments, so the
 * worst a bad run can do is cost one more run.
 */

const log = loggerFor('traffic');

/**
 * Model parameters. Platform-fixed for the pilot and deliberately not
 * environment variables, for the same reason the rate card is not: a number
 * that decides what an advertiser is told should not differ between two
 * deployments of the same version.
 */

/**
 * The 85th percentile, not the maximum.
 *
 * The maximum of a cell's observations is whoever was speeding through it at
 * 3 a.m., and a reference speed that is really one outlier makes every
 * subsequent vehicle look congested. The 85th percentile is the long-standing
 * convention in traffic engineering for the same reason — it is the fast end
 * of normal rather than the fastest thing that happened.
 */
export const FREE_FLOW_PERCENTILE = 0.85;

/**
 * How many observations a baseline needs before it is allowed to describe a
 * road.
 *
 * Applied on read, so lowering it does not require a recompute. A cell-hour
 * below this falls through to the cell's whole-week figure, and a cell below
 * it falls through to a flat per-zone default.
 */
export const MIN_SAMPLES = 30;

/**
 * Below this, the cell is a car park rather than a road, and its "free-flow"
 * speed describes nothing. Such rows are not written at all, so the cell falls
 * through the ladder instead of anchoring against a number near zero.
 */
export const MIN_CREDIBLE_KMH = 1;

/**
 * The bottom rung: what to assume about a road nobody has driven enough yet.
 *
 * Per zone rather than one figure, because the zones already encode roughly
 * this distinction — Prime is the dense centre and Network is everything
 * outside it, and their uncongested speeds are not the same. Crude, and
 * signposted as crude by the `ZONE_DEFAULT` source on every reading that uses
 * it, so a number resting on this can be told apart from one resting on
 * measurement.
 */
export const FALLBACK_FREE_FLOW_KMH: Record<SegmentZone, number> = {
  PRIME: 34,
  SECONDARY: 42,
  NETWORK: 55,
};

/** Which rung of the ladder a reading came from. */
export type BaselineSource = 'CELL_HOUR' | 'CELL' | 'ZONE_DEFAULT';

export interface Baseline {
  freeFlowKmh: number;
  source: BaselineSource;
  /** Zero when the reading is a default rather than a measurement. */
  sampleCount: number;
}

export interface BaselineRow {
  freeFlowKmh: number;
  sampleCount: number;
}

/**
 * The fallback ladder, kept pure so it can be argued with in a unit test.
 *
 * Order matters and is the whole point: the most specific reading that is
 * backed by enough observations wins, and a thin reading loses to a broader
 * one rather than to nothing. A cell-hour with four samples is worse evidence
 * than the same cell across the week with four thousand.
 */
export function resolveBaseline(
  cellHour: BaselineRow | null,
  cell: BaselineRow | null,
  zone: SegmentZone,
): Baseline {
  if (cellHour && cellHour.sampleCount >= MIN_SAMPLES) {
    return {
      freeFlowKmh: cellHour.freeFlowKmh,
      source: 'CELL_HOUR',
      sampleCount: cellHour.sampleCount,
    };
  }

  if (cell && cell.sampleCount >= MIN_SAMPLES) {
    return { freeFlowKmh: cell.freeFlowKmh, source: 'CELL', sampleCount: cell.sampleCount };
  }

  return {
    freeFlowKmh: FALLBACK_FREE_FLOW_KMH[zone],
    source: 'ZONE_DEFAULT',
    sampleCount: 0,
  };
}

export interface BaselineLookup {
  for(gridKey: string, hourOfWeek: number, zone: SegmentZone): Baseline;
}

/**
 * Every baseline for a set of cells, in one query.
 *
 * Batched rather than per-segment because the caller is pricing thousands of
 * 20-metre hops at a time, and a round trip each would make the impression
 * model slower than the pipeline that feeds it.
 */
export async function loadBaselines(gridKeys: readonly string[]): Promise<BaselineLookup> {
  const keys = [...new Set(gridKeys)];
  const byCellHour = new Map<string, BaselineRow>();
  const byCell = new Map<string, BaselineRow>();

  if (keys.length > 0) {
    const rows = (await sequelize.query(
      `SELECT grid_key, hour_of_week, free_flow_kmh, sample_count
         FROM speed_baselines
        WHERE grid_key IN (:keys)`,
      { replacements: { keys }, type: 'SELECT' },
    )) as {
      grid_key: string;
      hour_of_week: number | null;
      free_flow_kmh: string;
      sample_count: number;
    }[];

    for (const row of rows) {
      const entry = {
        freeFlowKmh: Number(row.free_flow_kmh),
        sampleCount: Number(row.sample_count),
      };

      if (row.hour_of_week === null) byCell.set(row.grid_key, entry);
      else byCellHour.set(`${row.grid_key}|${row.hour_of_week}`, entry);
    }
  }

  return {
    for(gridKey, hourOfWeek, zone) {
      return resolveBaseline(
        byCellHour.get(`${gridKey}|${hourOfWeek}`) ?? null,
        byCell.get(gridKey) ?? null,
        zone,
      );
    },
  };
}

/**
 * Which segments are allowed to describe a road.
 *
 * `BILLABLE` does most of the work here, and does it for free: a segment only
 * reaches that state having already survived the mock-location check, the
 * accuracy threshold and the implausible-speed rule, so the observations that
 * feed the baseline are exactly the ones the platform was willing to pay for.
 * Anything it would not pay for, it should not learn from either.
 *
 * Bridged segments are excluded separately. Their two ends are real but a
 * discarded fix sits between them, so the straight line understates the
 * distance and therefore the speed — which would drag a cell's reference
 * downward and make every later vehicle look freer than it was.
 *
 * The cell is taken from the segment's starting fix rather than its midpoint.
 * Over 20 metres the difference almost never crosses a 1.1 km cell boundary,
 * and the starting fix is a stored coordinate rather than a computed one.
 */
const OBSERVED_SEGMENTS = `
  SELECT ${gridKeySql('p.lat', 'p.lon')} AS grid_key,
         ${istHourOfWeek('s.started_at')} AS hour_of_week,
         s.distance_km / (EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) / 3600.0) AS kmh
    FROM trip_segments s
    JOIN gps_points p ON p.id = s.from_point_id
   WHERE s.state = 'BILLABLE'
     AND s.bridged = false
     AND s.distance_km > 0
     AND s.ended_at > s.started_at
`;

const INSERT_CELL_HOURS = `
  INSERT INTO speed_baselines (grid_key, hour_of_week, free_flow_kmh, sample_count)
  SELECT grid_key,
         hour_of_week::smallint,
         percentile_cont(:percentile) WITHIN GROUP (ORDER BY kmh),
         COUNT(*)::int
    FROM (${OBSERVED_SEGMENTS}) observed
   GROUP BY grid_key, hour_of_week
  HAVING percentile_cont(:percentile) WITHIN GROUP (ORDER BY kmh) >= :minKmh
`;

const INSERT_CELLS = `
  INSERT INTO speed_baselines (grid_key, hour_of_week, free_flow_kmh, sample_count)
  SELECT grid_key,
         NULL::smallint,
         percentile_cont(:percentile) WITHIN GROUP (ORDER BY kmh),
         COUNT(*)::int
    FROM (${OBSERVED_SEGMENTS}) observed
   GROUP BY grid_key
  HAVING percentile_cont(:percentile) WITHIN GROUP (ORDER BY kmh) >= :minKmh
`;

export interface RecomputeResult {
  cellHours: number;
  cells: number;
}

/**
 * Rebuild every baseline from the segments behind them.
 *
 * Delete-then-insert rather than an upsert, because the table is a cache of a
 * query and the query's answer can shrink: a cell whose observations have aged
 * out should lose its row, not keep a stale one indefinitely. Both statements
 * run in one transaction, so a reader mid-recompute sees the previous set
 * rather than an empty table, and a failed run leaves the old answers in place.
 *
 * Safe to run twice, which the queue requires of everything: the result
 * depends only on the segments, never on what the table already held.
 */
export async function recomputeBaselines(): Promise<RecomputeResult> {
  const replacements = { zone: IST, percentile: FREE_FLOW_PERCENTILE, minKmh: MIN_CREDIBLE_KMH };

  const result = await sequelize.transaction(async (transaction) => {
    await sequelize.query('DELETE FROM speed_baselines', { transaction });
    await sequelize.query(INSERT_CELL_HOURS, { replacements, transaction });
    await sequelize.query(INSERT_CELLS, { replacements, transaction });

    // Counted rather than read off the inserts: what a raw INSERT hands back
    // differs by dialect, and these figures are worth having be exactly right
    // since they are the only signal that a run did anything.
    const rows = (await sequelize.query(
      `SELECT COUNT(*) FILTER (WHERE hour_of_week IS NOT NULL)::int AS cell_hours,
              COUNT(*) FILTER (WHERE hour_of_week IS NULL)::int     AS cells
         FROM speed_baselines`,
      { type: 'SELECT', transaction },
    )) as { cell_hours: number; cells: number }[];

    return { cellHours: rows[0]?.cell_hours ?? 0, cells: rows[0]?.cells ?? 0 };
  });

  log.info(result, 'speed baselines recomputed');
  return result;
}
