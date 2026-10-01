/**
 * The platform's civil day.
 *
 * Every date bucket in the API — a dashboard range, a driver's "today", a day
 * of trip history — means a day in Asia/Kolkata, because that is the day the
 * driver drove and the day the operator asking about it is living in.
 *
 * Postgres does the conversion rather than Node, so the boundary does not move
 * with the server's own timezone. That distinction is not academic: on a UTC
 * host, `date_trunc('day', started_at)` files everything earned between
 * midnight and 05:30 IST under the previous day, which is the difference
 * between a driver seeing their morning shift and seeing zero.
 */

export const IST = 'Asia/Kolkata';

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

/** `YYYY-MM-DD` — the Indian calendar day an instant falls on. */
export function todayIst(at: Date = new Date()): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The last campaign day is inclusive. After that Indian date the flight is
 * over, even if nobody has pressed Complete yet.
 */
export function campaignDateHasLapsed(endDate: string, at: Date = new Date()): boolean {
  return todayIst(at) > String(endDate).slice(0, 10);
}

/**
 * A running campaign whose last Indian day has passed reads as completed.
 *
 * The stored row stays where it is so a GET cannot fire complete() side
 * effects (vehicle release, inbox flood). Only live-looking statuses lapse;
 * a brief still in review stays in review even if the printed dates are old.
 */
export function effectiveCampaignStatus<T extends string>(
  status: T,
  endDate: string,
  at: Date = new Date(),
): T | 'COMPLETED' {
  if (
    (status === 'ACTIVE' || status === 'PAUSED' || status === 'BUDGET_WARNING') &&
    campaignDateHasLapsed(endDate, at)
  ) {
    return 'COMPLETED';
  }
  return status;
}

/**
 * The civil date a timestamp column falls on.
 *
 * Binds the zone as `:zone`, so every caller must pass `{ zone: IST }` in its
 * replacements. That is deliberate — an interpolated timezone is one edit away
 * from being interpolated from a request.
 */
export function istDate(column: string): string {
  return `(${column} AT TIME ZONE :zone)::date`;
}

/** The civil month a timestamp column falls in, for month-to-date totals. */
export function istMonth(column: string): string {
  return `date_trunc('month', ${column} AT TIME ZONE :zone)`;
}

/**
 * Which of the week's 168 hours a timestamp falls in, Monday 00:00 being 0.
 *
 * Traffic repeats weekly, not daily: a Tuesday evening and a Sunday evening on
 * the same road are different roads as far as congestion goes. Bucketing by
 * hour-of-day alone would average the two into a figure describing neither.
 */
export function istHourOfWeek(column: string): string {
  const local = `${column} AT TIME ZONE :zone`;

  return `((EXTRACT(ISODOW FROM ${local})::int - 1) * 24 + EXTRACT(HOUR FROM ${local})::int)`;
}
