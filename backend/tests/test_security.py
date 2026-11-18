"""Tests for password hashing, tokens and the permission checks."""

import json
import time
from contextlib import contextmanager

import jwt
import pytest

import db
import security
from conftest import load_fresh, make_event
from http_utils import ApiError, dispatch, respond


@pytest.fixture
def user():
    return db.query(
        "INSERT INTO users (email, full_name, password_hash, role) VALUES (%s, %s, %s, %s) RETURNING *",
        ("ada@acme.inc", "Ada Lovelace", security.hash_password("correct horse 1"), "ENGINEER"),
    )


@contextmanager
def raises(status, code):
    """Assert the block raises an ApiError with this status and code."""
    with pytest.raises(ApiError) as info:
        yield info
    assert (info.value.status, info.value.code) == (status, code)


# --- passwords -------------------------------------------------------------------------


def test_hash_is_bcrypt_and_never_the_plain_password():
    hashed = security.hash_password("correct horse 1")
    assert hashed.startswith("$2b$") and "correct horse" not in hashed


def test_same_password_hashes_differently_each_time():
    assert security.hash_password("correct horse 1") != security.hash_password("correct horse 1")


def test_verify_accepts_only_the_right_password():
    hashed = security.hash_password("correct horse 1")
    assert security.verify_password("correct horse 1", hashed) is True
    assert security.verify_password("Correct horse 1", hashed) is False
    assert security.verify_password("", hashed) is False


def test_verify_is_false_when_the_user_does_not_exist():
    assert security.verify_password("anything", None) is False


def test_unknown_user_still_costs_exactly_one_hash_comparison(monkeypatch):
    """Timing: an unknown email must not be answered faster than a wrong password."""
    calls = []
    real_checkpw = security.bcrypt.checkpw

    def counting_checkpw(candidate, expected):
        calls.append(expected)
        return real_checkpw(candidate, expected)

    monkeypatch.setattr(security.bcrypt, "checkpw", counting_checkpw)
    assert security.verify_password("anything", None) is False
    assert security.verify_password("timing-equaliser", None) is False  # even the dummy's own password
    assert calls == [security._DUMMY_HASH, security._DUMMY_HASH]


def test_verify_handles_non_ascii_and_over_long_passwords():
    hashed = security.hash_password("pässwörd-1")
    assert security.verify_password("pässwörd-1", hashed) is True
    assert security.verify_password("x" * 500, hashed) is False


def test_verify_never_raises_for_text_json_can_carry():
    hashed = security.hash_password("correct horse 1")
    for password in ["\ud800password1", "pass\x00word1", "🔐" * 300]:
        assert security.verify_password(password, hashed) is False
        assert security.verify_password(password, None) is False


def test_verify_rejects_extra_characters_after_a_maximum_length_password():
    """bcrypt only reads the first 72 bytes; anything longer must still be a mismatch."""
    longest = "a1" + "x" * 70
    hashed = security.hash_password(longest)
    assert security.verify_password(longest, hashed) is True
    assert security.verify_password(longest + "!", hashed) is False


# --- signing key -----------------------------------------------------------------------


def test_signing_key_is_generated_once_and_stored(user):
    first = security.issue_token(user, "access", 60)
    stored = db.query("SELECT value FROM app_secrets WHERE name = 'jwt_secret'")["value"]
    assert len(stored) >= 32

    security._jwt_secret = ""  # a different Lambda container: must read the same key back
    assert security.user_from_token(first, "access")["id"] == user["id"]
    assert db.query("SELECT count(*) AS n FROM app_secrets")["n"] == 1


def test_configured_secret_takes_precedence_over_the_database(user, monkeypatch):
    monkeypatch.setattr(security, "_jwt_secret", "configured-secret-configured-secret")
    token = security.issue_token(user, "access", 60)
    assert jwt.decode(token, "configured-secret-configured-secret", algorithms=["HS256"])["sub"] == str(user["id"])
    assert db.query("SELECT count(*) AS n FROM app_secrets")["n"] == 0


def test_jwt_secret_is_read_from_the_environment(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "configured-secret-configured-secret")
    assert load_fresh(security)._signing_key() == "configured-secret-configured-secret"
    assert db.query("SELECT count(*) AS n FROM app_secrets")["n"] == 0


def test_token_lifetimes_default_to_15_minutes_and_7_days(monkeypatch):
    monkeypatch.delenv("ACCESS_TOKEN_TTL_SECONDS", raising=False)
    monkeypatch.delenv("REFRESH_TOKEN_TTL_SECONDS", raising=False)
    fresh = load_fresh(security)
    assert (fresh.ACCESS_TOKEN_TTL, fresh.REFRESH_TOKEN_TTL) == (15 * 60, 7 * 24 * 60 * 60)


