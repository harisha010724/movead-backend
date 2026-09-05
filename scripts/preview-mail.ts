import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { renderDriverInvitationEmail } from '../src/modules/mail/templates/driverInvitation';
import { renderEmailChangedEmail } from '../src/modules/mail/templates/emailChanged';
import { renderInvitationEmail } from '../src/modules/mail/templates/invitation';

/**
 * Renders every email template to `tmp/mail-preview/` so the design can be
 * reviewed in a browser without onboarding anyone.
 *
 * A browser is not a mail client and this proves nothing about Outlook, which
 * renders through Word and is where HTML email actually breaks. It is for
 * copy, hierarchy and spacing; a template change still wants one real send
 * before it reaches a customer.
 *
 *   npm run mail:preview
 */

const OUT = resolve(process.cwd(), 'tmp/mail-preview');

const samples = {
  /** The ordinary case. */
  invitation: renderInvitationEmail({
    fullName: 'Priya Menon',
    email: 'priya@abcadvertising.example',
    organisation: 'ABC Advertising',
    acceptUrl: 'http://localhost:5173/invitation/RkV4YW1wbGVUb2tlbk5vdFJlYWxseVZhbGlk',
    portalUrl: 'http://localhost:5173',
    expiresInHours: 72,
    invitedBy: 'Arjun Nair',
  }),

  /** Long names and a long address, which is where a fixed 600px breaks. */
  'invitation-long': renderInvitationEmail({
    fullName: 'Lakshmi Venkataraman Subramanian',
    email: 'lakshmi.venkataraman.subramanian@a-rather-long-company-domain.example',
    organisation: 'Kiranakart Technologies Private Limited',
    acceptUrl:
      'https://advertisers.movead.in/invitation/VGhpc0lzQVZlcnlMb25nVG9rZW5UaGF0V3JhcHNBd2t3YXJkbHk',
    portalUrl: 'https://advertisers.movead.in',
    expiresInHours: 72,
    invitedBy: 'Arjun Nair',
  }),

  /** Driver onboard: username and password in the message. */
  'driver-invitation': renderDriverInvitationEmail({
    fullName: 'Rahul Kumar',
    email: 'rahul.driver@example.com',
    password: 'K7mN-pQ2r-sT9v',
    portalUrl: 'http://localhost:5173/driver',
    invitedBy: 'Arjun Nair',
  }),

  /** The warning to a mailbox that has just lost access to an account. */
  'email-changed': renderEmailChangedEmail({
    fullName: 'Priya Menon',
    previousEmail: 'priya@abcadvertising.example',
    newEmail: 'priya.menon@abcadvertising.example',
    organisation: 'ABC Advertising',
    changedBy: 'Arjun Nair',
    supportEmail: 'support@movead.in',
  }),
};

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  for (const [name, message] of Object.entries(samples)) {
    await writeFile(resolve(OUT, `${name}.html`), message.html, 'utf8');
    await writeFile(resolve(OUT, `${name}.txt`), message.text, 'utf8');
    console.log(`${name}\n  subject  ${message.subject}\n  html     ${resolve(OUT, `${name}.html`)}`);
  }
}

void main();
