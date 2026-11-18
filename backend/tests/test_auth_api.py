"""Integration tests for the auth service: every endpoint, through the Lambda handler,
against a real database."""

import json

import bcrypt
import pytest

import db
import security
from conftest import invoke, load_fresh, make_event

ALICE = {"email": "alice@acme.inc", "full_name": "Alice Johnson", "password": "passw0rd1"}


def register(auth, **overrides):
    return invoke(auth, "POST", "/register", body={**ALICE, **overrides})


def login(auth, email=ALICE["email"], password=ALICE["password"]):
    return invoke(auth, "POST", "/login", body={"email": email, "password": password})


@pytest.fixture
def alice(auth):
    """A registered employee: the response body of a successful registration."""
    status, body = register(auth)
    assert status == 201
    return body


# --- health and routing ----------------------------------------------------------------


@pytest.mark.parametrize("path", ["/", "/api/auth", "/api/auth/", "/auth"])
def test_health(auth, path):
    assert invoke(auth, "GET", path) == (200, {"service": "auth", "status": "ok"})


def test_unknown_route_is_404(auth):
    status, body = invoke(auth, "GET", "/nope")
    assert (status, body["error"]["code"]) == (404, "not_found")


def test_wrong_method_is_405(auth):
    status, body = invoke(auth, "GET", "/login")
    assert (status, body["error"]["code"]) == (405, "method_not_allowed")


def test_routes_work_behind_the_cloudfront_prefix(auth, alice):
    status, body = invoke(auth, "GET", "/api/auth/me", token=alice["access_token"])
    assert (status, body["user"]["email"]) == (200, "alice@acme.inc")


# --- registration ----------------------------------------------------------------------


def test_register_creates_an_employee_and_signs_them_in(auth):
    status, body = register(auth, email="  Alice@ACME.inc ")
    assert status == 201
    assert body["user"]["email"] == "alice@acme.inc"
    assert body["user"]["full_name"] == "Alice Johnson"
    assert body["user"]["role"] == "EMPLOYEE"
    assert set(body["user"]) == {"id", "email", "full_name", "role", "created_at"}
    assert body["token_type"] == "Bearer" and body["expires_in"] > 0
    assert invoke(auth, "GET", "/me", token=body["access_token"])[0] == 200


def test_register_stores_a_hash_never_the_password(auth, alice):
    row = db.query("SELECT * FROM users WHERE email = %s", (ALICE["email"],))
    assert ALICE["password"] not in json.dumps(row, default=str)
    assert bcrypt.checkpw(ALICE["password"].encode(), row["password_hash"].encode())
    assert "password" not in json.dumps(alice["user"])


@pytest.mark.parametrize("extra", [{"role": "ADMIN"}, {"role": "ENGINEER"}, {"is_active": False, "id": "x"}])
def test_register_cannot_choose_its_own_role(auth, extra):
    """Privilege escalation: extra fields in the request are ignored."""
    status, body = register(auth, **extra)
    assert (status, body["user"]["role"]) == (201, "EMPLOYEE")
    assert db.query("SELECT role, is_active FROM users WHERE email = %s", (ALICE["email"],)) == {
        "role": "EMPLOYEE",
        "is_active": True,
    }


@pytest.mark.parametrize(
    "field, value, message",
    [
        ("email", "alice@gmail.com", "Only @acme.inc email addresses can register"),
        ("email", "alice@acme.inc.evil.com", "Only @acme.inc email addresses can register"),
        ("email", "alice@notacme.inc", "Only @acme.inc email addresses can register"),
        ("email", "not-an-email", "Enter a valid email address"),
        ("email", "", "Email is required"),
        ("email", None, "Email is required"),
        ("full_name", "   ", "Full name is required"),
        ("full_name", "x" * 101, "Full name must be at most 100 characters"),
        ("password", "", "Password is required"),
        ("password", 12345678, "Password is required"),
        ("password", "short1", "Password must be at least 8 characters"),
        ("password", "seven77", "Password must be at least 8 characters"),
        ("password", "a1" + "é" * 36, "Password must be at most 72 bytes"),  # 38 characters, 74 bytes
        ("password", "lettersonly", "Password must contain at least one letter and one number"),
        ("password", "1234567890", "Password must contain at least one letter and one number"),
        ("password", "a1" + "x" * 71, "Password must be at most 72 bytes"),
        ("password", "\ud800password1", "Password contains characters that are not valid text"),
        ("full_name", "A\x00lice", "Full name contains characters that are not valid text"),
    ],
)
def test_register_validation(auth, field, value, message):
    status, body = register(auth, **{field: value})
    assert status == 400
    assert body["error"]["code"] == "validation_error"
    assert body["error"]["details"] == {field: message}
    assert db.query("SELECT count(*) AS n FROM users WHERE role = 'EMPLOYEE'")["n"] == 0


