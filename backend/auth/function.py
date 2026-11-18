"""
Auth service: registration, login and session management.

Reached as /api/auth/* (the local proxy and CloudFront both route here).

    GET  /            service health
    POST /register    create an employee account (acme.inc emails only)
    POST /login       exchange email + password for tokens
    POST /refresh     exchange a refresh token for a new token pair
    GET  /me          the signed-in user
    POST /logout      revoke every token issued to the signed-in user

Errors always look like: {"error": {"code": "...", "message": "...", "details": {...}}}
"""

import base64
import json
import logging
import os
import re
import secrets
import time
import uuid

import bcrypt
import jwt
import psycopg
from psycopg.rows import dict_row

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

IS_LOCAL = os.getenv("IS_LOCAL", "false") == "true"
ALLOWED_EMAIL_DOMAIN = "acme.inc"  # also enforced by a CHECK on users.email
ACCESS_TOKEN_TTL = int(os.getenv("ACCESS_TOKEN_TTL_SECONDS", str(15 * 60)))
REFRESH_TOKEN_TTL = int(os.getenv("REFRESH_TOKEN_TTL_SECONDS", str(7 * 24 * 60 * 60)))
# Lambdas run with 128 MB, where CPU is throttled: cost 10 keeps login fast enough.
BCRYPT_ROUNDS = int(os.getenv("BCRYPT_ROUNDS", "10"))
# First facility admin, created only when no admin exists yet.
SEED_ADMIN_EMAIL = os.getenv("SEED_ADMIN_EMAIL", f"admin@{ALLOWED_EMAIL_DOMAIN}")
SEED_ADMIN_PASSWORD = os.getenv("SEED_ADMIN_PASSWORD", "Admin#12345")

ROLES = ("EMPLOYEE", "ENGINEER", "ADMIN")
PASSWORD_MIN_LENGTH = 8
PASSWORD_MAX_BYTES = 72  # bcrypt ignores anything beyond 72 bytes


def pg_conninfo():
    """Connection string from the injected variables. Aurora requires SSL; local has none."""
    parts = {
        "host": os.getenv("POSTGRES_HOST", "localhost"),
        "port": os.getenv("POSTGRES_PORT", "5432"),
        "user": os.getenv("POSTGRES_USER", "postgres"),
        "password": os.getenv("POSTGRES_PASS", "postgres123"),
        "dbname": os.getenv("POSTGRES_NAME", "postgres"),
        "connect_timeout": "15",
    }
    if not IS_LOCAL:
        parts["sslmode"] = "require"
    return " ".join(f"{key}={value}" for key, value in parts.items())


# ---------------------------------------------------------------------------
# Errors and responses
# ---------------------------------------------------------------------------


class ApiError(Exception):
    """An error that maps directly onto an HTTP response."""

    def __init__(self, status, code, message, details=None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details


def respond(status, body=None):
    if body is None:
        return {"statusCode": status, "headers": {}, "body": ""}
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=str),
    }


def respond_error(error):
    payload = {"code": error.code, "message": error.message}
    if error.details:
        payload["details"] = error.details
    return respond(error.status, {"error": payload})


# ---------------------------------------------------------------------------
# Database (one connection reused across warm invocations)
# ---------------------------------------------------------------------------

# The two tables this service needs, identical to their definitions in
# backend/_db/schema.sql. Creating them here means auth also works on a database (e.g. Aurora)
# where schema.sql has not been run yet; where it has, these statements do nothing.
SCHEMA = [
    # Serialises table creation when several containers cold-start at once.
    "SELECT pg_advisory_xact_lock(7301001)",
    f"""
    CREATE TABLE IF NOT EXISTS users (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email         TEXT NOT NULL UNIQUE
                      CHECK (email = lower(email) AND email LIKE '%_@{ALLOWED_EMAIL_DOMAIN}'),
        full_name     TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ({", ".join(repr(r) for r in ROLES)})),
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        token_version INTEGER NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS app_secrets (
        name  TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )
    """,
]

_conn = None
_ready = False
_jwt_secret = os.getenv("JWT_SECRET", "")


