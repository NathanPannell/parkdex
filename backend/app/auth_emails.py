from dataclasses import dataclass
from html import escape


@dataclass(frozen=True)
class AuthEmail:
    subject: str
    text: str
    html: str


def verification_email(action_url: str) -> AuthEmail:
    return _auth_email(
        subject="Confirm your Parkdex email",
        preheader="One quick step and your field journal is ready.",
        eyebrow="ACCOUNT SETUP",
        heading="Confirm your email",
        introduction=(
            "Welcome to Parkdex. Confirm this email address to finish setting up your "
            "account and keep your park progress connected to you."
        ),
        action_label="Confirm email",
        action_url=action_url,
        link_note=(
            "This link expires in 1 hour and can be used once. Requesting another "
            "verification email invalidates earlier unused links."
        ),
        ignore_note="Didn't create a Parkdex account? You can safely ignore this email.",
    )


def password_reset_email(action_url: str) -> AuthEmail:
    return _auth_email(
        subject="Reset your Parkdex password",
        preheader="Use this secure link to choose a new Parkdex password.",
        eyebrow="ACCOUNT SECURITY",
        heading="Choose a new password",
        introduction=(
            "We received a request to reset the password for your Parkdex account. Use "
            "the secure link below to choose a new one."
        ),
        action_label="Reset password",
        action_url=action_url,
        link_note=(
            "This link expires in 1 hour and can be used once. Requesting a new reset "
            "email invalidates earlier unused links."
        ),
        security_note="Choosing a new password signs out active sessions on this account.",
        ignore_note=(
            "Didn't request a password reset? You can ignore this email. Your password "
            "will not change unless you use the link and choose a new one."
        ),
    )


