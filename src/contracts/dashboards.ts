import { commonErrorResponses, MoneySchema } from './common';
import { registry, z } from './registry';

/**
 * The two landing screens and the fleet views behind them.
 *
 * Read-only and derived: nothing here has a write counterpart, and every
 * figure is summed from `trip_segments` when it is asked for.
 */

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
  .openapi({ example: '2026-09-08' });

/**
 * Both ends inclusive, read in Asia/Kolkata.
 *
 * Required rather than defaulted, because "today" is a decision the caller has
 * already made — the screen has a date picker on it — and a server that
 * guessed would disagree with the label above the figures.
 */
const RangeQuerySchema = z.object({ from: DateSchema, to: DateSchema });

export const AdminDashboardQuerySchema = RangeQuerySchema;

export const AdvertiserDashboardQuerySchema = RangeQuerySchema.extend({
  campaignId: z
    .uuid()
    .optional()
    .openapi({ description: 'Defaults to the advertiser’s most recent campaign.' }),
});

export const LivePositionsQuerySchema = z.object({
  campaignId: z.uuid().optional().openapi({ description: 'Omit for the whole fleet.' }),
});

export const VehicleListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().optional(),
});

const LiveVehicleStateSchema = registry.register(
  'LiveVehicleState',
  z.enum(['RUNNING', 'IDLE', 'OFFLINE', 'GPS_PAUSED']).openapi({
    description:
      'Derived from the last GPS fix, not stored. A vehicle that stops reporting becomes OFFLINE without anything having to write to it.',
  }),
);

const SeriesPointSchema = registry.register(
  'SeriesPoint',
  z.object({ label: z.string(), value: z.number() }),
);

const ZoneKmSchema = z.object({
  prime: z.number(),
  secondary: z.number(),
  network: z.number(),
});

const KmSummarySchema = registry.register(
  'KmSummary',
  ZoneKmSchema.extend({
    total: z.number().openapi({ description: 'Every segment in the range, whatever its state.' }),
    rejected: z.number(),
    pending: z.number(),
  }).openapi({
    description:
      'Zone figures are billable distance only. A rejected kilometre happened in a zone but nobody is charged for it, so counting it as inventory would overstate what was bought.',
  }),
);

const VehicleStateCountSchema = z.object({
  state: LiveVehicleStateSchema,
  count: z.number().int(),
});

const AdminDashboardSchema = registry.register(
  'AdminDashboard',
  z.object({
    supply: z.object({
      registeredDrivers: z.number().int(),
      approvedDrivers: z.number().int(),
      activeCampaigns: z.number().int(),
      currentlyTracking: z.number().int(),
    }),
    inventoryToday: KmSummarySchema,
    moneyToday: z.object({
      advertiserRevenue: MoneySchema,
      driverLiability: MoneySchema,
      grossSpread: MoneySchema,
    }),
    queues: z.object({
      documentsPending: z.number().int(),
      installationsPending: z.number().int(),
      kmFlagged: z.number().int(),
      payoutsAwaitingRelease: z
        .number()
        .int()
        .openapi({ description: 'Always 0 until payout runs exist.' }),
    }),
    revenueDaily: z.array(SeriesPointSchema),
    vehicleStatus: z.array(VehicleStateCountSchema),
  }),
);

