import { describe, expect, it } from 'vitest';

import { amountFor, money, sum, toLedger, toPayable } from '../src/pricing/money';

describe('money', () => {
  it('does not drift the way a float would', () => {
    expect(toLedger(sum(['0.1', '0.2']))).toBe('0.3000');
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('prices a segment at ledger scale', () => {
    // 12.345 km at ₹2.75/km = 33.94875, rounded half up at four places.
    expect(amountFor('12.3450', '2.7500')).toBe('33.9488');
  });

  it('rounds half up when money leaves the system', () => {
    expect(toPayable(money('1284.505'))).toBe('1284.51');
    expect(toPayable(money('1284.504'))).toBe('1284.50');
  });

  it('keeps plain notation for amounts a float would render exponentially', () => {
    expect(toLedger(money('0.00001'))).toBe('0.0000');
    expect(toLedger(sum(['99999999.9999', '0.0001']))).toBe('100000000.0000');
  });

  it('refuses a value that is not finite', () => {
    expect(() => money(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => money(Number.NaN)).toThrow(TypeError);
  });
});
