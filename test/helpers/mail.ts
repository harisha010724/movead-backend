import { setMailTransport, type OutgoingMail } from '../../src/modules/mail/mail.transport';

/**
 * Captures outgoing mail instead of sending it.
 *
 * Tests read the invitation link out of the message body rather than reaching
 * into the database for it, and that is deliberate: the token is stored only as
 * a digest, so the email is genuinely the only place the usable link exists.
 * Going through it means a test that passes has proved the whole chain — issued,
 * rendered into the template, and accepted — instead of proving that a row was
 * written.
 */

export interface MailInbox {
  messages: OutgoingMail[];
  last(): OutgoingMail;
  to(address: string): OutgoingMail;
  /** The invitation token from the most recent message. */
  tokenFor(address: string): string;
  /** Temporary password from a driver invitation. */
  passwordFor(address: string): string;
  clear(): void;
  restore(): void;
}

export function captureMail(): MailInbox {
  const messages: OutgoingMail[] = [];

  const restore = setMailTransport({
    send(message) {
      messages.push(message);
      return Promise.resolve({ destination: message.to });
    },
  });

  const to = (address: string): OutgoingMail => {
    const found = [...messages].reverse().find((message) => message.to === address);
    if (!found) throw new Error(`No mail was sent to ${address}`);
    return found;
  };

  return {
    messages,
    last: () => {
      const found = messages.at(-1);
      if (!found) throw new Error('No mail was sent');
      return found;
    },
    to,
    tokenFor: (address) => {
      const message = to(address);
      const match = /\/invitation\/([A-Za-z0-9_-]+)/.exec(message.text);
      if (!match?.[1]) throw new Error(`No invitation link in the mail to ${address}`);
      return match[1];
    },
    passwordFor: (address) => {
      const message = to(address);
      const match = /^Password: (.+)$/m.exec(message.text);
      if (!match?.[1]) throw new Error(`No password in the mail to ${address}`);
      return match[1].trim();
    },
    clear: () => {
      messages.length = 0;
    },
    restore,
  };
}

/** Fails a send, so the "created but not emailed" path can be exercised. */
export function failMail(): () => void {
  return setMailTransport({
    send: () => Promise.reject(new Error('SMTP unavailable')),
  });
}
