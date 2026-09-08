import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

import { config } from '../shared/config';

import { registry } from './registry';

// Side-effect imports: each module's contract file registers its schemas and
// paths on the shared registry. A module that is not imported here is absent
// from the published document, so add the import when you add the module.
import './advertisers';
import './campaigns';
import './common';
import './dashboards';
import './drivers';
import './health';
import './identity';
import './installations';
import './invitations';
import './notifications';
import './tracking';

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description:
    'Driver access token, fifteen minutes, held in memory on the device. The audience claim is checked per portal (WEB-001).',
});

registry.registerComponent('securitySchemes', 'cookieAuth', {
  type: 'apiKey',
  in: 'cookie',
  name: 'movead_admin_session',
  description:
    'Web portals use an httpOnly, SameSite=Strict session cookie rather than a bearer token, so an XSS in a dashboard cannot exfiltrate the session. The session is server-side and revocable.',
});

export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV31(registry.definitions);

  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'MoveAd API',
      version: '1.0.0',
      description: [
        'Verified-kilometre vehicle advertising platform.',
        '',
        'Money is always an exact decimal string; clients format it and never compute with it.',
        'Timestamps are ISO 8601 instants stored as TIMESTAMPTZ and rendered in Asia/Kolkata.',
        'Errors share one flat envelope: a stable `code` and a human `message`.',
      ].join('\n'),
    },
    /*
     * Only hosts that actually answer. `api.movead.in` is the intended address
     * but does not resolve yet, and an entry that cannot be reached is worse
     * than a missing one: "Try it out" fails against it with a network error
     * that reads as a broken API. Swap the first entry when the domain is live.
     *
     * Production sits first because Swagger UI selects the first entry, and the
     * session is a SameSite=Strict cookie — a request aimed at any origin other
     * than the one serving this page arrives without it, so every guarded
     * endpoint would answer 401.
     */
    servers: [
      {
        url: 'https://movead-api-ena2d4b6atfkh0fk.centralindia-01.azurewebsites.net',
        description: 'Production',
      },
      { url: `http://localhost:${String(config.http.apiPort)}`, description: 'Local' },
    ],
    tags: [
      { name: 'health', description: 'Liveness and readiness probes' },
      {
        name: 'auth',
        description:
          'Sign-in for both web portals. One surface, because one login page serves both; the audience is derived from the account and enforced on every request thereafter.',
      },
      { name: 'admin-auth', description: 'First-run admin bootstrap' },
      { name: 'admin-users', description: 'Staff account management' },
      { name: 'admin-advertisers', description: 'Advertiser accounts and their portal logins' },
      {
        name: 'invitations',
        description:
          'Accepting an invitation. Unauthenticated by necessity — the caller has no password yet — and authorised by a single-use token instead.',
      },
      { name: 'admin-drivers', description: 'Driver onboarding and approval' },
      { name: 'admin-vehicles', description: 'Vehicle verification and its state machine' },
      { name: 'admin-documents', description: 'Document review' },
      { name: 'campaigns', description: 'Advertiser campaigns: create, estimate, list and creatives' },
      {
        name: 'admin-campaigns',
        description: 'Operations review: list, approve and reject advertiser campaigns',
      },
      {
        name: 'admin-notifications',
        description: 'In-app inbox for operations — campaign submissions and later queues',
      },
      {
        name: 'notifications',
        description: 'In-app inbox for the advertiser — campaign approval and rejection',
      },
      {
        name: 'vehicles',
        description: 'Advertiser fleet browse — onboarded vehicles and their operating pins',
      },
      {
        name: 'admin-installations',
        description:
          'Installation evidence and its review. Approving here is the only thing that puts a vehicle live on a campaign (AC-06.10).',
      },
      {
        name: 'driver-portal',
        description:
          "The signed-in driver's own campaign and tracking eligibility. Audience, not a permission, is the gate.",
      },
      {
        name: 'driver-app',
        description:
          'Sign-in for the mobile app. The only surface that issues bearer tokens: a phone cannot hold the portals\u2019 httpOnly cookie, and the refresh token it can hold has to survive being closed overnight.',
      },
    ],
  });
}

export type OpenApiDocument = ReturnType<typeof buildOpenApiDocument>;