def test_register_reports_all_invalid_fields_together(auth):
    status, body = invoke(auth, "POST", "/register", body={})
    assert status == 400
    assert set(body["error"]["details"]) == {"email", "full_name", "password"}


def test_register_rejects_a_duplicate_email_in_any_case(auth, alice):
    status, body = register(auth, email="ALICE@acme.inc", full_name="Impostor")
    assert status == 409
    assert body["error"]["code"] == "conflict"
    assert body["error"]["details"] == {"email": "An account with this email already exists"}
    assert db.query("SELECT full_name FROM users WHERE email = %s", (ALICE["email"],))["full_name"] == "Alice Johnson"


@pytest.mark.parametrize("raw", [None, "", "{broken", "[]", "null"])
def test_register_rejects_a_missing_or_malformed_body(auth, raw):
    response = auth.handler(make_event("POST", "/register", raw_body=raw), None)
    assert response["statusCode"] == 400
    assert json.loads(response["body"])["error"]["code"] == "validation_error"


def test_register_accepts_a_base64_encoded_body(auth):
    status, _ = invoke(auth, "POST", "/register", body=ALICE, base64_body=True)
    assert status == 201


# --- login -----------------------------------------------------------------------------


def test_login_returns_the_user_and_working_tokens(auth, alice):
    status, body = login(auth, email="Alice@Acme.Inc")
    assert status == 200
    assert body["user"] == alice["user"]
    assert invoke(auth, "GET", "/me", token=body["access_token"])[0] == 200


@pytest.mark.parametrize(
    "password",
    [
        "eight888",  # exactly the minimum length
        "a1" + "x" * 70,  # exactly 72 bytes
        "a1" + "é" * 35,  # 37 characters, exactly 72 bytes
        " passw0rd1",  # surrounding whitespace is part of the password
        "passw0rd1 ",
        "passw0rd1\n",
        "pass w0rd1",
    ],
)
def test_any_password_accepted_at_registration_can_log_in(auth, password):
    assert register(auth, password=password)[0] == 201
    assert login(auth, password=password)[0] == 200
    assert login(auth, password=password.strip() + "!")[0] == 401


def test_login_does_not_trim_the_password(auth, alice):
    assert login(auth, password=ALICE["password"] + " ")[0] == 401
    assert login(auth, password=" " + ALICE["password"])[0] == 401


def test_login_rejects_an_overlong_password(auth):
    status, body = login(auth, password="x" * 1025)
    assert status == 400
    assert body["error"]["details"] == {"password": "Password must be at most 1024 characters"}


@pytest.mark.parametrize("email", [ALICE["email"], "nobody@acme.inc"])
def test_login_with_unencodable_text_is_a_normal_failure(auth, alice, email):
    """A lone surrogate is valid JSON; it must be wrong credentials, never a 500."""
    assert login(auth, email=email, password="\ud800password1")[0] == 401


def test_refresh_with_unencodable_text_is_rejected_cleanly(auth):
    assert invoke(auth, "POST", "/refresh", body={"refresh_token": "\ud800"})[0] == 400


def test_login_failure_does_not_reveal_whether_the_email_exists(auth, alice):
    wrong_password = login(auth, password="wrongpass1")
    unknown_email = login(auth, email="nobody@acme.inc")
    assert wrong_password == unknown_email
    assert wrong_password == (401, {"error": {"code": "invalid_credentials", "message": "Incorrect email or password"}})


