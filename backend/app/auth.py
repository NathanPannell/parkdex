import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from fastapi import HTTPException
from psycopg import Connection


SESSION_LIFETIME = timedelta(days=30)
LOGIN_WINDOW = timedelta(minutes=15)
LOGIN_FAILURE_LIMIT = 5
LOGIN_BLOCK_TIME = timedelta(minutes=15)
TOKEN_PATTERN_LENGTH = 43

password_hasher = PasswordHasher(
    time_cost=2,
    memory_cost=19_456,
    parallelism=1,
    hash_len=32,
    salt_len=16,
)
# A real Argon2id hash makes unknown-account logins take the same expensive path.
DUMMY_PASSWORD_HASH = password_hasher.hash(secrets.token_urlsafe(32))


@dataclass(frozen=True)
class AccountIdentity:
    account_id: str
    email: str
    session_hash: str


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return password_hasher.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def create_session(conn: Connection, account_id: str) -> tuple[str, datetime]:
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + SESSION_LIFETIME
    conn.execute(
        """
        INSERT INTO account_sessions (token_hash, account_id, expires_at)
        VALUES (%s, %s, %s)
        """,
        (sha256_hex(token), account_id, expires_at),
    )
    return token, expires_at


def authenticate_bearer(conn: Connection, authorization: str | None) -> AccountIdentity | None:
    if authorization is None:
        return None
    scheme, separator, token = authorization.partition(" ")
    if separator != " " or scheme.lower() != "bearer" or not token or " " in token:
        raise HTTPException(status_code=401, detail="Invalid authentication credentials")
    if len(token) != TOKEN_PATTERN_LENGTH:
        raise HTTPException(status_code=401, detail="Invalid authentication credentials")
    token_hash = sha256_hex(token)
    row = conn.execute(
        """
        SELECT accounts.id, accounts.email
        FROM account_sessions
        JOIN accounts ON accounts.id = account_sessions.account_id
        WHERE account_sessions.token_hash = %s
          AND account_sessions.revoked_at IS NULL
          AND account_sessions.expires_at > NOW()
        """,
        (token_hash,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=401, detail="Invalid authentication credentials")
    return AccountIdentity(str(row["id"]), row["email"], token_hash)


def require_bearer(conn: Connection, authorization: str | None) -> AccountIdentity:
    identity = authenticate_bearer(conn, authorization)
    if identity is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return identity


def login_scope(email: str) -> str:
    return sha256_hex(f"login-email:{email}")


def reserve_login_attempt(conn: Connection, email: str) -> None:
    """Atomically reserve one of five attempts without holding the row while hashing."""
    now = datetime.now(timezone.utc)
    window_start = now - LOGIN_WINDOW
    blocked_until = now + LOGIN_BLOCK_TIME
    row = conn.execute(
        """
        INSERT INTO auth_login_attempts (scope_hash, failure_count, window_started_at)
        VALUES (%s, 1, %s)
        ON CONFLICT (scope_hash) DO UPDATE SET
            failure_count = CASE
                WHEN auth_login_attempts.blocked_until <= %s
                  OR auth_login_attempts.window_started_at < %s THEN 1
                ELSE auth_login_attempts.failure_count + 1
            END,
            window_started_at = CASE
                WHEN auth_login_attempts.blocked_until <= %s
                  OR auth_login_attempts.window_started_at < %s THEN %s
                ELSE auth_login_attempts.window_started_at
            END,
            blocked_until = CASE
                WHEN auth_login_attempts.blocked_until <= %s
                  OR auth_login_attempts.window_started_at < %s THEN NULL
                WHEN auth_login_attempts.failure_count + 1 >= %s THEN %s
                ELSE auth_login_attempts.blocked_until
            END
        WHERE auth_login_attempts.blocked_until <= %s
           OR (
               auth_login_attempts.blocked_until IS NULL
               AND (
                   auth_login_attempts.window_started_at < %s
                   OR auth_login_attempts.failure_count < %s
               )
           )
        RETURNING blocked_until
        """,
        (
            login_scope(email),
            now,
            now,
            window_start,
            now,
            window_start,
            now,
            now,
            window_start,
            LOGIN_FAILURE_LIMIT,
            blocked_until,
            now,
            window_start,
            LOGIN_FAILURE_LIMIT,
        ),
    ).fetchone()
    if row is not None:
        return
    blocked = conn.execute(
        "SELECT blocked_until FROM auth_login_attempts WHERE scope_hash = %s",
        (login_scope(email),),
    ).fetchone()
    retry_after = 1
    if blocked and blocked["blocked_until"] and blocked["blocked_until"] > now:
        retry_after = max(1, int((blocked["blocked_until"] - now).total_seconds()))
    raise HTTPException(
        status_code=429,
        detail="Too many login attempts. Try again later.",
        headers={"Retry-After": str(retry_after)},
    )


def clear_login_failures(conn: Connection, email: str) -> None:
    conn.execute("DELETE FROM auth_login_attempts WHERE scope_hash = %s", (login_scope(email),))
