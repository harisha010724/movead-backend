import { config } from '../src/shared/config';
import { renderInvitationEmail } from '../src/modules/mail/templates/invitation';
import { mailTransport } from '../src/modules/mail/mail.transport';

/**
 * Sends one real invitation to an address you choose, so a mail configuration
 * can be proved before a customer is the one testing it.
 *
 * `mail:preview` renders the template; this exercises the credentials, the
 * connection and the recipient's spam filter, which is the part that actually
 * goes wrong. The link inside is deliberately a dead token — this is a delivery
 * check, not an invitation.
 *
 *   npm run mail:test -- you@example.com
 */

async function main(): Promise<void> {
  const to = process.argv[2];
  if (!to) throw new Error('Usage: npm run mail:test -- someone@example.com');

  console.log(`transport  ${config.mail.transport}`);
  console.log(`from       ${config.mail.from}`);
  console.log(`to         ${to}`);

  if (config.mail.transport === 'file') {
    console.log('\nMAIL_TRANSPORT=file — this will write a file, not send anything.');
  }

  const message = renderInvitationEmail({
    fullName: 'Test Recipient',
    email: to,
    organisation: 'Test Organisation',
    acceptUrl: `${config.portals.advertiser}/invitation/this-token-is-not-real-and-will-not-work`,
    portalUrl: config.portals.advertiser,
    expiresInHours: config.invitations.ttlHours,
    invitedBy: 'MoveAd delivery check',
  });

  const sent = await mailTransport().send({ to, ...message });
  console.log(`\ndelivered  ${sent.destination}`);
}

main().catch((error: unknown) => {
  console.error(`\nfailed     ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
