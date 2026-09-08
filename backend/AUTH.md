# Account API

Account sessions use opaque bearer tokens. Only a SHA-256 digest of each random
256-bit token is stored, sessions expire after 30 days, and logout revokes the
current token. Passwords are stored with Argon2id using OWASP's 19 MiB, two-pass,
single-lane minimum. Login failures are limited to five per normalized email in
a 15-minute window. Each attempt is reserved atomically in a short transaction,
then the database connection is released before Argon2 runs. Login failures do
not reveal whether an email exists.

The application does not derive an IP limit from Railway's shared proxy address
or trust client-supplied forwarding headers. Broad request and registration abuse
controls belong at a trusted ingress; they are not enforced by this account limit.

`POST /api/auth/register` and `POST /api/auth/login` accept `{email, password}`.
They return `{token, expiresAt, account, visitedIds, completedTrailIds}`. Use the
token as `Authorization: Bearer <token>` with `GET /api/auth/me`,
`POST /api/auth/logout`, `GET /api/places`, `PUT /api/visits/{placeId}`, and
`PUT /api/trails/{trailId}`. Trail writes accept `{completed}` and the two IDs
are `west_coast_trail` and `juan_de_fuca_trail`.

Anonymous progress continues to use `X-Collection-Key`. Normal progress requests
must send either that header or `Authorization`, never both. An authenticated
user may deliberately merge guest progress with `POST /api/account/import-guest`
using both headers. Import copies visits and trail completions, preserves the
guest collection, and is idempotent.

Password and session choices follow the OWASP
[Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html),
[Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html),
and [Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
guidance.
