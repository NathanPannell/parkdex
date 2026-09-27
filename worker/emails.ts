export type FeedbackEmailReport = {
  id: string;
  kind: "bug" | "idea" | "general";
  message: string;
  email: string | null;
  contact: boolean;
  context: {
    version: string;
    build?: string;
    platform: string;
    screen: string;
    parkId?: string | null;
    parkName?: string | null;
  };
  createdAt: string;
  hasScreenshot: boolean;
};

export type FeedbackEmailOptions = { appUrl: string };

export type FeedbackEmail = { subject: string; html: string; text: string };

const INK = "#14231c";
const INK_SOFT = "#526359";
const PAPER = "#fff8ec";
const PAPER_WARM = "#fbecd4";
const PAPER_PALE = "#fffdf8";
const CORAL = "#ffb4a5";
const ORANGE = "#ff5a1f";
const RULE = "#ead6b6";

const KIND_LABELS: Record<FeedbackEmailReport["kind"], string> = {
  bug: "Bug report",
  idea: "Idea",
  general: "General note",
};

const HEADLINES: Record<FeedbackEmailReport["kind"], string> = {
  bug: "A bug report needs a look.",
  idea: "A fresh idea for Parkdex.",
  general: "A new note for Parkdex.",
};

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPE[character]);
}

function textValue(value: string | null | undefined, fallback = "Not provided"): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function kindLabel(kind: FeedbackEmailReport["kind"]): string {
  return KIND_LABELS[kind] ?? "General note";
}

function referenceFor(id: string): string {
  const compact = id.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  return compact ? `PD-${compact}` : "PD-UNKNOWN";
}

function appBase(appUrl: string): URL {
  let base: URL;
  try {
    base = new URL(appUrl);
  } catch {
    throw new TypeError("appUrl must be an absolute HTTP or HTTPS URL");
  }

  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new TypeError("appUrl must use HTTP or HTTPS");
  }
  if (base.username || base.password) {
    throw new TypeError("appUrl must not contain credentials");
  }

  base.search = "";
  base.hash = "";
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  return base;
}

function appLink(base: URL, path: string): URL {
  return new URL(path.replace(/^\/+/, ""), base);
}

function reviewLink(report: FeedbackEmailReport, base: URL, attachment = false): string {
  const url = appLink(base, "feedback/review");
  url.searchParams.set("id", report.id);
  if (attachment) url.hash = "attachment";
  return url.toString();
}

function kipImageLink(base: URL): string {
  return appLink(base, "email/kip-wave.png").toString();
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";

  const formatted = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
  return `${formatted} UTC`;
}