def test_login_validation(auth):
    status, body = invoke(auth, "POST", "/login", body={"email": "nope"})
    assert status == 400
    assert set(body["error"]["details"]) == {"email", "password"}


def test_login_does_not_require_the_company_domain_check(auth):
    """A non-acme address is simply an unknown account at login, not a validation error."""
    assert login(auth, email="someone@gmail.com")[0] == 401


def test_deactivated_account_cannot_log_in(auth, alice):
    db.query("UPDATE users SET is_active = FALSE WHERE email = %s", (ALICE["email"],), fetch=False)
    status, body = login(auth)
    assert (status, body["error"]["code"]) == (403, "access_denied")
    assert "access_token" not in body


def test_deactivated_account_with_wrong_password_looks_like_any_other_failure(auth, alice):
    db.query("UPDATE users SET is_active = FALSE WHERE email = %s", (ALICE["email"],), fetch=False)
    assert login(auth, password="wrongpass1")[0] == 401


# --- current user ----------------------------------------------------------------------


def test_me_returns_the_signed_in_user(auth, alice):
    assert invoke(auth, "GET", "/me", token=alice["access_token"]) == (200, {"user": alice["user"]})


def test_me_requires_a_token(auth):
    status, body = invoke(auth, "GET", "/me")
    assert (status, body["error"]["code"]) == (401, "unauthorized")


@pytest.mark.parametrize("token", ["garbage", "a.b.c"])
def test_me_rejects_an_invalid_token(auth, token):
    status, body = invoke(auth, "GET", "/me", token=token)
    assert (status, body["error"]["code"]) == (401, "invalid_token")


def test_me_rejects_a_refresh_token(auth, alice):
    assert invoke(auth, "GET", "/me", token=alice["refresh_token"])[0] == 401


def test_me_reports_an_expired_session(auth, alice, monkeypatch):
    monkeypatch.setattr(security, "ACCESS_TOKEN_TTL", -1)
    _, body = login(auth)
    status, error = invoke(auth, "GET", "/me", token=body["access_token"])
    assert (status, error["error"]["code"]) == (401, "token_expired")


# --- refresh ---------------------------------------------------------------------------


def test_refresh_issues_a_new_working_session(auth, alice):
    status, body = invoke(auth, "POST", "/refresh", body={"refresh_token": alice["refresh_token"]})
    assert status == 200
    assert body["user"] == alice["user"]
    assert invoke(auth, "GET", "/me", token=body["access_token"])[0] == 200
    assert invoke(auth, "POST", "/refresh", body={"refresh_token": body["refresh_token"]})[0] == 200


def test_refresh_rejects_an_access_token(auth, alice):
    status, body = invoke(auth, "POST", "/refresh", body={"refresh_token": alice["access_token"]})
    assert (status, body["error"]["code"]) == (401, "invalid_token")


def test_refresh_reports_an_expired_refresh_token(auth, alice, monkeypatch):
    monkeypatch.setattr(security, "REFRESH_TOKEN_TTL", -1)
    _, body = login(auth)
    status, error = invoke(auth, "POST", "/refresh", body={"refresh_token": body["refresh_token"]})
    assert (status, error["error"]["code"]) == (401, "token_expired")


@pytest.mark.parametrize("raw", ["{}", '{"refresh_token": ""}', '{"refresh_token": 5}'])
def test_refresh_requires_a_token(auth, raw):
    status, body = invoke(auth, "POST", "/refresh", raw_body=raw)
    assert status == 400
    assert body["error"]["details"] == {"refresh_token": "Refresh token is required"}


def test_refresh_fails_for_a_deactivated_account(auth, alice):
    db.query("UPDATE users SET is_active = FALSE WHERE email = %s", (ALICE["email"],), fetch=False)
    assert invoke(auth, "POST", "/refresh", body={"refresh_token": alice["refresh_token"]})[0] == 401


# --- logout ----------------------------------------------------------------------------