# --- tokens ----------------------------------------------------------------------------


def test_token_carries_identity_role_and_expiry(user):
    token = security.issue_token(user, "access", 60)
    claims = jwt.decode(token, security._signing_key(), algorithms=["HS256"])
    assert claims["sub"] == str(user["id"])
    assert claims["role"] == "ENGINEER"
    assert claims["type"] == "access"
    assert claims["ver"] == 0
    assert 0 < claims["exp"] - time.time() <= 60


def test_session_tokens_have_the_documented_shape(user):
    tokens = security.issue_session_tokens(user)
    assert set(tokens) == {"access_token", "refresh_token", "token_type", "expires_in"}
    assert tokens["token_type"] == "Bearer"
    assert tokens["expires_in"] == security.ACCESS_TOKEN_TTL
    assert security.user_from_token(tokens["access_token"], "access")["email"] == "ada@acme.inc"
    assert security.user_from_token(tokens["refresh_token"], "refresh")["email"] == "ada@acme.inc"


def test_expired_token_is_rejected_with_its_own_code(user):
    with raises(401, "token_expired"):
        security.user_from_token(security.issue_token(user, "access", -1), "access")


@pytest.mark.parametrize("token", ["", "garbage", "a.b.c", "eyJhbGciOiJub25lIn0.e30.", "\ud800"])
def test_malformed_tokens_are_rejected(token):
    with raises(401, "invalid_token"):
        security.user_from_token(token, "access")


def test_token_signed_with_another_key_is_rejected(user):
    forged = jwt.encode(
        {"sub": str(user["id"]), "role": "ADMIN", "ver": 0, "type": "access", "exp": int(time.time()) + 60},
        "attacker-key-attacker-key-attacker-key",
        algorithm="HS256",
    )
    with raises(401, "invalid_token"):
        security.user_from_token(forged, "access")


def test_unsigned_token_is_rejected(user):
    claims = {"sub": str(user["id"]), "role": "ADMIN", "ver": 0, "type": "access", "exp": int(time.time()) + 60}
    with raises(401, "invalid_token"):
        security.user_from_token(jwt.encode(claims, None, algorithm="none"), "access")


@pytest.mark.parametrize("missing", ["sub", "exp", "type", "ver"])
def test_token_missing_a_required_claim_is_rejected(user, missing):
    claims = {"sub": str(user["id"]), "ver": 0, "type": "access", "exp": int(time.time()) + 60}
    del claims[missing]
    with raises(401, "invalid_token"):
        security.user_from_token(jwt.encode(claims, security._signing_key(), algorithm="HS256"), "access")


def test_refresh_token_cannot_be_used_as_an_access_token(user):
    with raises(401, "invalid_token"):
        security.user_from_token(security.issue_token(user, "refresh", 60), "access")


def test_access_token_cannot_be_used_as_a_refresh_token(user):
    with raises(401, "invalid_token"):
        security.user_from_token(security.issue_token(user, "access", 60), "refresh")


def test_token_is_revoked_when_the_token_version_changes(user):
    token = security.issue_token(user, "access", 60)
    db.query("UPDATE users SET token_version = token_version + 1 WHERE id = %s", (user["id"],), fetch=False)
    with raises(401, "invalid_token"):
        security.user_from_token(token, "access")


def test_token_of_a_deactivated_user_is_rejected(user):
    token = security.issue_token(user, "access", 60)
    db.query("UPDATE users SET is_active = FALSE WHERE id = %s", (user["id"],), fetch=False)
    with raises(401, "invalid_token"):
        security.user_from_token(token, "access")


def test_token_of_a_deleted_user_is_rejected(user):
    token = security.issue_token(user, "access", 60)
    db.query("DELETE FROM users WHERE id = %s", (user["id"],), fetch=False)
    with raises(401, "invalid_token"):
        security.user_from_token(token, "access")


def test_token_with_a_non_uuid_subject_is_rejected(user):
    token = security.issue_token({**user, "id": "not-a-uuid"}, "access", 60)
    with raises(401, "invalid_token"):
        security.user_from_token(token, "access")


def test_role_change_takes_effect_without_a_new_token(user):
    """The role is read from the database on every request, not trusted from the token."""
    token = security.issue_token(user, "access", 60)
    db.query("UPDATE users SET role = 'EMPLOYEE' WHERE id = %s", (user["id"],), fetch=False)
    assert security.user_from_token(token, "access")["role"] == "EMPLOYEE"


# --- authentication and authorization ----------------------------------------------------


def test_current_user_reads_the_bearer_token(user):
    token = security.issue_token(user, "access", 60)
    assert security.current_user(make_event(token=token))["email"] == "ada@acme.inc"


