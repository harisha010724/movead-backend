import { commonErrorResponses } from './common';
import { registry, z } from './registry';

export const LivenessSchema = registry.register(
  'Liveness',
  z.object({
    status: z.literal('ok'),
    service: z.string(),
    version: z.string(),
    uptimeSeconds: z.number(),
  }),
);

const DependencyCheckSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().nullable(),
  error: z.string().nullable(),
});

export const ReadinessSchema = registry.register(
  'Readiness',
  z.object({
    status: z.enum(['ready', 'degraded']),
    service: z.string(),
    version: z.string(),
    checks: z.object({
      database: DependencyCheckSchema,
      redis: DependencyCheckSchema,
    }),
  }),
);

export type Liveness = z.infer<typeof LivenessSchema>;
export type Readiness = z.infer<typeof ReadinessSchema>;

registry.registerPath({
  method: 'get',
  path: '/health/live',
  summary: 'Liveness probe',
  description:
    'Answers only "is this process running". Checks no dependency, because a database outage must not make the orchestrator restart every container.',
  tags: ['health'],
  responses: {
    200: {
      description: 'The process is alive.',
      content: { 'application/json': { schema: LivenessSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/health/ready',
  summary: 'Readiness probe',
  description:
    'Checks Postgres and Redis. Returns 503 when a dependency is down so the load balancer stops sending traffic without the container being killed.',
  tags: ['health'],
  responses: {
    200: {
      description: 'Every dependency is reachable.',
      content: { 'application/json': { schema: ReadinessSchema } },
    },
    503: {
      description: 'At least one dependency is unreachable.',
      content: { 'application/json': { schema: ReadinessSchema } },
    },
    500: commonErrorResponses[500],
  },
});
