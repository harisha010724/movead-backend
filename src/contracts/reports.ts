import { commonErrorResponses, ErrorBodySchema } from './common';
import { registry, z } from './registry';

/**
 * Advertiser reports — a dated proof pack and the four CSV extracts behind it.
 *
 * Scoped to one campaign and one inclusive IST period. The proof pack is the
 * document to send to finance or a client; the CSVs are the working behind
 * the same figures. Nothing here carries a driver identity or a plate.
 */

const json = <T>(schema: T) => ({ 'application/json': { schema } });

const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
  .openapi({ example: '2026-09-08', description: 'Civil day in Asia/Kolkata.' });

export const ReportTypeSchema = registry.register(
  'ReportType',
  z
    .enum(['proof-pack', 'billing-statement', 'zone-summary', 'vehicle-summary', 'km-detail'])
    .openapi({
      description:
        'proof-pack is the dated HTML document. The others are CSVs of the same billed kilometres.',
    }),
);

export const ReportFormatSchema = registry.register(
  'ReportFormat',
  z.enum(['html', 'csv']),
);

export const ExportReportRequestSchema = registry.register(
  'ExportReportRequest',
  z.object({
    campaignId: z.uuid().describe('The campaign whose billed kilometres are exported.'),
    type: ReportTypeSchema,
    from: DateSchema,
    to: DateSchema,
    format: z
      .enum(['html', 'csv'])
      .optional()
      .describe('Ignored. The type picks the format — proof-pack is HTML, the rest are CSV.'),
  }),
);

export const ReportExportSchema = registry.register(
  'ReportExport',
  z.object({
    id: z.uuid(),
    type: ReportTypeSchema,
    format: ReportFormatSchema,
    campaignId: z.uuid(),
    campaignName: z.string(),
    from: DateSchema,
    to: DateSchema,
    fileName: z.string(),
    contentType: z.string(),
    byteSize: z.number().int(),
    checksum: z.string().describe('SHA-256 of the file bytes.'),
    generatedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    status: z.literal('ready'),
  }),
);

export const ReportExportListSchema = registry.register(
  'ReportExportList',
  z.object({ items: z.array(ReportExportSchema) }),
);

registry.registerPath({
  method: 'post',
  path: '/v1/reports/export',
  tags: ['reports'],
  summary: 'Generate a campaign report',
  description: [
    'Builds the file immediately and returns the export record. Download it from `/v1/reports/{id}/download`.',
    '',
    'The proof pack is an HTML document: campaign cover, zone mix, readability, modelled impressions with the baseline mix, and a few sample-day workings. Print it to PDF.',
    '',
    'The CSVs are billing-statement, zone-summary, vehicle-summary (plates anonymised) and km-detail. A kilometre-detail over too many rows is refused rather than queued.',
    '',
    'Requires `advertiser.report.read`. A campaign belonging to another advertiser is not found.',
  ].join('\n'),
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  request: { body: { content: json(ExportReportRequestSchema), required: true } },
  responses: {
    201: { description: 'The export is ready to download.', content: json(ReportExportSchema) },
    400: commonErrorResponses[400],
    401: commonErrorResponses[401],
    403: { description: 'Not an advertiser account, or missing advertiser.report.read.', content: json(ErrorBodySchema) },
    404: { description: 'No such campaign for this advertiser.', content: json(ErrorBodySchema) },
    422: { description: 'The kilometre-detail export is too large for this period.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/reports',
  tags: ['reports'],
  summary: 'Recent exports',
  description:
    'Exports generated in the last seven days for this advertiser. Expired rows are omitted.',
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  responses: {
    200: { description: 'Newest first.', content: json(ReportExportListSchema) },
    401: commonErrorResponses[401],
    403: { description: 'Not an advertiser account, or missing advertiser.report.read.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/reports/{id}/download',
  tags: ['reports'],
  summary: 'Download an export',
  description:
    'The file itself. Available for seven days. Re-downloadable until then — not single-use.',
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: 'The file. Filename is in Content-Disposition.',
      content: {
        'text/html': { schema: { type: 'string' } },
        'text/csv': { schema: { type: 'string' } },
      },
    },
    401: commonErrorResponses[401],
    403: { description: 'Not an advertiser account, or missing advertiser.report.read.', content: json(ErrorBodySchema) },
    404: { description: 'Unknown, expired, or belonging to another advertiser.', content: json(ErrorBodySchema) },
  },
});
