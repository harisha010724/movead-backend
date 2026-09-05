/**
 * The shell every MoveAd email is rendered into.
 *
 * Email is not the web. Layout is tables because Outlook renders through Word
 * and has no flexbox or grid; styles are inline because Gmail strips much of a
 * `<style>` block; widths are fixed at 600px because that is what survives a
 * preview pane. None of this is how the portal is built, and it should not be
 * refactored to match it.
 */

export const BRAND = {
  /** The portal's primary. Buttons and links. */
  accent: '#5b5be0',
  accentDark: '#4c46c7',
  accentTint: '#eef0ff',
  ink: '#0f172a',
  body: '#475569',
  muted: '#64748b',
  line: '#e2e8f0',
  panel: '#f8fafc',
  page: '#f1f5f9',
} as const;

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans',sans-serif";

/**
 * Everything interpolated into an email is escaped.
 *
 * A brand name and a contact name are typed by an admin into a form, so they
 * are untrusted input reaching a document — the same rule as the portal, and
 * more awkward to notice going wrong here because nobody is watching a console
 * when a customer opens their mail.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface LayoutOptions {
  title: string;
  /** The grey line a client shows beside the subject. Worth writing on purpose. */
  preheader: string;
  body: string;
  /** Appears under the divider, above the legal line. */
  footerNote?: string;
}

export function renderLayout({ title, preheader, body, footerNote }: LayoutOptions): string {
  const year = new Date().getFullYear();

  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
<style>
  /*
   * Tightens the gutters on a narrow screen. Only the gutters: the card itself
   * is fluid by default (see the width note below), so a client that drops this
   * block still gets a layout that fits — it is just a little snugger.
   */
  @media only screen and (max-width:620px) {
    .sm-pad { padding-left:22px !important; padding-right:22px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;width:100%;background-color:${BRAND.page};-webkit-font-smoothing:antialiased;">
  <div style="display:none;font-size:1px;color:${BRAND.page};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    ${escapeHtml(preheader)}
    <!-- Pads the preview so the client does not pull body copy in after it. -->
    &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847;
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BRAND.page};">
    <tr>
      <td align="center" style="padding:32px 12px;">

        <!--
          Fluid up to 600px rather than fixed at it. A fixed width relies on a
          media query to come back down, and a client that strips the style
          block then renders a 600px card in a 360px window — which is a phone
          scrolling sideways to read a call to action.

          Outlook is the exception: it ignores max-width, so it gets a fixed
          600px wrapper of its own and nobody else sees it.
        -->
        <!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" align="center"><tr><td><![endif]-->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;max-width:600px;">

          <tr>
            <td style="padding:0 8px 20px;">
              <span style="font-family:${FONT};font-size:19px;font-weight:700;letter-spacing:-0.4px;color:${BRAND.ink};">Move<span style="color:${BRAND.accent};">Ad</span></span>
            </td>
          </tr>

          <tr>
            <td style="background-color:#ffffff;border:1px solid ${BRAND.line};border-radius:14px;overflow:hidden;">
              <!-- A 4px brand rule, which reads as a masthead without needing a hosted image. -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr><td style="height:4px;background-color:${BRAND.accent};line-height:4px;font-size:4px;">&nbsp;</td></tr>
                <tr><td class="sm-pad" style="padding:36px 40px 40px;">${body}</td></tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:24px 8px 0;font-family:${FONT};font-size:12px;line-height:19px;color:${BRAND.muted};">
              ${footerNote ? `<p style="margin:0 0 12px;">${footerNote}</p>` : ''}
              <p style="margin:0;">MoveAd &middot; Verified-kilometre vehicle advertising &middot; Bengaluru</p>
              <p style="margin:6px 0 0;">&copy; ${String(year)} MoveAd. This message was sent to you because an account was created for your organisation.</p>
            </td>
          </tr>

        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** A primary call to action that survives Outlook, which ignores border-radius. */
export function renderButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" bgcolor="${BRAND.accent}" style="border-radius:10px;">
      <a href="${escapeHtml(href)}" style="display:inline-block;padding:15px 34px;font-family:${FONT};font-size:16px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
    </td>
  </tr>
</table>`;
}

export const type = {
  h1: `margin:0 0 14px;font-family:${FONT};font-size:24px;line-height:32px;font-weight:700;letter-spacing:-0.3px;color:${BRAND.ink};`,
  p: `margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:24px;color:${BRAND.body};`,
  small: `margin:0;font-family:${FONT};font-size:13px;line-height:21px;color:${BRAND.muted};`,
  label: `margin:0 0 4px;font-family:${FONT};font-size:11px;line-height:16px;font-weight:600;letter-spacing:0.6px;text-transform:uppercase;color:${BRAND.muted};`,
  value: `margin:0;font-family:${FONT};font-size:15px;line-height:22px;font-weight:600;color:${BRAND.ink};word-break:break-all;`,
} as const;

export { FONT };
