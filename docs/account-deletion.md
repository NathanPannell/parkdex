# Account deletion beta

The self-service endpoint is `DELETE /api/account`. It requires the current
bearer session and this JSON body:

```json
{
  "confirm": "DELETE_ACCOUNT",
  "requestId": "<one UUID per confirmed deletion operation, reused for every retry>"
}
```

The successful response is:

```json
{
  "deleted": true,
  "photoCleanupPending": false
}
```

The account, sessions, action tokens, OAuth and MCP identities, visits, groups,
and other account-owned rows are deleted in one transaction. Private photo
object keys are recorded in the existing durable deletion outbox before the
account cascade. Object storage cleanup is attempted immediately after the
transaction commits. If a provider or connection is unavailable,
`photoCleanupPending` is `true`; the intent remains for a later manual run of
the existing one-shot cleanup command:

```text
python -m backend.app.photo_cleanup
```

This removes the authenticated account's server-side data. Guest history and
offline or other-device copies are separate local histories and are not
silently claimed or removed by this endpoint.

The request id and bearer are never stored. A matching request can be retried
for 24 hours after a lost response. The retry is accepted only when the exact
bearer and request id produce the same private receipt hash. A retry reports
the current state of the linked durable photo intents, so it changes to
`false` after the manual cleanup command succeeds. Expired receipts are
removed opportunistically by later deletion requests or the operator command;
there is no polling service or scheduled cleanup process.

## Owner-run support fulfilment

Use this only after the account owner has been verified through the support
process. Confirm ownership by sending a one-time confirmation to the current
registered address looked up independently in the account system. Do not trust
a supplied From or reply-to address, and never request a password or bearer
token. If ownership cannot be independently verified, do not delete the
account. The operator must also set a private confirmation secret in
`PARKDEX_ACCOUNT_DELETE_OPERATOR_CONFIRMATION`; the command reads the secret
through a hidden prompt and never accepts or prints a user bearer token.

Repeat the exact normalized account email and the destructive confirmation:

```text
PARKDEX_ACCOUNT_DELETE_OPERATOR_CONFIRMATION='operator-secret' \
  python -m backend.app.account_delete \
  --email 'person@example.com' \
  --confirm-email 'person@example.com' \
  --confirm DELETE_ACCOUNT
```

The process requires the configured target environment's database connection
and private-photo storage credentials. Verify that target before running it.
It performs the same transaction and outbox enqueue as self-service deletion,
attempts immediate photo cleanup, and prints the deletion result plus the opaque private-photo keys
needed to locate any durable intents, and exits. Save that owner-only report
with the support case before claiming physical cleanup is complete. If
`photoCleanupPending` is `true`, restore provider access and run the bounded
`backend.app.photo_cleanup` command manually, then verify the reported keys no
longer have rows in `photo_object_deletions`. Do not create a cron job or paste
a bearer token into support notes or shell history.