@pytest.mark.parametrize("header_name", ["authorization", "Authorization", "AUTHORIZATION"])
def test_authorization_header_name_is_case_insensitive(user, header_name):
    token = security.issue_token(user, "access", 60)
    assert security.current_user(make_event(headers={header_name: f"bearer {token}"}))["id"] == user["id"]


@pytest.mark.parametrize("headers", [None, {}, {"Authorization": ""}, {"Authorization": "Bearer"},
                                     {"Authorization": "Bearer   "}, {"Authorization": "Basic dXNlcjpwYXNz"}])
def test_missing_or_non_bearer_credentials_are_401(headers):
    event = make_event(headers=headers)
    if headers is None:
        del event["headers"]
    with raises(401, "unauthorized"):
        security.current_user(event)


def test_require_role_allows_listed_roles():
    security.require_role({"role": "ADMIN"}, "ADMIN")
    security.require_role({"role": "ENGINEER"}, "ADMIN", "ENGINEER")


@pytest.mark.parametrize("role, allowed", [("EMPLOYEE", ("ADMIN",)), ("ENGINEER", ("ADMIN",)), ("ADMIN", ())])
def test_require_role_denies_everyone_else(role, allowed):
    with raises(403, "access_denied"):
        security.require_role({"role": role}, *allowed)


def test_protected_endpoint_receives_the_caller_and_the_path_ids(user):
    @security.protected()
    def endpoint(event, caller, floor_id):
        """Shown in the API table."""
        return caller["email"], floor_id, event["rawPath"]

    token = security.issue_token(user, "access", 60)
    assert endpoint(make_event(path="/floors/7", token=token), floor_id="7") == ("ada@acme.inc", "7", "/floors/7")
    assert endpoint.__name__ == "endpoint" and endpoint.__doc__ == "Shown in the API table."


def test_protected_endpoint_without_roles_is_open_to_every_signed_in_role(user):
    endpoint = security.protected()(lambda _event, caller: caller["role"])
    for role in security.ROLES:
        db.query("UPDATE users SET role = %s WHERE id = %s", (role, user["id"]), fetch=False)
        assert endpoint(make_event(token=security.issue_token(user, "access", 60))) == role


def test_protected_endpoint_is_never_run_without_a_valid_token(user):
    calls = []
    endpoint = security.protected("ENGINEER")(lambda _event, _caller: calls.append("ran"))
    with raises(401, "unauthorized"):
        endpoint(make_event())
    with raises(401, "invalid_token"):
        endpoint(make_event(token=security.issue_token(user, "refresh", 60)))
    assert calls == []


def test_protected_endpoint_is_never_run_for_a_role_that_is_not_listed(user):
    calls = []
    endpoint = security.protected("ADMIN", "EMPLOYEE")(lambda _event, _caller: calls.append("ran"))
    token = security.issue_token(user, "access", 60)
    with raises(403, "access_denied"):
        endpoint(make_event(token=token))
    assert calls == []
    # The role is read from the database on every request, not trusted from the token
    for role in ("ADMIN", "EMPLOYEE"):  # every listed role gets in, not only the first
        db.query("UPDATE users SET role = %s WHERE id = %s", (role, user["id"]), fetch=False)
        endpoint(make_event(token=token))
    assert calls == ["ran", "ran"]


def test_protected_refuses_a_misspelt_role_or_missing_brackets_at_import_time():
    with pytest.raises(ValueError, match="role names"):
        security.protected("ADMINS")
    with pytest.raises(ValueError, match="brackets"):

        @security.protected
        def endpoint(_event, _caller):  # pragma: no cover - never becomes callable
            pass


def test_protected_endpoints_work_through_dispatch(user):
    @security.protected("ENGINEER")
    def show(_event, caller, floor_id):
        return respond(200, {"caller": caller["email"], "floor_id": floor_id})

    routes = {("GET", "/floors/{floor_id}"): show}
    floor = "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90"
    token = security.issue_token(user, "access", 60)
    ok = dispatch(make_event("GET", f"/floors/{floor}", token=token), "things", routes)
    assert (ok["statusCode"], json.loads(ok["body"])) == (200, {"caller": "ada@acme.inc", "floor_id": floor})
    assert dispatch(make_event("GET", f"/floors/{floor}"), "things", routes)["statusCode"] == 401


def test_roles_match_the_database_constraint():
    constraint = db.query(
        "SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c "
        "JOIN pg_class t ON t.oid = c.conrelid "
        "WHERE t.relname = 'users' AND c.conname = 'users_role_check' "
        "AND t.relnamespace = current_schema()::regnamespace"
    )["definition"]
    for role in security.ROLES:
        assert f"'{role}'" in constraint
    assert constraint.count("'::text") == len(security.ROLES)
