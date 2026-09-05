import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createTransport, type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

import { config } from '../../shared/config';
import { loggerFor } from '../../shared/logger';

/**
 * How a message actually leaves the process.
 *
 * Two transports, chosen by configuration rather than by branching at each call
 * site, so the service that composes an email never knows or cares which is in
 * use. `smtp` is the real one. `file` writes the rendered message to disk and
 * logs the path, which is how the templates get designed without an SMTP server
 * — and is refused outright in production by `config.ts`, because mail that
 * silently lands in a directory is indistinguishable from mail that was sent.
 */

const log = loggerFor('mail');

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SentMail {
  /** Where it went, for the log line and for `file` transport, the path. */
  destination: string;
}

export interface MailTransport {
  send(message: OutgoingMail): Promise<SentMail>;
}

/**
 * Writes the message as a standalone `.html` file, and the plain-text part
 * beside it.
 *
 * The HTML is opened directly in a browser, which is close enough for design
 * work. It is not close enough for a client-compatibility check — Outlook and
 * Gmail are the two that break things, and neither is a browser — so a template
 * change still wants a real send before it reaches a customer.
 */
function fileTransport(): MailTransport {
  const directory = resolve(process.cwd(), config.mail.previewDir);

  return {
    async send(message) {
      await mkdir(directory, { recursive: true });

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const slug = message.to.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      const path = resolve(directory, `${stamp}-${slug}.html`);

      await writeFile(path, message.html, 'utf8');
      await writeFile(path.replace(/\.html$/, '.txt'), message.text, 'utf8');

      log.info(
        { to: message.to, subject: message.subject, path },
        'mail written to disk — MAIL_TRANSPORT=file, nothing was sent',
      );

      return { destination: path };
    },
  };
}

type SmtpTransporter = Transporter<SMTPTransport.SentMessageInfo>;

function smtpTransport(): MailTransport {
  let transporter: SmtpTransporter | null = null;

  // Built on first use rather than at import, so a process that never sends
  // mail does not open a connection pool — and so a missing SMTP_URL surfaces
  // where it can be reported rather than at module load.
  const connect = (): SmtpTransporter => {
    if (!transporter) {
      if (!config.mail.smtpUrl) throw new Error('SMTP_URL is not configured');
      transporter = createTransport(config.mail.smtpUrl);
    }
    return transporter;
  };

  return {
    async send(message) {
      const info = await connect().sendMail({
        from: config.mail.from,
        replyTo: config.mail.replyTo,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });

      log.info({ to: message.to, subject: message.subject, messageId: info.messageId }, 'mail sent');
      return { destination: message.to };
    },
  };
}

let active: MailTransport | null = null;

export function mailTransport(): MailTransport {
  active ??= config.mail.transport === 'smtp' ? smtpTransport() : fileTransport();
  return active;
}

/** Swaps the transport for a test double. Returns a function that restores it. */
export function setMailTransport(replacement: MailTransport): () => void {
  const previous = active;
  active = replacement;
  return () => {
    active = previous;
  };
}
