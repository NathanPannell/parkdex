"""Owner-run account deletion fulfilment command.

This is deliberately a one-shot command.  It uses the same transaction and
photo outbox service as the authenticated API, then exits so operations can
choose when to retry durable photo cleanup with the existing command.
"""

import argparse
from contextlib import contextmanager
import getpass
import json
import os
import secrets
import sys

from backend.app.account_deletion import (
    delete_account_rows,
    purge_expired_account_deletion_receipts,
)
from backend.app.db import close_pool, connection, open_pool
from backend.app.main import settle_photo_object_deletions


OPERATOR_CONFIRMATION_ENV = "PARKDEX_ACCOUNT_DELETE_OPERATOR_CONFIRMATION"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Permanently delete one Parkdex account by exact email."
    )
    parser.add_argument("--email", required=True, help="Exact account email.")
    parser.add_argument(
        "--confirm-email",
        required=True,
        help="Repeat the exact account email before deletion.",
    )
    parser.add_argument(
        "--confirm",
        required=True,
        choices=("DELETE_ACCOUNT",),
        help="Explicit destructive-action confirmation.",
    )
    return parser


def _normalized_email(value: str) -> str:
    return value.strip().lower()


def _require_operator_confirmation() -> None:
    expected = os.environ.get(OPERATOR_CONFIRMATION_ENV)
    if not expected:
        raise RuntimeError(
            f"{OPERATOR_CONFIRMATION_ENV} must be set for the owner-only command"
        )
    supplied = getpass.getpass("Operator confirmation: ")
    if not secrets.compare_digest(supplied, expected):
        raise RuntimeError("Operator confirmation did not match")


def _delete_by_email(email: str) -> dict[str, object]:
    with contextmanager(connection)() as conn:
        if purge_expired_account_deletion_receipts(conn):
            conn.commit()
        account = conn.execute(
            "SELECT id FROM accounts WHERE email = %s",
            (email,),
        ).fetchone()
        if account is None:
            raise LookupError("No account matches the confirmed email")

        deleted = delete_account_rows(conn, str(account["id"]))
        conn.commit()

        photo_cleanup_pending = bool(deleted.photo_keys)
        if deleted.photo_keys:
            try:
                settle_photo_object_deletions(
                    list(deleted.photo_keys),
                    outcome_conn=conn,
                )
                remaining = conn.execute(
                    """
                    SELECT COUNT(*) AS count
                    FROM photo_object_deletions
                    WHERE object_key = ANY(%s)
                    """,
                    (list(deleted.photo_keys),),
                ).fetchone()
                photo_cleanup_pending = bool(remaining and remaining["count"])
                conn.commit()
            except Exception:
                # The account transaction is already durable.  Preserve an
                # honest, conservative result if this process cannot inspect
                # or refine the outbox state after the cascade.
                try:
                    conn.rollback()
                except Exception:
                    pass
                photo_cleanup_pending = True

    return {
        "deleted": True,
        "photoCleanupPending": photo_cleanup_pending,
        # The owner-only report lets support target the durable intents after
        # the account row and its email are gone, without exposing a bearer.
        "photoObjectKeys": list(deleted.photo_keys),
    }


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    email = _normalized_email(args.email)
    confirmed_email = _normalized_email(args.confirm_email)
    if not email or not secrets.compare_digest(email, confirmed_email):
        print("The exact account email must be repeated with --confirm-email.", file=sys.stderr)
        return 2

    try:
        _require_operator_confirmation()
        open_pool()
        result = _delete_by_email(email)
    except (LookupError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"Account deletion did not complete ({type(exc).__name__})", file=sys.stderr)
        return 1
    finally:
        close_pool()

    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