def test_logout_revokes_every_token_already_issued(auth, alice):
    _, second_session = login(auth)

    response = auth.handler(make_event("POST", "/logout", token=alice["access_token"]), None)
    assert (response["statusCode"], response["body"]) == (204, "")

    for session in (alice, second_session):
        assert invoke(auth, "GET", "/me", token=session["access_token"])[0] == 401
        assert invoke(auth, "POST", "/refresh", body={"refresh_token": session["refresh_token"]})[0] == 401


def test_logout_requires_a_token(auth):
    assert invoke(auth, "POST", "/logout")[0] == 401


def test_can_log_in_again_after_logout(auth, alice):
    invoke(auth, "POST", "/logout", token=alice["access_token"])
    status, body = login(auth)
    assert status == 200
    assert invoke(auth, "GET", "/me", token=body["access_token"])[0] == 200


def test_logout_only_affects_the_caller(auth, alice):
    _, bob = register(auth, email="bob@acme.inc", full_name="Bob")
    invoke(auth, "POST", "/logout", token=alice["access_token"])
    assert invoke(auth, "GET", "/me", token=bob["access_token"])[0] == 200


# --- one-time setup --------------------------------------------------------------------


def test_first_request_seeds_an_admin_who_can_log_in(auth):
    invoke(auth, "GET", "/")
    admin = db.query("SELECT * FROM users WHERE role = 'ADMIN'")
    assert admin["email"] == auth.SEED_ADMIN_EMAIL
    status, body = login(auth, email=auth.SEED_ADMIN_EMAIL, password=auth.SEED_ADMIN_PASSWORD)
    assert (status, body["user"]["role"]) == (200, "ADMIN")


def test_no_admin_is_created_without_a_seed_password(auth, monkeypatch, caplog):
    """A deployed service must never fall back to a password that is written in the code."""
    monkeypatch.setattr(auth, "SEED_ADMIN_PASSWORD", "")
    assert invoke(auth, "GET", "/")[0] == 200
    assert db.query("SELECT count(*) AS n FROM users")["n"] == 0
    assert "SEED_ADMIN_PASSWORD is not set" in caplog.text


def test_built_in_seed_password_is_for_local_development_only(auth_service, monkeypatch):
    monkeypatch.delenv("SEED_ADMIN_PASSWORD", raising=False)
    monkeypatch.setattr(db, "IS_LOCAL", False)
    assert load_fresh(auth_service).SEED_ADMIN_PASSWORD == ""
    monkeypatch.setattr(db, "IS_LOCAL", True)
    assert load_fresh(auth_service).SEED_ADMIN_PASSWORD != ""


def test_configured_seed_password_is_used_when_deployed(auth_service, monkeypatch):
    monkeypatch.setenv("SEED_ADMIN_PASSWORD", "from-the-environment-1")
    monkeypatch.setattr(db, "IS_LOCAL", False)
    deployed = load_fresh(auth_service)
    assert invoke(deployed, "GET", "/")[0] == 200
    status, body = login(deployed, email=deployed.SEED_ADMIN_EMAIL, password="from-the-environment-1")
    assert (status, body["user"]["role"]) == (200, "ADMIN")
    assert login(deployed, email=deployed.SEED_ADMIN_EMAIL, password="Admin#12345")[0] == 401


@pytest.mark.parametrize(
    "setting, value, reason",
    [
        ("SEED_ADMIN_PASSWORD", "Correct-Horse-Battery-Staple-" * 3 + "2026", "at most 72 bytes"),
        ("SEED_ADMIN_PASSWORD", "weak", "at least 8 characters"),
        ("SEED_ADMIN_EMAIL", "ops@example.com", "Only @acme.inc email addresses"),
    ],
)
def test_unusable_seed_settings_create_no_admin_and_keep_the_service_up(auth, monkeypatch, caplog, setting, value, reason):
    """Bad configuration must be reported once, not crash every request or create an
    admin whose password nobody can type."""
    monkeypatch.setattr(auth, setting, value)
    hashes = []
    monkeypatch.setattr(auth, "hash_password", lambda password: hashes.append(password) or "unused")
    assert [invoke(auth, "GET", "/")[0] for _ in range(3)] == [200, 200, 200]
    assert db.query("SELECT count(*) AS n FROM users")["n"] == 0
    assert hashes == []
    assert caplog.text.count("Seed admin settings are not usable") == 1 and reason in caplog.text


