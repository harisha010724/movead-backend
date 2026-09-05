import Decimal from 'decimal.js';

/**
 * Money handling for the whole platform. Nothing else may do arithmetic on a
 * rupee value (architecture Part 9.1).
 *
 * The rules, in short:
 *   - the database holds NUMERIC, `pg` hands it back as a string;
 *   - every calculation happens in `Decimal`;
 *   - a value re-enters the world as a string, never as a `number`.
 *
 * A float never appears in the chain. `0.1 + 0.2` is the reason.
 */

Decimal.set({
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP,
  // Keep plain notation across every magnitude a payout could reach; a rupee
  // amount rendered as "1e+21" would be a valid Decimal and an invalid NUMERIC.
  toExpNeg: -9,
  toExpPos: 21,
});

/** An exact decimal string, e.g. `"1284.5000"`. Never a `number`. */
export type Money = string;

/** `NUMERIC(14,4)` — what the ledger stores. */
export const LEDGER_SCALE = 4;
/** Two decimals: what can actually be transferred to a bank account. */
export const PAYABLE_SCALE = 2;

export const ZERO = new Decimal(0);

export function money(value: Money | number | Decimal): Decimal {
  const decimal = new Decimal(value);
  if (!decimal.isFinite()) throw new TypeError(`Not a finite money value: ${String(value)}`);
  return decimal;
}

/** Serialise at ledger scale — for anything written to or read from NUMERIC. */
export function toLedger(value: Decimal): Money {
  return value.toFixed(LEDGER_SCALE);
}

/**
 * Serialise at payable scale, rounding half up. Use only where money leaves
 * the system — a transfer instruction, an invoice line — because rounding
 * early and then summing is how a ledger stops reconciling.
 */
export function toPayable(value: Decimal): Money {
  return value.toFixed(PAYABLE_SCALE);
}

export function sum(values: (Money | Decimal)[]): Decimal {
  return values.reduce<Decimal>((total, value) => total.plus(money(value)), ZERO);
}

/**
 * The platform's one pricing primitive: distance times rate.
 *
 * Rounded once, at ledger scale, at the point the allocation row is written —
 * so the advertiser debit and the driver credit are derived from the same
 * rounded figures rather than from two independent roundings of a longer one.
 */
export function amountFor(distanceKm: Money | Decimal, ratePerKm: Money | Decimal): Money {
  return toLedger(money(distanceKm).times(money(ratePerKm)));
}
