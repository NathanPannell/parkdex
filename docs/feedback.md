# Feedback and Kip email

Testers can send a bug, feature idea, or general note from the existing in-app feedback entry points. A receipt email is optional and independent of permission to follow up. Anonymous reports work without an account.

The app sends the version, build, platform, originating screen, and relevant park ID/name. Screenshots are explicitly selected, decoded, and re-encoded to remove image metadata. The app does not attach location coordinates or logs. A failed request keeps the draft and its submission ID so retrying a saved request cannot create another report.

## Storage and delivery

`POST /api/feedback` validates the report and saves it, its optional screenshot, and the two email intents in one Neon transaction. The `kip_feedback` schema is independent of park content. Email is attempted only after that transaction commits. A provider failure never rolls back a report.

The operator notification contains the report and a link to its private review page. The optional receipt thanks the tester with Kip artwork and a report reference. It does not repeat the tester's message, attachment, or app context. Both templates include HTML and plain text.

Staging uses `Kip at Parkdex <feedback@mail.parkdex.app>`. The receipt Reply-To is `parkdexapp@gmail.com`. An operator notification permits replying directly to the tester only when follow-up consent is checked; otherwise replies go to the Parkdex mailbox. The private notification recipient is configured separately with `OPERATOR_EMAIL`.

## Private review

Open `/feedback/review` and use the operator password supplied privately during deployment. The server verifies its PBKDF2 hash and issues a Secure, HttpOnly, SameSite=Strict session cookie. Lists, report details, status changes, and attachments require that session. The four statuses are New, Reviewing, Planned, and Closed.

Failed notifications can be retried from the report. Each audience has its own saved payload, delivery status, lease, and Resend idempotency key. Sent messages are skipped. If a provider outcome remains unknown after Resend's 24-hour idempotency window, check Resend and the relevant mailbox before confirming a retry that could duplicate an email. There is no background retry schedule or polling service.

## Development and release

Run `npm run typecheck`, `npm test`, and `npm run build`. `npm run email:preview` writes operator and receipt previews under `.codex/email-previews` and checks escaping, safe URLs, and receipt privacy.

Native field builds use `VITE_FEEDBACK_API_URL` from `.env.field`; web deployments use the same origin. The API requires `DATABASE_URL`, `SESSION_SECRET`, `OPERATOR_PASSWORD_HASH`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, and `OPERATOR_EMAIL`. The deployment helper sets the public URL, native origin allowlist, release SHA, and email mode. Keep every secret out of Vite variables and source control.

Follow [delivery.md](delivery.md) for the isolated preview, exact staging release, and owned teardown. Preview mail is disabled and previews receive fresh database and operator credentials. Production promotion is a separate task.