function documentStart(title: string, preheader: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; supported-color-schemes: light; }
    body { margin: 0 !important; padding: 0 !important; background-color: ${PAPER_WARM}; }
    table { border-collapse: collapse; border-spacing: 0; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    a { color: ${INK}; }
    @media only screen and (max-width: 620px) {
      .email-shell { width: 100% !important; }
      .email-frame { border-radius: 20px !important; }
      .email-gutter { padding-left: 20px !important; padding-right: 20px !important; }
      .hero-copy, .hero-art { display: block !important; width: 100% !important; }
      .hero-copy { padding-bottom: 18px !important; }
      .hero-art-cell { padding: 14px 0 !important; }
      .hero-image { width: 158px !important; height: 158px !important; }
      .hero-title { font-size: 31px !important; line-height: 1.08 !important; }
      .mobile-full { display: block !important; width: 100% !important; }
      .mobile-center { text-align: center !important; }
      .mobile-button { display: block !important; text-align: center !important; }
    }
    @media (prefers-color-scheme: dark) {
      body, .mail-canvas { background-color: ${PAPER_WARM} !important; }
      .email-frame, .mail-paper { background-color: ${PAPER} !important; color: ${INK} !important; }
      .mail-hero { background-color: ${PAPER_WARM} !important; }
      .mail-art { background-color: ${CORAL} !important; }
      .mail-ink { color: ${INK} !important; }
      .mail-muted { color: ${INK_SOFT} !important; }
      .mail-rule { border-color: ${RULE} !important; }
      .mail-message { background-color: ${PAPER_PALE} !important; color: ${INK} !important; }
      .mail-button { background-color: ${ORANGE} !important; color: ${INK} !important; }
    }
    [data-ogsc] .mail-canvas { background-color: ${PAPER_WARM} !important; }
    [data-ogsc] .email-frame, [data-ogsc] .mail-paper { background-color: ${PAPER} !important; color: ${INK} !important; }
    [data-ogsc] .mail-hero { background-color: ${PAPER_WARM} !important; }
    [data-ogsc] .mail-art { background-color: ${CORAL} !important; }
    [data-ogsc] .mail-ink { color: ${INK} !important; }
    [data-ogsc] .mail-muted { color: ${INK_SOFT} !important; }
    [data-ogsc] .mail-message { background-color: ${PAPER_PALE} !important; color: ${INK} !important; }
    [data-ogsc] .mail-button { background-color: ${ORANGE} !important; color: ${INK} !important; }
  </style>
</head>
<body class="mail-canvas" bgcolor="${PAPER_WARM}" style="margin:0;padding:0;background-color:${PAPER_WARM};color:${INK};font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;">${escapeHtml(preheader)}</div>
  <table role="presentation" class="mail-canvas" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAPER_WARM}" style="width:100%;background-color:${PAPER_WARM};">
    <tr>
      <td align="center" style="padding:28px 12px 36px;">
        <!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" class="email-shell email-frame mail-paper" width="600" align="center" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAPER}" style="width:100%;max-width:600px;background-color:${PAPER};border:2px solid ${INK};border-radius:28px;box-shadow:0 6px 0 ${INK};overflow:hidden;">
          <tr>
            <td class="mail-paper email-gutter" bgcolor="${PAPER}" style="padding:21px 30px 18px;background-color:${PAPER};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="left" valign="middle" style="font-family:'Trebuchet MS',Arial,sans-serif;font-size:22px;font-weight:800;letter-spacing:-1px;line-height:1;color:${INK};">
                    <span style="display:inline-block;width:11px;height:11px;margin:0 8px 1px 0;border-radius:50%;background-color:${ORANGE};vertical-align:middle;"></span><span class="mail-ink" style="color:${INK};">parkdex</span>
                  </td>
                  <td align="right" valign="middle" class="mail-muted" style="font-family:Arial,Helvetica,sans-serif;color:${INK_SOFT};font-size:12px;font-weight:700;letter-spacing:1.3px;text-transform:uppercase;">Feedback desk</td>
                </tr>
              </table>
            </td>
          </tr>`;
}

function hero(report: FeedbackEmailReport, base: URL, headline: string, support: string): string {
  const image = escapeHtml(kipImageLink(base));
  const label = escapeHtml(kindLabel(report.kind));
  const reference = escapeHtml(referenceFor(report.id));
  return `
          <tr>
            <td class="mail-hero email-gutter" bgcolor="${PAPER_WARM}" style="padding:30px;background-color:${PAPER_WARM};border-top:2px solid ${INK};border-bottom:2px solid ${INK};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="hero-copy" width="58%" valign="middle" style="width:58%;padding-right:16px;">
                    <h1 class="hero-title mail-ink" style="margin:0;color:${INK};font-family:'Trebuchet MS',Arial,sans-serif;font-size:35px;font-weight:800;line-height:1.06;letter-spacing:-1.2px;">${escapeHtml(headline)}</h1>
                    <p class="mail-ink" style="margin:13px 0 0;color:${INK};font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;">${escapeHtml(support)}</p>
                    <p class="mail-muted" style="margin:16px 0 0;color:${INK_SOFT};font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:.6px;line-height:1.4;text-transform:uppercase;">${label} &nbsp; / &nbsp; ${reference}</p>
                  </td>
                  <td class="hero-art" width="42%" align="right" valign="middle" style="width:42%;">
                    <table role="presentation" class="mail-art" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CORAL}" style="background-color:${CORAL};border:2px solid ${INK};border-radius:28px;">
                      <tr>
                        <td class="hero-art-cell mobile-center" align="center" valign="middle" style="padding:8px 4px;">
                          <img class="hero-image" src="${image}" width="176" height="176" alt="Kip waves hello" style="display:block;width:176px;height:176px;max-width:100%;object-fit:contain;">
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`;
}

function closeDocument(footer = "Private report notification"): string {
  return `
          <tr>
            <td class="mail-paper email-gutter" bgcolor="${PAPER}" style="padding:22px 30px 27px;background-color:${PAPER};border-top:1px solid ${RULE};">
              <p class="mail-muted" style="margin:0;color:${INK_SOFT};font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.55;">Parkdex feedback desk<br>${escapeHtml(footer)}</p>
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

