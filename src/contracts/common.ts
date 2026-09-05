import { registry, z } from './registry';

/**
 * Primitives every module reuses. Registering them by name means the OpenAPI
 * document carries `$ref`s to one definition instead of inlining the same
 * shape forty times.
 */

/**
 * An exact decimal string. Serialised rather than sent as a number because
 * JSON numbers are doubles, and a double cannot hold `1284.5000` faithfully
 * for every value the ledger produces.
 */
export const MoneySchema = registry.register(
  'Money',
  z
    .string()
    .regex(/^-?\d+(\.\d{1,4})?$/, 'Must be a decimal string with up to four places')
    .openapi({ description: 'Exact decimal rupees, e.g. "1284.50".', example: '1284.50' }),
);

export const TimestampSchema = registry.register(
  'Timestamp',
  z.iso.datetime({ offset: true }).openapi({
    description: 'ISO 8601 instant. Stored as TIMESTAMPTZ, rendered in Asia/Kolkata.',
    example: '2026-08-12T08:12:00+05:30',
  }),
);

export const UuidSchema = z.uuid();

/** The `:id` path parameter, which almost every resource route takes. */
export const IdParamSchema = z.object({ id: z.uuid() });

export const LatLngSchema = registry.register(
  'LatLng',
  z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .openapi({ description: 'WGS 84 (SRID 4326), the coordinate system Google Maps uses.' }),
);

export const ErrorBodySchema = registry.register(
  'Error',
  z
    .object({
      code: z.string().openapi({ example: 'validation_failed' }),
      message: z.string().openapi({ example: 'Some of the details you sent are not valid.' }),
      requestId: z.string().optional(),
      details: z.unknown().optional(),
    })
    .openapi({
      description:
        'Flat error envelope. `code` is stable and safe to branch on; `message` is shown to the user and may change.',
    }),
);

/**
 * Cursor pagination rather than offset.
 *
 * The lists that page — notifications, earnings history, trips — are
 * append-only and read newest first, so an offset shifts under the reader
 * every time a row arrives and page two silently repeats a row from page one.
 */
export const CursorQuerySchema = z.object({
  cursor: z.string().optional().openapi({ description: 'Opaque; from the previous response.' }),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable().openapi({ description: 'Null on the last page.' }),
  });
}

/** Every endpoint can fail this way, so every endpoint documents it once. */
export const commonErrorResponses = {
  400: {
    description: 'The request failed validation.',
    content: { 'application/json': { schema: ErrorBodySchema } },
  },
  401: {
    description: 'Missing or expired credentials.',
    content: { 'application/json': { schema: ErrorBodySchema } },
  },
  500: {
    description: 'Unexpected failure. The response carries a requestId for support.',
    content: { 'application/json': { schema: ErrorBodySchema } },
  },
} as const;
