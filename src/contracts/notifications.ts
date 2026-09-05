import { IdParamSchema, commonErrorResponses, ErrorBodySchema } from './common';
import { registry, z } from './registry';

const json = (schema: z.ZodType) => ({ 'application/json': { schema } });

export const NotificationKindSchema = z.enum([
  'TRACKING',
  'EARNING',
  'CAMPAIGN',
  'PAYOUT',
  'VERIFICATION',
  'SYSTEM',
]);

export const NotificationSchema = registry.register(
  'Notification',
  z.object({
    id: z.uuid(),
    kind: NotificationKindSchema,
    title: z.string(),
    body: z.string().nullable(),
    href: z.string().nullable(),
    readAt: z.string().nullable(),
    createdAt: z.string(),
  }),
);

export const NotificationListSchema = registry.register(
  'NotificationList',
  z.object({
    items: z.array(NotificationSchema),
    unreadCount: z.number().int(),
  }),
);

export const NotificationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

registry.registerPath({
  method: 'get',
  path: '/v1/admin/notifications',
  tags: ['admin-notifications'],
  summary: 'List notifications for the signed-in admin',
  security: [{ cookieAuth: [] }],
  request: { query: NotificationListQuerySchema },
  responses: {
    200: { description: 'Inbox.', content: json(NotificationListSchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/notifications/read-all',
  tags: ['admin-notifications'],
  summary: 'Mark every notification as read',
  security: [{ cookieAuth: [] }],
  responses: {
    200: {
      description: 'Cleared.',
      content: json(z.object({ unreadCount: z.literal(0) })),
    },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/admin/notifications/{id}/read',
  tags: ['admin-notifications'],
  summary: 'Mark one notification as read',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'Updated.', content: json(NotificationSchema) },
    401: commonErrorResponses[401],
    404: { description: 'Not this user\'s notification.', content: json(ErrorBodySchema) },
  },
});

/*
 * The driver's inbox, mounted under the driver portal and read with a bearer
 * token from the phone.
 *
 * Assignment and installation have written rows addressed to `driver_id` since
 * they were built; nothing could read them, because the read side only ever
 * queried `user_id`. It is the only channel the app has for a change the
 * driver did not cause — there is no push delivery.
 */

registry.registerPath({
  method: 'get',
  path: '/v1/driver/notifications',
  tags: ['driver'],
  summary: 'List notifications for the signed-in driver',
  security: [{ cookieAuth: [] }, { bearerAuth: [] }],
  request: { query: NotificationListQuerySchema },
  responses: {
    200: { description: 'Inbox.', content: json(NotificationListSchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/driver/notifications/read-all',
  tags: ['driver'],
  summary: 'Mark every notification as read',
  security: [{ cookieAuth: [] }, { bearerAuth: [] }],
  responses: {
    200: {
      description: 'Cleared.',
      content: json(z.object({ unreadCount: z.literal(0) })),
    },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/driver/notifications/{id}/read',
  tags: ['driver'],
  summary: 'Mark one notification as read',
  security: [{ cookieAuth: [] }, { bearerAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'Updated.', content: json(NotificationSchema) },
    401: commonErrorResponses[401],
    404: { description: 'Not this driver\'s notification.', content: json(ErrorBodySchema) },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/notifications',
  tags: ['notifications'],
  summary: 'List notifications for the signed-in advertiser',
  security: [{ cookieAuth: [] }],
  request: { query: NotificationListQuerySchema },
  responses: {
    200: { description: 'Inbox.', content: json(NotificationListSchema) },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/notifications/read-all',
  tags: ['notifications'],
  summary: 'Mark every notification as read',
  security: [{ cookieAuth: [] }],
  responses: {
    200: {
      description: 'Cleared.',
      content: json(z.object({ unreadCount: z.literal(0) })),
    },
    401: commonErrorResponses[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/notifications/{id}/read',
  tags: ['notifications'],
  summary: 'Mark one notification as read',
  security: [{ cookieAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: { description: 'Updated.', content: json(NotificationSchema) },
    401: commonErrorResponses[401],
    404: { description: 'Not this user\'s notification.', content: json(ErrorBodySchema) },
  },
});
