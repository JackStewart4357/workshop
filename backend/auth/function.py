"""
Auth service: registration, login and session management.

Reached as /api/auth/* (the local proxy and CloudFront both route here).

    GET  /            service health
    POST /register    create an employee account (acme.inc emails only)
    POST /login       exchange email + password for tokens
    POST /refresh     exchange a refresh token for a new token pair
    GET  /me          the signed-in user
    POST /logout      revoke every token issued to the signed-in user

Shared building blocks live beside this file:
    db.py          database connection and query()
    http_utils.py  errors, responses, validation and routing
    security.py    passwords, tokens and role checks
"""

import logging
import os
import re

from db import IS_LOCAL, query
from http_utils import ApiError, clean_email, clean_text, dispatch, json_body, respond, validate
from security import (
    PASSWORD_MAX_BYTES,
    current_user,
    hash_password,
    issue_session_tokens,
    user_from_token,
    verify_password,
)

logger = logging.getLogger()
logger.setLevel(logging.INFO)

ALLOWED_EMAIL_DOMAIN = "acme.inc"  # also enforced by a CHECK on users.email
PASSWORD_MIN_LENGTH = 8
EMAIL_TAKEN = "An account with this email already exists"
# First facility admin, created only when no admin exists yet.
SEED_ADMIN_EMAIL = os.getenv("SEED_ADMIN_EMAIL", f"admin@{ALLOWED_EMAIL_DOMAIN}")
# The built-in password is for local development only. A deployed service must be given
# SEED_ADMIN_PASSWORD; without it no admin is created, rather than one with a known password.
SEED_ADMIN_PASSWORD = os.getenv("SEED_ADMIN_PASSWORD") or ("Admin#12345" if IS_LOCAL else "")

# ---------------------------------------------------------------------------
# One-time setup
# ---------------------------------------------------------------------------

# The tables (users, app_secrets) are created by backend/_db/schema.sql, which must be
# applied to the database before this service is used.

_ready = False


def bootstrap():
    """Create the first admin if there is none. Runs once per container."""
    global _ready
    if _ready:
        return
    if query("SELECT 1 AS found FROM users WHERE role = 'ADMIN' LIMIT 1"):
        pass
    elif not SEED_ADMIN_PASSWORD:
        logger.error("No admin account exists and SEED_ADMIN_PASSWORD is not set: no admin was created")
    else:
        # Hold the seed settings to the same rules as registration: an address the schema
        # rejects, or a password bcrypt would truncate, must not take the service down or
        # create an admin nobody can log in as.
        try:
            email = clean_company_email(SEED_ADMIN_EMAIL)
            password = clean_new_password(SEED_ADMIN_PASSWORD)
        except ValueError as error:
            logger.error("Seed admin settings are not usable (%s): no admin was created", error)
        else:
            seeded = query(
                "INSERT INTO users (email, full_name, password_hash, role) "
                "VALUES (%s, 'Facility Admin', %s, 'ADMIN') ON CONFLICT (email) DO NOTHING RETURNING id",
                (email, hash_password(password)),
            )
            if seeded:
                logger.info("Seeded initial admin account %s", email)
            else:
                logger.error("%s is already registered and is not an admin: no admin was created", email)
    _ready = True


# ---------------------------------------------------------------------------
# Auth-specific validation
# ---------------------------------------------------------------------------


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
    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise ValueError("Password contains characters that are not valid text")
    if len(value.encode("utf-8")) > PASSWORD_MAX_BYTES:
        raise ValueError(f"Password must be at most {PASSWORD_MAX_BYTES} bytes")
    if not (re.search(r"[A-Za-z]", value) and re.search(r"\d", value)):
        raise ValueError("Password must contain at least one letter and one number")
    return value


def clean_login_password(value):
    """Required, but never trimmed: it must match what register hashed, byte for byte."""
    if not isinstance(value, str) or not value:
        raise ValueError("Password is required")
    if len(value) > 1024:
        raise ValueError("Password must be at most 1024 characters")
    return value


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


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
    return {"user": public_user(user), **issue_session_tokens(user)}


def health(_event):
    return respond(200, {"service": "auth", "status": "ok"})


def register(event):
    """Self-registration always creates an employee; other roles are created by an admin."""
    fields = validate(
        json_body(event),
        {"email": clean_company_email, "full_name": clean_text("Full name", 100), "password": clean_new_password},
    )
    if fields["email"] == SEED_ADMIN_EMAIL.strip().lower():
        # Reserved for the first admin, whether or not that account has been created yet.
        raise ApiError(409, "conflict", EMAIL_TAKEN, {"email": EMAIL_TAKEN})
    user = query(
        "INSERT INTO users (email, full_name, password_hash, role) VALUES (%s, %s, %s, 'EMPLOYEE') "
        "ON CONFLICT (email) DO NOTHING RETURNING *",
        (fields["email"], fields["full_name"], hash_password(fields["password"])),
    )
    if not user:
        raise ApiError(409, "conflict", EMAIL_TAKEN, {"email": EMAIL_TAKEN})
    return respond(201, session(user))


def login(event):
    fields = validate(json_body(event), {"email": clean_email, "password": clean_login_password})
    user = query("SELECT * FROM users WHERE email = %s", (fields["email"],))
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
    """Lambda entry point."""
    return dispatch(event, "auth", ROUTES, before=bootstrap)
