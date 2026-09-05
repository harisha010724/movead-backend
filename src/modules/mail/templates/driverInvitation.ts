import { BRAND, escapeHtml, renderButton, renderLayout, type } from './layout';

/**
 * Driver onboarding mail: username and password in the message so they can
 * sign in at once. Advertiser invitations still never carry a password.
 */

export interface DriverInvitationEmail {
  fullName: string;
  email: string;
  password: string;
  portalUrl: string;
  invitedBy: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderDriverInvitationEmail(input: DriverInvitationEmail): RenderedEmail {
  const firstName = input.fullName.trim().split(/\s+/)[0] ?? input.fullName;
  const loginUrl = `${input.portalUrl.replace(/\/$/, '')}/login`;
  const subject = 'Your MoveAd driver login is ready';

  const body = `
<h1 style="${type.h1}">Welcome to MoveAd, ${escapeHtml(firstName)}.</h1>

<p style="${type.p}">
  ${escapeHtml(input.invitedBy)} has created your driver account. Sign in with
  the username and password below — they are already active.
</p>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 28px;">
  <tr>
    <td style="background-color:${BRAND.panel};border:1px solid ${BRAND.line};border-radius:10px;padding:18px 20px;">
      <p style="${type.label}">Username</p>
      <p style="${type.value}">${escapeHtml(input.email)}</p>
      <p style="${type.label}margin-top:16px;">Password</p>
      <p style="${type.value}">${escapeHtml(input.password)}</p>
    </td>
  </tr>
</table>

${renderButton(loginUrl, 'Sign in to MoveAd Driver')}

<p style="${type.small}margin-top:18px;">
  Keep this password private. If you did not expect this email, tell MoveAd
  operations and we will close the account.
</p>

<p style="${type.small}margin-top:14px;">
  Sign-in page:
  <a href="${escapeHtml(loginUrl)}" style="color:${BRAND.accentDark};text-decoration:underline;">${escapeHtml(loginUrl)}</a>
</p>`;

  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: `Your username is ${input.email}. Sign in to the driver portal.`,
      body,
      footerNote:
        'Not expecting this? Tell MoveAd operations and we will close the account.',
    }),
    text: `Welcome to MoveAd, ${firstName}.

${input.invitedBy} has created your driver account. Sign in with the username
and password below — they are already active.

Username: ${input.email}
Password: ${input.password}

Sign in: ${loginUrl}

Keep this password private. If you did not expect this email, tell MoveAd
operations and we will close the account.

MoveAd · Verified-kilometre vehicle advertising · Bengaluru
`,
  };
}