function detailRow(label: string, valueHtml: string): string {
  return `<tr>
    <th align="left" valign="top" class="mail-muted" style="width:122px;padding:12px 14px 12px 0;border-bottom:1px solid ${RULE};color:${INK_SOFT};font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;line-height:1.45;text-align:left;">${escapeHtml(label)}</th>
    <td valign="top" class="mail-ink" style="padding:12px 0;border-bottom:1px solid ${RULE};color:${INK};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;overflow-wrap:anywhere;word-break:break-word;">${valueHtml}</td>
  </tr>`;
}

function textDetail(label: string, value: string): string {
  return `${label}: ${value}`;
}

function reportRows(report: FeedbackEmailReport, reviewUrl: string): string {
  const context = report.context;
  const buildValue = context.build ? `${textValue(context.version)} / build ${context.build}` : textValue(context.version);
  const parkValue = [context.parkName, context.parkId].filter((part) => typeof part === "string" && part.trim()).join(" / ");
  const contactText = report.contact && report.email
    ? `Follow-up permitted. <span style="display:block;margin-top:3px;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(report.email)}</span>`
    : report.contact
      ? "Follow-up permitted, but no email address was included."
      : "Follow-up not permitted.";
  const screenshotText = report.hasScreenshot
    ? `<a href="${escapeHtml(reviewUrl)}" style="color:${INK};font-weight:700;text-decoration:underline;text-decoration-color:${ORANGE};text-underline-offset:3px;">View protected screenshot in private report</a>`
    : "No screenshot attached.";

  return [
    detailRow("Received", escapeHtml(formatTimestamp(report.createdAt))),
    detailRow("App version", escapeHtml(buildValue)),
    detailRow("Device", escapeHtml(textValue(context.platform))),
    detailRow("Screen", escapeHtml(textValue(context.screen))),
    ...(parkValue ? [detailRow("Park", escapeHtml(parkValue))] : []),
    detailRow("Contact", contactText),
    detailRow("Screenshot", screenshotText),
  ].join("");
}

export function renderOperatorEmail(report: FeedbackEmailReport, options: FeedbackEmailOptions): FeedbackEmail {
  const base = appBase(options.appUrl);
  const reportUrl = reviewLink(report, base);
  const screenshotUrl = reviewLink(report, base, true);
  const label = kindLabel(report.kind);
  const reference = referenceFor(report.id);
  const message = report.message || "(No message provided.)";
  const headline = HEADLINES[report.kind] ?? HEADLINES.general;
  const safeReportUrl = escapeHtml(reportUrl);

  const html = `${documentStart("New Parkdex feedback", `${label} ${reference} is ready to review.`)}
${hero(report, base, headline, "A new community note is ready in the Parkdex feedback desk.")}
          <tr>
            <td class="mail-paper email-gutter" bgcolor="${PAPER}" style="padding:27px 30px 0;background-color:${PAPER};">
              <h2 class="mail-ink" style="margin:0;color:${INK};font-family:'Trebuchet MS',Arial,sans-serif;font-size:22px;font-weight:800;line-height:1.15;letter-spacing:-.5px;">The message</h2>
              <div class="mail-message" dir="auto" style="margin-top:13px;padding:18px 20px;background-color:${PAPER_PALE};border:1px solid ${RULE};border-radius:16px;color:${INK};font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(message)}</div>
            </td>
          </tr>
          <tr>
            <td class="mail-paper email-gutter" bgcolor="${PAPER}" style="padding:27px 30px 0;background-color:${PAPER};">
              <h2 class="mail-ink" style="margin:0;color:${INK};font-family:'Trebuchet MS',Arial,sans-serif;font-size:22px;font-weight:800;line-height:1.15;letter-spacing:-.5px;">Details from the app</h2>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">
                ${reportRows(report, screenshotUrl)}
              </table>
            </td>
          </tr>
          <tr>
            <td class="mail-paper email-gutter" bgcolor="${PAPER}" style="padding:25px 30px 30px;background-color:${PAPER};">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" bgcolor="${ORANGE}" style="background-color:${ORANGE};border:2px solid ${INK};border-radius:16px;box-shadow:0 4px 0 ${INK};">
                    <a class="mail-button mobile-button" href="${safeReportUrl}" style="display:inline-block;padding:15px 22px;border-radius:14px;color:${INK};font-family:'Trebuchet MS',Arial,sans-serif;font-size:16px;font-weight:800;line-height:1.2;text-decoration:none;">Open private report</a>
                  </td>
                </tr>
              </table>
              <p class="mail-muted" style="margin:17px 0 0;color:${INK_SOFT};font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.55;">The review page keeps the report and any protected screenshot together.</p>
            </td>
          </tr>
${closeDocument()}`;

  const lines = [
    "PARKDEX FEEDBACK DESK",
    `${label} - ${reference}`,
    "",
    "The message:",
    message,
    "",
    "Details from the app",
    textDetail("Received", formatTimestamp(report.createdAt)),
    textDetail("App version", report.context.build ? `${textValue(report.context.version)} / build ${report.context.build}` : textValue(report.context.version)),
    textDetail("Device", textValue(report.context.platform)),
    textDetail("Screen", textValue(report.context.screen)),
    ...(report.context.parkName || report.context.parkId
      ? [textDetail("Park", [report.context.parkName, report.context.parkId].filter(Boolean).join(" / "))]
      : []),
    textDetail("Contact", report.contact && report.email ? `Follow-up permitted at ${report.email}` : report.contact ? "Follow-up permitted, but no email address was included" : "Follow-up not permitted"),
    textDetail("Screenshot", report.hasScreenshot ? `View protected screenshot in private report: ${screenshotUrl}` : "No screenshot attached"),
    "",
    `Open private report: ${reportUrl}`,
  ];

  return {
    subject: `Parkdex - ${label} feedback - ${reference}`,
    html,
    text: lines.join("\n"),
  };
}

