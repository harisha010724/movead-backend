import { Router } from 'express';

import { adminAdvertiserRoutes } from '../modules/advertisers/advertisers.routes';
import { adminCampaignRoutes } from '../modules/campaigns/campaigns.admin.routes';
import {
  adminNotificationRoutes,
  advertiserNotificationRoutes,
} from '../modules/notifications/notifications.routes';
import { campaignRoutes } from '../modules/campaigns/campaigns.routes';
import { driverPortalRoutes } from '../modules/drivers/driver-portal.routes';
import { adminDriverRoutes } from '../modules/drivers/drivers.routes';
import { adminInstallationRoutes } from '../modules/installations/installations.routes';
import { advertiserVehicleRoutes } from '../modules/drivers/vehicles.advertiser.routes';
import { healthRoutes } from '../modules/health/health.routes';
import {
  adminIdentityRoutes,
  authRoutes,
  driverAppAuthRoutes,
} from '../modules/identity/identity.routes';
import {
  adminInvitationRoutes,
  invitationRoutes,
} from '../modules/invitations/invitations.routes';
import { config } from '../shared/config';
import { createApp } from '../shared/http/createApp';
import { docsRoutes } from '../shared/http/docs';
import { serve } from '../shared/http/serve';

/**
 * The API service: every domain module except GPS ingestion.
 *
 * Ingestion runs as its own deployable so a burst of location uploads cannot
 * starve the screens an operator is using to release payouts (Part 2.1).
 */

const SERVICE = 'api';

/**
 * Domain routers mount here as each module lands. `/v1` is a published
 * contract: fields may be added, never removed or repurposed — a driver
 * mid-campaign cannot be forced to update the app (Part 3.5).
 */
const v1 = Router();

// Not under `/admin`: one login page serves both portals, so sign-in cannot
// live under either one's prefix.
v1.use('/auth', authRoutes());

// Also not under `/admin`, and not authenticated at all: whoever is accepting
// an invitation has no password yet. The token in the path is the credential.
v1.use('/invitations', invitationRoutes());
v1.use('/campaigns', campaignRoutes());
v1.use('/notifications', advertiserNotificationRoutes());
v1.use('/vehicles', advertiserVehicleRoutes());

// Before the portal router, which guards everything under `/driver`. Sign-in
// is the one thing there that cannot already be signed in.
v1.use('/driver/auth', driverAppAuthRoutes());
v1.use('/driver', driverPortalRoutes());

v1.use('/admin', adminIdentityRoutes());
v1.use('/admin', adminInvitationRoutes());
v1.use('/admin', adminAdvertiserRoutes());
v1.use('/admin', adminCampaignRoutes());
v1.use('/admin', adminInstallationRoutes());
v1.use('/admin', adminNotificationRoutes());
v1.use('/admin', adminDriverRoutes());

export const app = createApp({
  serviceName: SERVICE,
  routers: [
    { path: '/health', router: healthRoutes(SERVICE) },
    // `/openapi.json`, which the clients' `api:pull` fetches, and `/docs`.
    { path: '/', router: docsRoutes() },
    { path: '/v1', router: v1 },
  ],
});

if (require.main === module) {
  serve(app, { serviceName: SERVICE, port: config.http.apiPort });
}