def _auth_email(
    *,
    subject: str,
    preheader: str,
    eyebrow: str,
    heading: str,
    introduction: str,
    action_label: str,
    action_url: str,
    link_note: str,
    ignore_note: str,
    security_note: str | None = None,
) -> AuthEmail:
    safe_url = escape(action_url, quote=True)
    text_sections = [
        "PARKDEX",
        heading,
        introduction,
        f"{action_label}:\n{action_url}",
        f"Link details\n{link_note}",
    ]
    if security_note:
        text_sections.append(f"Security note\n{security_note}")
    text_sections.extend([ignore_note, "— Parkdex\nA completionist map of British Columbia"])
    text = "\n\n".join(text_sections) + "\n"
    security_panel = ""
    if security_note:
        security_panel = f"""
            <tr>
              <td class="email-padding" style="padding:0 48px 26px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; background-color:#fff0e9; border:1px solid #f1c5b9; border-radius:8px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 4px; color:#a54839; font-family:Arial,sans-serif; font-size:11px; font-weight:800; letter-spacing:1.3px; line-height:16px;">SECURITY NOTE</p>
                      <p style="margin:0; color:#643f36; font-family:Arial,sans-serif; font-size:14px; line-height:22px;">{escape(security_note)}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>"""
    html = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>{escape(subject)}</title>
    <style>
      @media only screen and (max-width: 620px) {{
        .email-shell {{ width: 100% !important; }}
        .email-card {{ border-radius: 0 !important; }}
        .email-padding {{ padding-left: 24px !important; padding-right: 24px !important; }}
        .email-heading {{ font-size: 34px !important; line-height: 38px !important; }}
        .action-table {{ width: 100% !important; }}
        .action-button {{ display: block !important; text-align: center !important; }}
      }}
    </style>
  </head>
  <body style="margin:0; padding:0; background-color:#edf2e8; color:#173d32;">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent; mso-hide:all;">
      {escape(preheader)}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; background-color:#edf2e8;">
      <tr>
        <td align="center" style="padding:32px 12px;">
          <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-shell email-card" style="width:100%; max-width:600px; background-color:#fffaf0; border:1px solid #d8dfcd; border-radius:18px; overflow:hidden;">
            <tr>
              <td height="8" style="height:8px; background-color:#b9ea55; font-size:0; line-height:0;">&nbsp;</td>
            </tr>
            <tr>
              <td class="email-padding" style="padding:28px 48px 24px; background-color:#173d32;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td width="38" height="38" align="center" valign="middle" aria-hidden="true" style="width:38px; height:38px; border-radius:19px; background-color:#b9ea55; color:#173d32; font-family:Arial,sans-serif; font-size:17px; font-weight:800; line-height:38px;">P</td>
                    <td style="padding-left:12px; color:#fffaf0; font-family:Arial,sans-serif; font-size:19px; font-weight:800; letter-spacing:2.2px; line-height:24px;">PARKDEX</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td class="email-padding" style="padding:44px 48px 20px;">
                <p style="margin:0 0 12px; color:#2b7a78; font-family:Arial,sans-serif; font-size:12px; font-weight:800; letter-spacing:1.8px; line-height:18px;">{escape(eyebrow)}</p>
                <h1 class="email-heading" style="margin:0; color:#173d32; font-family:Georgia,'Times New Roman',serif; font-size:42px; font-weight:700; letter-spacing:-0.6px; line-height:46px;">{escape(heading)}</h1>
              </td>
            </tr>
            <tr>
              <td class="email-padding" style="padding:0 48px 30px;">
                <p style="margin:0; color:#365b50; font-family:Arial,sans-serif; font-size:17px; line-height:27px;">{escape(introduction)}</p>
              </td>
            </tr>
            <tr>
              <td class="email-padding" style="padding:0 48px 34px;">
                <!--[if mso]>
                <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="{safe_url}" style="height:52px; v-text-anchor:middle; width:180px;" arcsize="18%" strokecolor="#92c238" fillcolor="#b9ea55">
                  <w:anchorlock/>
                  <center style="color:#173d32; font-family:Arial,sans-serif; font-size:16px; font-weight:bold;">{escape(action_label)}</center>
                </v:roundrect>
                <![endif]-->
                <!--[if !mso]><!-->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="action-table">
                  <tr>
                    <td bgcolor="#b9ea55" style="border-radius:10px;">
                      <a href="{safe_url}" class="action-button" style="display:inline-block; padding:15px 26px; border:1px solid #92c238; border-radius:10px; color:#173d32; font-family:Arial,sans-serif; font-size:16px; font-weight:800; line-height:20px; text-decoration:none;">{escape(action_label)}</a>
                    </td>
                  </tr>
                </table>
                <!--<![endif]-->
              </td>
            </tr>
            <tr>
              <td class="email-padding" style="padding:0 48px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; background-color:#e8f3ee; border:1px solid #c9e3de; border-radius:8px;">
                  <tr>
                    <td style="padding:18px 20px;">
                      <p style="margin:0 0 4px; color:#2b7a78; font-family:Arial,sans-serif; font-size:11px; font-weight:800; letter-spacing:1.3px; line-height:16px;">LINK DETAILS</p>
                      <p style="margin:0; color:#28594a; font-family:Arial,sans-serif; font-size:14px; line-height:22px;">{escape(link_note)}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            {security_panel}
            <tr>
              <td class="email-padding" style="padding:0 48px 44px;">
                <p style="margin:0 0 7px; color:#587168; font-family:Arial,sans-serif; font-size:12px; line-height:18px;">Button not working? Copy and paste this link into your browser:</p>
                <p style="margin:0; font-family:Arial,sans-serif; font-size:12px; line-height:18px; overflow-wrap:anywhere; word-break:break-word;"><a href="{safe_url}" style="color:#2b7a78; text-decoration:underline;">{safe_url}</a></p>
              </td>
            </tr>
            <tr>
              <td class="email-padding" style="padding:0 48px 38px;">
                <p style="margin:0; color:#587168; font-family:Arial,sans-serif; font-size:13px; line-height:21px;">{escape(ignore_note)}</p>
              </td>
            </tr>
            <tr>
              <td class="email-padding" style="padding:22px 48px 26px; background-color:#f6f0dc; border-top:1px solid #e3ddc8;">
                <p style="margin:0 0 4px; color:#173d32; font-family:Arial,sans-serif; font-size:13px; font-weight:800; line-height:18px;">Parkdex</p>
                <p style="margin:0; color:#59675f; font-family:Arial,sans-serif; font-size:12px; line-height:18px;">A completionist map of British Columbia</p>
              </td>
            </tr>
          </table>
          <!--[if mso]></td></tr></table><![endif]-->
        </td>
      </tr>
    </table>
  </body>
</html>
"""
    return AuthEmail(subject=subject, text=text, html=html)