const AdvertiserDashboardSchema = registry.register(
  'AdvertiserDashboard',
  z.object({
    campaignId: z.uuid(),
    km: KmSummarySchema,
    spend: z.object({
      prime: MoneySchema,
      secondary: MoneySchema,
      network: MoneySchema,
      total: MoneySchema,
    }),
    budget: MoneySchema,
    remaining: MoneySchema,
    activeVehicles: z.number().int(),
    costPerKm: MoneySchema,
    impressions: z.number().openapi({
      description:
        'Always 0. No acceptance criterion defines how an impression is counted, and nothing in the pricing path may depend on this field until one does.',
    }),
    costPerThousandImpressions: MoneySchema,
    comparison: z
      .object({
        impressions: z.number(),
        verifiedKm: z.number(),
        spend: z.number(),
        activeVehicles: z.number(),
        costPerThousandImpressions: z.number(),
      })
      .openapi({
        description:
          'Change against the preceding range of equal length, as a ratio. Zero where the previous period had nothing to compare against.',
      }),
    rates: z.object({
      advertiser: z.record(z.enum(['PRIME', 'SECONDARY', 'NETWORK']), MoneySchema),
      driver: z.record(z.enum(['PRIME', 'SECONDARY', 'NETWORK']), MoneySchema),
      effectiveFrom: z.string(),
    }),
    impressionsDaily: z.array(SeriesPointSchema),
    impressionsHourly: z.array(SeriesPointSchema),
    impressionsByArea: z.array(SeriesPointSchema),
    impressionsByVehicleType: z.array(SeriesPointSchema),
    vehicleStatus: z.array(VehicleStateCountSchema),
    topVehicles: z.array(
      z.object({
        vehicleNumber: z.string(),
        driverName: z.string(),
        area: z.string(),
        km: z.number(),
        zoneKm: ZoneKmSchema,
        impressions: z.number(),
        spend: MoneySchema,
        state: LiveVehicleStateSchema,
      }),
    ),
    alerts: z.array(
      z.object({
        id: z.string(),
        severity: z.enum(['info', 'warning', 'critical']),
        message: z.string(),
        occurredAt: z.string(),
      }),
    ),
  }),
);

const LivePositionsSchema = registry.register(
  'LivePositions',
  z.object({
    items: z.array(
      z.object({
        vehicleRef: z.string(),
        lat: z.number(),
        lon: z.number(),
        state: LiveVehicleStateSchema,
        updatedAt: z.string(),
      }),
    ),
    updatedAt: z
      .string()
      .openapi({ description: 'When this answer was produced, not the age of the newest fix.' }),
  }),
);

const VehicleListingSchema = registry.register(
  'VehicleListing',
  z.object({
    items: z.array(
      z.object({
        id: z.uuid(),
        vehicleRef: z.string(),
        vehicleType: z.enum(['AUTO', 'CAB']),
        primaryArea: z.string(),
        avgKmPerDay: z.number(),
        zoneMix: ZoneKmSchema.openapi({
          description:
            'Proportions of billable distance over the last 30 days. Sums to 1, or to 0 for a vehicle that has not driven.',
        }),
        status: z.string(),
      }),
    ),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  }),
);

const secured = [{ cookieAuth: [] }];

registry.registerPath({
  method: 'get',
  path: '/v1/dashboard/admin',
  tags: ['dashboards'],
  summary: 'Platform-wide operations dashboard',
  description:
    'Supply, inventory, money and queue depths over a date range. Requires `campaign.read`.',
  security: secured,
  request: { query: AdminDashboardQuerySchema },
  responses: {
    200: { description: 'The dashboard.', content: json(AdminDashboardSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/dashboard/advertiser',
  tags: ['dashboards'],
  summary: 'One campaign’s performance',
  description:
    'Scoped to the signed-in advertiser. An id belonging to another advertiser is a 404, not a 403 — whether their campaigns exist is not ours to confirm. Requires `advertiser.report.read`.',
  security: secured,
  request: { query: AdvertiserDashboardQuerySchema },
  responses: {
    200: { description: 'The dashboard.', content: json(AdvertiserDashboardSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/vehicles/live-positions',
  tags: ['dashboards'],
  summary: 'Last known position of every working vehicle',
  description:
    'Either portal. Vehicles with no live assignment are excluded; ones that have stopped reporting keep their last fix, because where a vehicle went quiet is the first thing anyone asks.',
  security: secured,
  request: { query: LivePositionsQuerySchema },
  responses: {
    200: { description: 'Positions.', content: json(LivePositionsSchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/vehicles',
  tags: ['dashboards'],
  summary: 'The fleet with how it performs',
  description:
    'Operations’ vehicle report, carrying the plate and the operating area. Distinct from `/v1/vehicles/available`, which is the advertiser’s booking view and withholds both. Requires `vehicle.read`.',
  security: secured,
  request: { query: VehicleListQuerySchema },
  responses: {
    200: { description: 'Vehicles.', content: json(VehicleListingSchema) },
    401: commonErrorResponses[401],
  },
});
