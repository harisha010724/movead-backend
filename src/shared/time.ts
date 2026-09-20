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
