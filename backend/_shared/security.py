"""Passwords, JWTs and the permission checks every protected endpoint uses."""

import os
import secrets
import time
import uuid

import bcrypt
import jwt

from db import query
from http_utils import ApiError

ROLES = ("EMPLOYEE", "ENGINEER", "ADMIN")

ACCESS_TOKEN_TTL = int(os.getenv("ACCESS_TOKEN_TTL_SECONDS", str(15 * 60)))
REFRESH_TOKEN_TTL = int(os.getenv("REFRESH_TOKEN_TTL_SECONDS", str(7 * 24 * 60 * 60)))
# Lambdas run with 128 MB, where CPU is throttled: cost 10 keeps login fast enough.
BCRYPT_ROUNDS = int(os.getenv("BCRYPT_ROUNDS", "10"))
PASSWORD_MAX_BYTES = 72  # bcrypt ignores anything beyond 72 bytes

_jwt_secret = os.getenv("JWT_SECRET", "")

# ---------------------------------------------------------------------------
# Passwords
# ---------------------------------------------------------------------------

# Checked when the email is unknown, so both login failure paths take the same time.
_DUMMY_HASH = bcrypt.hashpw(b"timing-equaliser", bcrypt.gensalt(rounds=BCRYPT_ROUNDS))


def hash_password(password):
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=BCRYPT_ROUNDS)).decode("ascii")


def verify_password(password, password_hash):
    """True only for the right password; a missing hash still costs one comparison."""
    candidate = password.encode("utf-8", "surrogatepass")  # never raises, whatever JSON sent
    expected = password_hash.encode("ascii") if password_hash else _DUMMY_HASH
    matches = bcrypt.checkpw(candidate[:PASSWORD_MAX_BYTES], expected)
    # bcrypt ignores everything past 72 bytes, so a longer candidate must not be accepted
    # just because its first 72 bytes are right.
    return matches and bool(password_hash) and len(candidate) <= PASSWORD_MAX_BYTES


# ---------------------------------------------------------------------------
# Tokens
# ---------------------------------------------------------------------------


def _signing_key():
    """JWT_SECRET if configured; otherwise a key generated once and shared via app_secrets."""
    global _jwt_secret
    if not _jwt_secret:
        query(
            "INSERT INTO app_secrets (name, value) VALUES ('jwt_secret', %s) ON CONFLICT DO NOTHING",
            (secrets.token_urlsafe(48),),
            fetch=False,
        )
        _jwt_secret = query("SELECT value FROM app_secrets WHERE name = 'jwt_secret'")["value"]
    return _jwt_secret


def issue_token(user, token_type, ttl):
    now = int(time.time())
    claims = {
        "sub": str(user["id"]),
        "role": user["role"],
        "ver": user["token_version"],
        "type": token_type,
        "iat": now,
        "exp": now + ttl,
    }
    return jwt.encode(claims, _signing_key(), algorithm="HS256")


def issue_session_tokens(user):
    return {
        "access_token": issue_token(user, "access", ACCESS_TOKEN_TTL),
        "refresh_token": issue_token(user, "refresh", REFRESH_TOKEN_TTL),
        "token_type": "Bearer",
        "expires_in": ACCESS_TOKEN_TTL,
    }


def find_user_by_id(user_id):
    try:
        return query("SELECT * FROM users WHERE id = %s", (uuid.UUID(str(user_id)),))
    except ValueError:
        return None


def user_from_token(token, token_type):
    """Return the live user behind a valid token of the given type, or raise a 401."""
    try:
        claims = jwt.decode(
            token, _signing_key(), algorithms=["HS256"], options={"require": ["sub", "exp", "type", "ver"]}
        )
    except jwt.ExpiredSignatureError:
        raise ApiError(401, "token_expired", "Your session has expired") from None
    except (jwt.InvalidTokenError, UnicodeError):
        raise ApiError(401, "invalid_token", "Invalid authentication token") from None
    user = find_user_by_id(claims["sub"]) if claims["type"] == token_type else None
    # token_version changes on logout, which revokes everything issued before it.
    if not user or not user["is_active"] or user["token_version"] != claims["ver"]:
        raise ApiError(401, "invalid_token", "Your session is no longer valid")
    return user

def current_user(event):
    """Authentication step for protected routes: the caller, from the Bearer token."""
    headers = {str(k).lower(): v for k, v in (event.get("headers") or {}).items()}
    scheme, _, token = headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise ApiError(401, "unauthorized", "Authentication is required")
    return user_from_token(token.strip(), "access")


def require_role(user, *allowed):
    """Authorization step: the single place role permissions are enforced."""
    if user["role"] not in allowed:
        raise ApiError(403, "access_denied", "You do not have permission to perform this action")
