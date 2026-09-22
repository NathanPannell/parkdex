"""Shared account deletion transaction primitives.

The API and the owner-run support command both use this module so account
deletion cannot drift between authenticated self-service and manual fulfilment.
The transaction only removes database state and records private-photo object
keys in the existing durable outbox.  Object storage is handled after commit.
"""

from dataclasses import dataclass
import hashlib

from psycopg import Connection

from backend.app.auth import TOKEN_PATTERN_LENGTH, login_scope, sha256_hex


@dataclass(frozen=True)
class DeletedAccount:
    account_id: str
    email: str
    photo_keys: tuple[str, ...]


def account_deletion_receipt_hash(
    authorization: str | None, request_id: object
) -> str | None:
    """Hash a well-shaped bearer plus request id without retaining either value."""

    if authorization is None:
        return None
    scheme, separator, token = authorization.partition(" ")
    if (
        separator != " "
        or scheme.lower() != "bearer"
        or not token
        or " " in token
        or len(token) != TOKEN_PATTERN_LENGTH
    ):
        return None
    return hashlib.sha256(
        f"parkdex-account-delete:{token}:{request_id}".encode("utf-8")
    ).hexdigest()


def account_deletion_receipt(conn: Connection, request_hash: str | None):
    if request_hash is None:
        return None
    return conn.execute(
        """
        SELECT CASE
                   WHEN receipt.photo_cleanup_pending THEN EXISTS (
                       SELECT 1
                       FROM photo_object_deletions AS deletion
                       WHERE deletion.account_deletion_request_hash = receipt.request_hash
                   )
                   ELSE FALSE
               END AS photo_cleanup_pending
        FROM account_deletion_receipts AS receipt
        WHERE receipt.request_hash = %s AND receipt.expires_at > NOW()
        """,
        (request_hash,),
    ).fetchone()


def purge_expired_account_deletion_receipts(
    conn: Connection, *, limit: int = 100
) -> int:
    """Remove a bounded number of expired non-PII retry receipts."""

    result = conn.execute(
        """
        WITH expired AS (
            SELECT ctid
            FROM account_deletion_receipts
            WHERE expires_at <= NOW()
            ORDER BY expires_at
            LIMIT %s
        )
        DELETE FROM account_deletion_receipts AS receipt
        USING expired
        WHERE receipt.ctid = expired.ctid
        """,
        (limit,),
    )
    return result.rowcount


def account_deletion_result(*, photo_cleanup_pending: bool) -> dict[str, object]:
    return {"deleted": True, "photo_cleanup_pending": photo_cleanup_pending}


def enqueue_photo_object_deletions(
    conn: Connection,
    account_id: str,
    keys: list[str],
    *,
    request_hash: str | None = None,
) -> None:
    """Persist object cleanup before account-owned metadata is cascaded."""

    for key in sorted(set(keys)):
        conn.execute(
            """
            INSERT INTO photo_object_deletions (object_key, account_id)
            VALUES (%s, %s)
            ON CONFLICT (object_key) DO NOTHING
            """,
            (key, account_id),
        )
    if request_hash is not None and keys:
        conn.execute(
            """
            UPDATE photo_object_deletions
            SET account_deletion_request_hash = %s
            WHERE object_key = ANY(%s)
              AND (account_id = %s OR account_id IS NULL)
            """,
            (request_hash, sorted(set(keys)), account_id),
        )


def _photo_keys_for_account(conn: Connection, account_id: str) -> list[str]:
    claim_keys = conn.execute(
        """
        SELECT photo_object_key
        FROM account_visit_claims
        WHERE account_id = %s AND photo_object_key IS NOT NULL
        """,
        (account_id,),
    ).fetchall()
    queued_keys = conn.execute(
        """
        SELECT object_key
        FROM photo_object_deletions
        WHERE account_id = %s
        """,
        (account_id,),
    ).fetchall()
    return sorted(
        {
            str(row["photo_object_key"])
            for row in claim_keys
            if row["photo_object_key"]
        }
        | {str(row["object_key"]) for row in queued_keys if row["object_key"]}
    )


def _delete_unlinked_auth_artifacts(conn: Connection, *, account_id: str, email: str) -> None:
    """Remove account/email scoped abuse rows that have no account FK.

    Global counters and state or client scopes are deliberately untouched.
    """

    email_hash = sha256_hex(email)
    account_hash = sha256_hex(account_id)
    conn.execute(
        "DELETE FROM auth_login_attempts WHERE scope_hash = %s",
        (login_scope(email),),
    )
    conn.execute(
        "DELETE FROM auth_rate_limits WHERE scope_hash = ANY(%s)",
        ([email_hash, account_hash],),
    )
    conn.execute(
        "DELETE FROM auth_security_events WHERE scope_hash = ANY(%s)",
        ([email_hash, account_hash],),
    )


def delete_account_rows(
    conn: Connection,
    account_id: str,
    *,
    request_hash: str | None = None,
) -> DeletedAccount:
    """Delete one account inside the caller's transaction.

    The account row is locked first.  Every current or already queued private
    photo key is collected before the account cascade, and a self-service
    receipt is inserted in the same transaction when ``request_hash`` is set.
    The caller must commit before touching object storage.
    """

    account = conn.execute(
        "SELECT id, email FROM accounts WHERE id = %s FOR UPDATE",
        (account_id,),
    ).fetchone()
    if account is None:
        raise LookupError("Account not found")

    photo_keys = _photo_keys_for_account(conn, account_id)
    if request_hash is not None:
        # A stale receipt with the same request hash must not block a new
        # confirmed request.  Active receipts are impossible while the account
        # exists because insertion and account deletion commit together.
        conn.execute(
            "DELETE FROM account_deletion_receipts WHERE request_hash = %s AND expires_at <= NOW()",
            (request_hash,),
        )
        conn.execute(
            """
            INSERT INTO account_deletion_receipts
                (request_hash, photo_cleanup_pending, expires_at)
            VALUES (%s, %s, NOW() + INTERVAL '24 hours')
            ON CONFLICT (request_hash) DO NOTHING
            """,
            (request_hash, bool(photo_keys)),
        )

    enqueue_photo_object_deletions(
        conn,
        account_id,
        photo_keys,
        request_hash=request_hash,
    )
    _delete_unlinked_auth_artifacts(conn, account_id=account_id, email=account["email"])

    deleted = conn.execute(
        "DELETE FROM accounts WHERE id = %s RETURNING id",
        (account_id,),
    ).fetchone()
    if deleted is None:
        raise LookupError("Account not found")
    return DeletedAccount(
        account_id=str(account["id"]),
        email=str(account["email"]),
        photo_keys=tuple(photo_keys),
    )


def update_account_deletion_receipt(
    conn: Connection, request_hash: str, *, photo_cleanup_pending: bool
) -> None:
    conn.execute(
        """
        UPDATE account_deletion_receipts
        SET photo_cleanup_pending = %s
        WHERE request_hash = %s AND expires_at > NOW()
        """,
        (photo_cleanup_pending, request_hash),
    )