def query(sql, params=None, fetch=True):
    """Run one statement in its own transaction and return the first row (or None)."""
    global _conn
    try:
        if _conn is None or _conn.closed:
            _conn = psycopg.connect(pg_conninfo(), row_factory=dict_row)
        with _conn.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone() if fetch and cur.description else None
        _conn.commit()
        return row
    except psycopg.OperationalError:
        _conn = None  # broken connection: reconnect on the next call
        raise
    except Exception:
        _conn.rollback()
        raise


def bootstrap():
    """Create tables, the JWT signing key and the first admin. Runs once per container."""
    global _ready, _jwt_secret
    if _ready:
        return
    # One round trip, one transaction: the advisory lock is held until every table exists.
    query(";".join(SCHEMA), fetch=False)
    if not _jwt_secret:
        # No secret configured: generate one once and share it through the database.
        query(
            "INSERT INTO app_secrets (name, value) VALUES ('jwt_secret', %s) ON CONFLICT DO NOTHING",
            (secrets.token_urlsafe(48),),
            fetch=False,
        )
        _jwt_secret = query("SELECT value FROM app_secrets WHERE name = 'jwt_secret'")["value"]
    if not query("SELECT 1 AS found FROM users WHERE role = 'ADMIN' LIMIT 1"):
        query(
            "INSERT INTO users (email, full_name, password_hash, role) "
            "VALUES (%s, 'Facility Admin', %s, 'ADMIN') ON CONFLICT (email) DO NOTHING",
            (SEED_ADMIN_EMAIL.lower(), hash_password(SEED_ADMIN_PASSWORD)),
            fetch=False,
        )
        logger.info("Seeded initial admin account %s", SEED_ADMIN_EMAIL)
    _ready = True


def find_user_by_email(email):
    return query("SELECT * FROM users WHERE email = %s", (email,))


def find_user_by_id(user_id):
    try:
        return query("SELECT * FROM users WHERE id = %s", (uuid.UUID(str(user_id)),))
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

_EMAIL_RE = re.compile(r"^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$")


def clean_email(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Email is required")
    value = value.strip().lower()
    if len(value) > 254 or not _EMAIL_RE.match(value):
        raise ValueError("Enter a valid email address")
    return value


def clean_company_email(value):
    value = clean_email(value)
    if not value.endswith("@" + ALLOWED_EMAIL_DOMAIN):
        raise ValueError(f"Only @{ALLOWED_EMAIL_DOMAIN} email addresses can register")
    return value


def clean_new_password(value):
    if not isinstance(value, str) or not value:
        raise ValueError("Password is required")
    if len(value) < PASSWORD_MIN_LENGTH:
        raise ValueError(f"Password must be at least {PASSWORD_MIN_LENGTH} characters")
    if len(value.encode("utf-8")) > PASSWORD_MAX_BYTES:
        raise ValueError(f"Password must be at most {PASSWORD_MAX_BYTES} bytes")
    if not (re.search(r"[A-Za-z]", value) and re.search(r"\d", value)):
        raise ValueError("Password must contain at least one letter and one number")
    return value


def clean_text(label, max_length):
    def clean(value):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{label} is required")
        if len(value.strip()) > max_length:
            raise ValueError(f"{label} must be at most {max_length} characters")
        return value.strip()

    return clean


def validate(data, rules):
    """Apply {field: cleaner} to data, reporting every failed field in one 400."""
    cleaned, errors = {}, {}
    for field, cleaner in rules.items():
        try:
            cleaned[field] = cleaner(data.get(field))
        except ValueError as error:
            errors[field] = str(error)
    if errors:
        raise ApiError(400, "validation_error", "Some fields are invalid", errors)
    return cleaned


def json_body(event):
    raw = event.get("body")
    if not raw:
        raise ApiError(400, "validation_error", "Request body is required")
    try:
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw).decode("utf-8")
        data = json.loads(raw)
    except (TypeError, ValueError):
        raise ApiError(400, "validation_error", "Request body must be valid JSON") from None
    if not isinstance(data, dict):
        raise ApiError(400, "validation_error", "Request body must be a JSON object")
    return data


# ---------------------------------------------------------------------------
# Passwords and tokens
# ---------------------------------------------------------------------------

# Checked when the email is unknown, so both login failure paths take the same time.
_DUMMY_HASH = bcrypt.hashpw(b"timing-equaliser", bcrypt.gensalt(rounds=BCRYPT_ROUNDS))


def hash_password(password):
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=BCRYPT_ROUNDS)).decode("ascii")