def test_seed_admin_address_cannot_be_self_registered(auth, monkeypatch):
    """Otherwise anyone could take the address before the admin exists and block its creation."""
    monkeypatch.setattr(auth, "SEED_ADMIN_PASSWORD", "")
    status, body = register(auth, email=auth.SEED_ADMIN_EMAIL.upper())
    assert (status, body["error"]["code"]) == (409, "conflict")
    assert db.query("SELECT count(*) AS n FROM users")["n"] == 0


def test_seeding_reports_an_address_already_held_by_a_non_admin(auth, caplog):
    db.query(
        "INSERT INTO users (email, full_name, password_hash, role) VALUES (%s, 'Mallory', 'hash', 'EMPLOYEE')",
        (auth.SEED_ADMIN_EMAIL,),
        fetch=False,
    )
    assert invoke(auth, "GET", "/")[0] == 200
    assert db.query("SELECT count(*) AS n FROM users WHERE role = 'ADMIN'")["n"] == 0
    assert "already registered and is not an admin" in caplog.text
    assert "Seeded initial admin" not in caplog.text


def test_admin_is_not_seeded_when_one_already_exists(auth):
    db.query(
        "INSERT INTO users (email, full_name, password_hash, role) VALUES (%s, %s, %s, 'ADMIN')",
        ("boss@acme.inc", "Boss", security.hash_password("whatever1")),
        fetch=False,
    )
    invoke(auth, "GET", "/")
    assert db.query("SELECT count(*) AS n FROM users WHERE role = 'ADMIN'")["n"] == 1
    assert db.query("SELECT email FROM users WHERE role = 'ADMIN'")["email"] == "boss@acme.inc"


def test_setup_runs_once_per_container(auth, monkeypatch):
    invoke(auth, "GET", "/")
    calls = []
    real_query = auth.query
    monkeypatch.setattr(auth, "query", lambda *a, **k: calls.append(a) or real_query(*a, **k))
    invoke(auth, "GET", "/")
    assert calls == []


def test_seeded_admin_survives_a_concurrent_cold_start(auth):
    """Two containers starting together must not create two admins or fail."""
    invoke(auth, "GET", "/")
    auth._ready = False
    db.query("UPDATE users SET role = 'EMPLOYEE' WHERE role = 'ADMIN'", fetch=False)  # same email, no admin
    assert invoke(auth, "GET", "/")[0] == 200
    assert db.query("SELECT count(*) AS n FROM users WHERE email = %s", (auth.SEED_ADMIN_EMAIL,))["n"] == 1


# --- failures --------------------------------------------------------------------------


def test_database_failure_returns_a_generic_500(auth, monkeypatch):
    def broken(*_args, **_kwargs):
        raise RuntimeError("connection to server at 10.0.0.5 failed: password authentication failed")

    monkeypatch.setattr(auth, "query", broken)
    status, body = invoke(auth, "GET", "/")
    assert status == 500
    assert body == {"error": {"code": "internal_error", "message": "An unexpected error occurred"}}


def test_missing_tables_return_500_not_a_crash(auth):
    db.query("ALTER TABLE users RENAME TO users_hidden", fetch=False)
    try:
        assert invoke(auth, "POST", "/login", body={"email": "a@acme.inc", "password": "x"})[0] == 500
    finally:
        db.query("ALTER TABLE users_hidden RENAME TO users", fetch=False)
    assert invoke(auth, "GET", "/")[0] == 200  # recovers once the schema is back


def test_every_error_response_uses_the_same_shape(auth, alice):
    responses = [
        invoke(auth, "POST", "/register", body={}),          # 400
        invoke(auth, "GET", "/me"),                          # 401
        register(auth),                                      # 409
        invoke(auth, "GET", "/nope"),                        # 404
        invoke(auth, "PUT", "/login"),                       # 405
    ]
    assert [status for status, _ in responses] == [400, 401, 409, 404, 405]
    for _, body in responses:
        assert set(body) == {"error"}
        assert {"code", "message"} <= set(body["error"]) <= {"code", "message", "details"}
