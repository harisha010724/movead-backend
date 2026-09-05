import { BRAND, escapeHtml, renderLayout, type } from './layout';

/**
 * Sent to the address that is being replaced, never to the new one.
 *
 * That direction is the entire point. Changing where an account signs in is
 * how a takeover is finished, so the mailbox losing access is the one that has
 * to hear about it — the new owner of the account already knows. If the person
 * reading this did not ask for the change, this message is the only warning
 * they will get, so it says who made it and how to stop it.
 */

export interface EmailChangedEmail {
  fullName: string;
  /** The address this is going to, which no longer signs in. */
  previousEmail: string;
  newEmail: string;
  organisation: string;
  /** The member of staff who made the change. Named, never "the system". */
  changedBy: string;
  /** Where to complain, which must not be a no-reply address. */
  supportEmail: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderEmailChangedEmail(input: EmailChangedEmail): RenderedEmail {
  const firstName = input.fullName.trim().split(/\s+/)[0] ?? input.fullName;
  const subject = 'Your MoveAd sign-in address has been changed';

  const body = `
<h1 style="${type.h1}">Your sign-in address has changed.</h1>

<p style="${type.p}">
  ${escapeHtml(firstName)}, ${escapeHtml(input.changedBy)} at MoveAd changed the
  address on the
  <strong style="color:${BRAND.ink};">${escapeHtml(input.organisation)}</strong>
  account. This mailbox can no longer be used to sign in.
</p>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 24px;">
  <tr>
    <td style="background-color:${BRAND.panel};border:1px solid ${BRAND.line};border-radius:10px;padding:18px 20px;">
      <p style="${type.label}">Was</p>
      <p style="${type.value}text-decoration:line-through;color:${BRAND.muted};">${escapeHtml(input.previousEmail)}</p>
      <p style="${type.label}margin-top:14px;">Now signs in with</p>
      <p style="${type.value}">${escapeHtml(input.newEmail)}</p>
    </td>
  </tr>
</table>

<p style="${type.p}">
  Your password has not changed, and anyone signed in on the account has been
  signed out. Nothing else about the account was touched.
</p>

<p style="${type.small}">
  <strong style="color:${BRAND.ink};">If you did not expect this</strong>, reply
  to this email or write to
  <a href="mailto:${escapeHtml(input.supportEmail)}" style="color:${BRAND.accentDark};text-decoration:underline;">${escapeHtml(input.supportEmail)}</a>
  straight away and we will put it back.
</p>`;

  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: `${input.previousEmail} can no longer sign in to MoveAd.`,
      body,
    }),
    text: renderEmailChangedText(input),
  };
}

function renderEmailChangedText(input: EmailChangedEmail): string {
  const firstName = input.fullName.trim().split(/\s+/)[0] ?? input.fullName;

  return `Your MoveAd sign-in address has changed.

${firstName}, ${input.changedBy} at MoveAd changed the address on the
${input.organisation} account. This mailbox can no longer be used to sign in.

Was:              ${input.previousEmail}
Now signs in with: ${input.newEmail}

Your password has not changed, and anyone signed in on the account has been
signed out. Nothing else about the account was touched.

If you did not expect this, reply to this email or write to
${input.supportEmail} straight away and we will put it back.

MoveAd · Verified-kilometre vehicle advertising · Bengaluru
`;
}