def verify_password(password, password_hash):
    candidate = password.encode("utf-8")[:PASSWORD_MAX_BYTES]
    expected = password_hash.encode("ascii") if password_hash else _DUMMY_HASH
    return bcrypt.checkpw(candidate, expected) and bool(password_hash)


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
    return jwt.encode(claims, _jwt_secret, algorithm="HS256")


def user_from_token(token, token_type):
    """Return the live user behind a valid token of the given type, or raise a 401."""
    try:
        claims = jwt.decode(
            token, _jwt_secret, algorithms=["HS256"], options={"require": ["sub", "exp", "type", "ver"]}
        )
    except jwt.ExpiredSignatureError:
        raise ApiError(401, "token_expired", "Your session has expired") from None
    except jwt.InvalidTokenError:
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


def public_user(user):
    """The user fields that are safe to return to clients (never the password hash)."""
    return {
        "id": str(user["id"]),
        "email": user["email"],
        "full_name": user["full_name"],
        "role": user["role"],
        "created_at": user["created_at"].isoformat(),
    }


def session(user):
    return {
        "user": public_user(user),
        "access_token": issue_token(user, "access", ACCESS_TOKEN_TTL),
        "refresh_token": issue_token(user, "refresh", REFRESH_TOKEN_TTL),
        "token_type": "Bearer",
        "expires_in": ACCESS_TOKEN_TTL,
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def health(_event):
    return respond(200, {"service": "auth", "status": "ok"})


def register(event):
    """Self-registration always creates an employee; other roles are created by an admin."""
    fields = validate(
        json_body(event),
        {"email": clean_company_email, "full_name": clean_text("Full name", 100), "password": clean_new_password},
    )
    user = query(
        "INSERT INTO users (email, full_name, password_hash, role) VALUES (%s, %s, %s, 'EMPLOYEE') "
        "ON CONFLICT (email) DO NOTHING RETURNING *",
        (fields["email"], fields["full_name"], hash_password(fields["password"])),
    )
    if not user:
        message = "An account with this email already exists"
        raise ApiError(409, "conflict", message, {"email": message})
    return respond(201, session(user))


def login(event):
    fields = validate(json_body(event), {"email": clean_email, "password": clean_text("Password", 1024)})
    user = find_user_by_email(fields["email"])
    if not verify_password(fields["password"], user["password_hash"] if user else None):
        # Same answer for an unknown email and a wrong password.
        raise ApiError(401, "invalid_credentials", "Incorrect email or password")
    if not user["is_active"]:
        raise ApiError(403, "access_denied", "This account has been deactivated")
    return respond(200, session(user))


def refresh(event):
    fields = validate(json_body(event), {"refresh_token": clean_text("Refresh token", 4096)})
    return respond(200, session(user_from_token(fields["refresh_token"], "refresh")))


def me(event):
    return respond(200, {"user": public_user(current_user(event))})


def logout(event):
    user = current_user(event)
    query(
        "UPDATE users SET token_version = token_version + 1, updated_at = now() WHERE id = %s",
        (user["id"],),
        fetch=False,
    )
    return respond(204)


ROUTES = {
    ("GET", "/"): health,
    ("POST", "/register"): register,
    ("POST", "/login"): login,
    ("POST", "/refresh"): refresh,
    ("GET", "/me"): me,
    ("POST", "/logout"): logout,
}


def handler(event=None, context=None):
    """Lambda entry point: route the request and always return a well-formed response."""
    event = event or {}
    http = (event.get("requestContext") or {}).get("http") or {}
    method = (http.get("method") or "GET").upper()
    # CloudFront leaves '/api/auth' on the path; the local proxy strips it.
    path = "/" + re.sub(r"^/(api/)?auth(?=/|$)", "", event.get("rawPath") or "/").strip("/")
    try:
        bootstrap()
        route = ROUTES.get((method, path))
        if route:
            return route(event)
        if any(route_path == path for _, route_path in ROUTES):
            raise ApiError(405, "method_not_allowed", f"{method} is not allowed on {path}")
        raise ApiError(404, "not_found", f"No route for {method} {path}")
    except ApiError as error:
        return respond_error(error)
    except Exception:  # noqa: BLE001 - never leak internals to the client
        logger.exception("Unhandled error on %s %s", method, path)
        return respond_error(ApiError(500, "internal_error", "An unexpected error occurred"))
