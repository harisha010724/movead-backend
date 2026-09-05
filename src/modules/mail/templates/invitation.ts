import { BRAND, escapeHtml, FONT, renderButton, renderLayout, type } from './layout';

/**
 * The first thing a MoveAd customer ever receives from us.
 *
 * It carries three facts and one action: which organisation the account is for,
 * which address signs in, where the portal is, and a link to choose a password.
 * It deliberately carries no password — see migration 009 for why — so the
 * username is stated plainly instead, because "what do I sign in as" is the
 * question this email exists to answer and a link alone does not answer it.
 */

export interface InvitationEmail {
  /** The person being invited. */
  fullName: string;
  /** Their sign-in address, which is also where this is going. */
  email: string;
  /** The organisation the account belongs to, in their own brand name. */
  organisation: string;
  /** Absolute, single-use, and the only secret in the message. */
  acceptUrl: string;
  /** Where the portal lives, shown so they know the address afterwards. */
  portalUrl: string;
  expiresInHours: number;
  /** Who at MoveAd created the account, so this is from a person. */
  invitedBy: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderInvitationEmail(input: InvitationEmail): RenderedEmail {
  const firstName = input.fullName.trim().split(/\s+/)[0] ?? input.fullName;
  const expiry = `${String(input.expiresInHours)} hours`;

  const subject = `Your ${input.organisation} account on MoveAd is ready`;

  const body = `
<h1 style="${type.h1}">Welcome to MoveAd, ${escapeHtml(firstName)}.</h1>

<p style="${type.p}">
  ${escapeHtml(input.invitedBy)} has created a MoveAd account for
  <strong style="color:${BRAND.ink};">${escapeHtml(input.organisation)}</strong>.
  Choose a password and your dashboard is ready — you can plan a campaign, pick
  the vehicles that carry it, and watch verified kilometres as they are driven.
</p>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 28px;">
  <tr>
    <td style="background-color:${BRAND.panel};border:1px solid ${BRAND.line};border-radius:10px;padding:18px 20px;">
      <p style="${type.label}">Sign in with</p>
      <p style="${type.value}">${escapeHtml(input.email)}</p>
    </td>
  </tr>
</table>

${renderButton(input.acceptUrl, 'Choose your password')}

<p style="${type.small}margin-top:18px;">
  This link works once and expires in ${escapeHtml(expiry)}. If it has already
  run out, ask us to send another — nothing is lost.
</p>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:28px 0;">
  <tr><td style="height:1px;background-color:${BRAND.line};line-height:1px;font-size:1px;">&nbsp;</td></tr>
</table>

<p style="${type.label}">What you can do from day one</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:10px 0 26px;">
  ${[
    ['Build a campaign', 'Set a budget, pick your zones, and see the reach before you commit.'],
    ['Choose your fleet', 'Browse approved autos and cabs, and select the ones that fit the brief.'],
    ['Follow every kilometre', 'A live map and a daily breakdown of exactly what you are paying for.'],
  ]
    .map(
      ([heading, detail]) => `<tr>
    <td style="padding:0 0 14px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td width="26" valign="top" style="width:26px;padding-top:5px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="width:7px;height:7px;background-color:${BRAND.accent};border-radius:7px;line-height:7px;font-size:7px;">&nbsp;</td>
            </tr></table>
          </td>
          <td valign="top" style="font-family:${FONT};font-size:15px;line-height:23px;color:${BRAND.body};">
            <strong style="color:${BRAND.ink};">${escapeHtml(heading ?? '')}</strong><br>${escapeHtml(detail ?? '')}
          </td>
        </tr>
      </table>
    </td>
  </tr>`,
    )
    .join('')}
</table>

<p style="${type.small}">
  Your portal will live at
  <a href="${escapeHtml(input.portalUrl)}" style="color:${BRAND.accentDark};text-decoration:underline;">${escapeHtml(input.portalUrl)}</a>.
  Bookmark it once you are in.
</p>

<p style="${type.small}margin-top:14px;">
  If the button does not work, paste this into your browser:<br>
  <span style="color:${BRAND.body};word-break:break-all;">${escapeHtml(input.acceptUrl)}</span>
</p>`;

  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: `Choose a password and your ${input.organisation} dashboard is ready.`,
      body,
      footerNote:
        'Not expecting this? Nobody can use the link without your mailbox, and it expires on its own — but do tell us, and we will close the account.',
    }),
    text: renderInvitationText(input),
  };
}

/**
 * The plain-text alternative.
 *
 * Not a fallback nobody sees: a message without one scores as spam, and some
 * corporate gateways strip HTML outright. It says the same things in the same
 * order rather than apologising for not being the HTML version.
 */
function renderInvitationText(input: InvitationEmail): string {
  const firstName = input.fullName.trim().split(/\s+/)[0] ?? input.fullName;

  return `Welcome to MoveAd, ${firstName}.

${input.invitedBy} has created a MoveAd account for ${input.organisation}.
Choose a password and your dashboard is ready.

Sign in with: ${input.email}

Choose your password:
${input.acceptUrl}

This link works once and expires in ${String(input.expiresInHours)} hours. If it
has already run out, ask us to send another — nothing is lost.

What you can do from day one
  - Build a campaign. Set a budget, pick your zones, and see the reach before
    you commit.
  - Choose your fleet. Browse approved autos and cabs, and select the ones that
    fit the brief.
  - Follow every kilometre. A live map and a daily breakdown of exactly what you
    are paying for.

Your portal will live at ${input.portalUrl}. Bookmark it once you are in.

Not expecting this? Nobody can use the link without your mailbox, and it expires
on its own — but do tell us, and we will close the account.

MoveAd · Verified-kilometre vehicle advertising · Bengaluru
`;
}
