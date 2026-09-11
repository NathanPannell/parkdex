# Account email delivery

Parkdex account verification and password-reset messages use the backend's explicitly selected provider. The links in those messages are built from `APP_PUBLIC_URL`; the frontend's `NEXT_PUBLIC_API_BASE_URL` only selects the API and is configured separately.

## Resend

1. Create a Resend sending-only API key and verify a sending domain in Resend. Add the domain's DNS records before sending real mail.
2. Set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, and `RESEND_FROM` (for example, `Parkdex <no-reply@your-verified-domain>`). `RESEND_API_URL` normally stays at `https://api.resend.com/emails`.
3. Set `APP_PUBLIC_URL` to the browser URL for the environment, such as `https://staging.parkdex.app` or an isolated preview URL.
4. Set the frontend build's `NEXT_PUBLIC_API_BASE_URL` to that environment's API URL.

SMTP remains available for local and test environments with `EMAIL_PROVIDER=smtp` and the existing `SMTP_*` settings. Automated tests mock the provider and must not use production recipients or credentials; preview environments should use a verified non-production sender and an isolated recipient policy until Resend/domain setup is approved.
