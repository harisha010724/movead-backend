import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from '../src/contracts';
import { MoneySchema, TimestampSchema } from '../src/contracts/common';

describe('openapi document', () => {
  it('builds and describes the health probes', () => {
    const document = buildOpenApiDocument();

    expect(document.openapi).toBe('3.1.0');
    expect(document.paths?.['/health/live']).toBeDefined();
    expect(document.paths?.['/health/ready']).toBeDefined();
  });

  it('publishes the shared primitives as components clients can reference', () => {
    const schemas = buildOpenApiDocument().components?.schemas ?? {};

    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining(['Money', 'Timestamp', 'LatLng', 'Error']),
    );
  });
});

describe('money on the wire', () => {
  it('accepts exact decimal strings and rejects a JSON number', () => {
    expect(MoneySchema.safeParse('1284.50').success).toBe(true);
    expect(MoneySchema.safeParse('0').success).toBe(true);
    expect(MoneySchema.safeParse('-12.3456').success).toBe(true);

    expect(MoneySchema.safeParse(1284.5).success).toBe(false);
    expect(MoneySchema.safeParse('1284.50000').success).toBe(false);
    expect(MoneySchema.safeParse('₹1284.50').success).toBe(false);
  });

  it('requires an offset on timestamps so a rendered time is unambiguous', () => {
    expect(TimestampSchema.safeParse('2026-08-12T08:12:00+05:30').success).toBe(true);
    expect(TimestampSchema.safeParse('2026-08-12T08:12:00').success).toBe(false);
  });
});
