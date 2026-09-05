import { loggerFor } from '../../shared/logger';

import { mailTransport } from './mail.transport';
import { renderEmailChangedEmail, type EmailChangedEmail } from './templates/emailChanged';
import { renderDriverInvitationEmail, type DriverInvitationEmail } from './templates/driverInvitation';
import { renderInvitationEmail, type InvitationEmail } from './templates/invitation';

/**
 * Composing and sending mail.
 *
 * Every send here is best-effort by design. A customer's account is created in
 * a transaction; the email announcing it is not part of that transaction and
 * must not be able to roll it back. If the mail server is unreachable the
 * account still exists, the invitation is still valid, and the admin is told
 * the message did not go — which is a problem they can fix with a resend, as
 * opposed to a failed onboarding that loses everything they typed.
 */

const log = loggerFor('mail');

export async function sendInvitation(input: InvitationEmail): Promise<boolean> {
  const message = renderInvitationEmail(input);

  try {
    await mailTransport().send({
      to: input.email,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    return true;
  } catch (error) {
    /*
     * The address is logged; the accept URL is not. It is a bearer credential
     * for the account, and logs are the one place a secret is most likely to be
     * read by someone who was never sent the email.
     */
    log.error({ err: error, to: input.email }, 'invitation email could not be sent');
    return false;
  }
}

/**
 * Driver onboarding mail. The password is in the message; it is never logged.
 */
export async function sendDriverInvitation(input: DriverInvitationEmail): Promise<boolean> {
  const message = renderDriverInvitationEmail(input);

  try {
    await mailTransport().send({
      to: input.email,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    return true;
  } catch (error) {
    log.error({ err: error, to: input.email }, 'driver invitation email could not be sent');
    return false;
  }
}

export async function sendEmailChanged(input: EmailChangedEmail): Promise<boolean> {
  const message = renderEmailChangedEmail(input);

  try {
    await mailTransport().send({
      to: input.previousEmail,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    return true;
  } catch (error) {
    log.error({ err: error, to: input.previousEmail }, 'address-change notice could not be sent');
    return false;
  }
}

export { renderDriverInvitationEmail, renderEmailChangedEmail, renderInvitationEmail };
export type { DriverInvitationEmail, EmailChangedEmail, InvitationEmail };