export function renderReceiptEmail(report: FeedbackEmailReport, options: FeedbackEmailOptions): FeedbackEmail {
  const base = appBase(options.appUrl);
  const appUrl = appLink(base, "").toString();
  const label = kindLabel(report.kind);
  const reference = referenceFor(report.id);
  const followup = report.contact && report.email
    ? "You gave permission for a follow-up. If a conversation would help, the Parkdex team may use the address you shared."
    : report.contact
      ? "You gave permission for a follow-up, but no email address was included with the report."
      : "You did not give permission for a follow-up. This message simply confirms that your feedback was saved.";
  const safeAppUrl = escapeHtml(appUrl);

  const html = `${documentStart("Thanks for your Parkdex feedback", "Your feedback has been saved. Thanks for helping shape Parkdex.")}
${hero(report, base, "Thanks for your note.", "Your feedback has been saved. Thanks for helping make Parkdex better.")}
          <tr>
            <td class="mail-paper email-gutter" bgcolor="${PAPER}" style="padding:27px 30px 0;background-color:${PAPER};">
              <h2 class="mail-ink" style="margin:0;color:${INK};font-family:'Trebuchet MS',Arial,sans-serif;font-size:22px;font-weight:800;line-height:1.15;letter-spacing:-.5px;">Your reference</h2>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">
                ${detailRow("Feedback type", escapeHtml(label))}
                ${detailRow("Reference", escapeHtml(reference))}
              </table>
              <p class="mail-ink" style="margin:21px 0 0;color:${INK};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;">${escapeHtml(followup)}</p>
            </td>
          </tr>
          <tr>
            <td class="mail-paper email-gutter" bgcolor="${PAPER}" style="padding:25px 30px 30px;background-color:${PAPER};">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" bgcolor="${ORANGE}" style="background-color:${ORANGE};border:2px solid ${INK};border-radius:16px;box-shadow:0 4px 0 ${INK};">
                    <a class="mail-button mobile-button" href="${safeAppUrl}" style="display:inline-block;padding:15px 22px;border-radius:14px;color:${INK};font-family:'Trebuchet MS',Arial,sans-serif;font-size:16px;font-weight:800;line-height:1.2;text-decoration:none;">Back to Parkdex</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
${closeDocument("Feedback receipt")}`;

  const lines = [
    "Thanks for your note, from Parkdex.",
    "",
    "Your feedback has been saved. Thanks for helping make Parkdex better.",
    "",
    "Your reference",
    textDetail("Feedback type", label),
    textDetail("Reference", reference),
    "",
    followup,
    "",
    `Back to Parkdex: ${appUrl}`,
  ];

  return {
    subject: "Parkdex got your note",
    html,
    text: lines.join("\n"),
  };
}
