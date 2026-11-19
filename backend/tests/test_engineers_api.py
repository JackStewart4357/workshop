"""Integration tests for the engineers service: every endpoint, through the Lambda
handler, against a real database."""

import uuid

import pytest

import db
from conftest import invoke, load_service, sign_in_as

MISSING = "00000000-0000-4000-8000-000000000000"  # a well-formed id that no row has
SAM = {
    "email": "sam.engineer@acme.inc",
    "full_name": "Sam Carter",
    "password": "Welcome123",
    "specialism": "Plumbing",
    "max_open_tickets": 4,
}
IN_USE = "This engineer has incident history and cannot be removed. Deactivate them instead."
NOT_A_MANAGER = "Choose a facility admin as the manager"


@pytest.fixture(scope="session")
def engineers():
    return load_service("engineers")


@pytest.fixture
def admin():
    return sign_in_as("ADMIN")


@pytest.fixture
def sam(engineers, admin):
    """An engineer created through the API: the profile the service returned."""
    return add(engineers, admin)


def add(engineers, admin, **changes):
    status, body = invoke(engineers, "POST", "/profiles", token=admin, body={**SAM, **changes})
    assert status == 201
    return body["profile"]


def edited(profile, **changes):
    """A complete PATCH body: the profile as it is, with these changes."""
    fields = ("full_name", "specialism", "max_open_tickets", "is_available", "is_active", "manager_id")
    return {**{field: profile[field] for field in fields}, **changes}


def listed(engineers, admin):
    status, body = invoke(engineers, "GET", "/profiles", token=admin)
    assert status == 200
    return body["profiles"]


def new_user(role, full_name, is_active=True):
    return db.query(
        "INSERT INTO users (email, full_name, password_hash, role, is_active) VALUES (%s, %s, 'x', %s, %s) RETURNING id",
        (f"{uuid.uuid4().hex[:10]}@acme.inc", full_name, role, is_active),
    )["id"]


def report_incident(reporter_id, assignee_id=None, status="OPEN"):
    """An incident as the incidents service will create them."""
    building = db.query("INSERT INTO buildings (name, address) VALUES (%s, 'x') RETURNING id", (uuid.uuid4().hex,))
    db.query(
        "INSERT INTO incidents (title, description, status, blocked_reason, category_id, building_id, reporter_id, assignee_id) "
        "VALUES ('Leak', 'Dripping', %s, 'Waiting for a part', (SELECT id FROM categories LIMIT 1), %s, %s, %s)",
        (status, building["id"], reporter_id, assignee_id),
        fetch=False,
    )


def rows():
    return db.query(
        "SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM engineer_profiles) AS profiles"
    )


def user_of(profile):
    return db.query(
        "SELECT u.* FROM users u JOIN engineer_profiles p ON p.user_id = u.id WHERE p.id = %s", (profile["id"],)
    )


# --- health, sign-in and roles ---------------------------------------------------------


@pytest.mark.parametrize("path", ["/", "/api/engineers", "/engineers/"])
def test_health_needs_no_sign_in(engineers, path):
    assert invoke(engineers, "GET", path) == (200, {"service": "engineers", "status": "ok"})


ENDPOINTS = [
    ("GET", "/profiles"),
    ("GET", "/managers"),
    ("POST", "/profiles"),
    ("PATCH", f"/profiles/{MISSING}"),
    ("DELETE", f"/profiles/{MISSING}"),
]


@pytest.mark.parametrize("method, path", ENDPOINTS)
def test_every_endpoint_needs_a_signed_in_user(engineers, method, path):
    status, body = invoke(engineers, method, path, body={})
    assert (status, body["error"]["code"]) == (401, "unauthorized")


@pytest.mark.parametrize("role", ["EMPLOYEE", "ENGINEER"])
@pytest.mark.parametrize("method, path", ENDPOINTS)
def test_only_admins_can_use_any_of_it(engineers, role, method, path):
    # The body is deliberately invalid: the role is checked before anything is read from it
    status, body = invoke(engineers, method, path, token=sign_in_as(role), body={})
    assert (status, body["error"]["code"]) == (403, "access_denied")


def test_an_id_that_is_not_a_uuid_is_an_unknown_path(engineers, admin):
    status, body = invoke(engineers, "DELETE", "/profiles/42", token=admin)
    assert (status, body["error"]["code"]) == (404, "not_found")


# --- creating --------------------------------------------------------------------------


def test_creating_an_engineer_returns_the_profile_managed_by_the_admin_who_created_it(engineers, admin):
    status, body = invoke(
        engineers, "POST", "/api/engineers/profiles", token=admin, body={**SAM, "email": "  Sam.Engineer@ACME.inc "}
    )
    me = db.query("SELECT id, full_name FROM users WHERE role = 'ADMIN'")
    assert status == 201
    assert body == {
        "profile": {
            "id": body["profile"]["id"],
            "full_name": "Sam Carter",
            "email": "sam.engineer@acme.inc",
            "is_active": True,
            "specialism": "Plumbing",
            "is_available": True,
            "max_open_tickets": 4,
            "manager_id": str(me["id"]),
            "manager_name": me["full_name"],
            "open_tickets": 0,
        }
    }
    assert listed(engineers, admin) == [body["profile"]]


def test_a_new_engineer_can_sign_in_as_an_engineer(engineers, admin, sam, auth_service):
    status, body = invoke(auth_service, "POST", "/login", body={"email": SAM["email"], "password": SAM["password"]})
    assert (status, body["user"]["role"], body["user"]["full_name"]) == (200, "ENGINEER", "Sam Carter")
    assert user_of(sam)["password_hash"] != SAM["password"]


def test_an_email_that_is_taken_is_refused_and_nothing_is_created(engineers, admin, sam):
    before = rows()
    status, body = invoke(engineers, "POST", "/profiles", token=admin, body={**SAM, "full_name": "Other Sam"})
    assert (status, body["error"]["code"]) == (409, "conflict")
    assert body["error"]["details"] == {"email": "An account with this email already exists"}
    assert rows() == before
    assert listed(engineers, admin) == [sam]


def test_a_login_is_never_left_without_its_profile(engineers, admin, monkeypatch):
    # Force the second insert to fail: 0 breaks the table's max_open_tickets > 0 rule
    monkeypatch.setitem(engineers.PROFILE_RULES, "max_open_tickets", lambda _value: 0)
    before = rows()
    status, body = invoke(engineers, "POST", "/profiles", token=admin, body=SAM)
    assert (status, body["error"]["code"]) == (500, "internal_error")
    assert rows() == before


@pytest.mark.parametrize(
    "field, value, message",
    [
        ("email", "sam@gmail.com", "Only @acme.inc email addresses can register"),
        ("email", "not-an-email", "Enter a valid email address"),
        ("password", "short1", "Password must be at least 8 characters"),
        ("password", "lettersonly", "Password must contain at least one letter and one number"),
        ("full_name", "   ", "Full name is required"),
        ("full_name", "x" * 101, "Full name must be at most 100 characters"),
        ("specialism", "", "Specialism is required"),
        ("specialism", "x" * 101, "Specialism must be at most 100 characters"),
        ("max_open_tickets", 0, "Max open tickets must be a whole number from 1 to 50"),
        ("max_open_tickets", 51, "Max open tickets must be a whole number from 1 to 50"),
        ("max_open_tickets", "4", "Max open tickets must be a whole number from 1 to 50"),
    ],
)
def test_create_checks_each_field(engineers, admin, field, value, message):
    status, body = invoke(engineers, "POST", "/profiles", token=admin, body={**SAM, field: value})
    assert (status, body["error"]["code"]) == (400, "validation_error")
    assert body["error"]["details"] == {field: message}
    assert rows() == {"users": 1, "profiles": 0}


def test_create_accepts_the_longest_values_and_reports_every_missing_field(engineers, admin):
    longest = add(engineers, admin, full_name="n" * 100, specialism="s" * 100, max_open_tickets=50)
    assert (len(longest["full_name"]), len(longest["specialism"]), longest["max_open_tickets"]) == (100, 100, 50)

    status, body = invoke(engineers, "POST", "/profiles", token=admin, body={})
    assert status == 400
    assert set(body["error"]["details"]) == {"email", "password", "full_name", "specialism", "max_open_tickets"}


# --- reading ---------------------------------------------------------------------------


def test_no_engineers_is_an_empty_list(engineers, admin):
    assert invoke(engineers, "GET", "/profiles", token=admin) == (200, {"profiles": []})


def test_engineers_are_listed_by_name_with_the_tickets_they_still_have_open(engineers, admin):
    zoe = add(engineers, admin, email="zoe@acme.inc", full_name="Zoe Adams")
    amir = add(engineers, admin, email="amir@acme.inc", full_name="Amir Khan")
    reporter = new_user("EMPLOYEE", "Reporter")
    for status in ("OPEN", "IN_PROGRESS", "BLOCKED", "RESOLVED", "CLOSED"):
        report_incident(reporter, zoe["id"], status)
    report_incident(reporter, amir["id"])
    report_incident(reporter)  # assigned to nobody

    profiles = listed(engineers, admin)
    assert [(p["full_name"], p["open_tickets"]) for p in profiles] == [("Amir Khan", 1), ("Zoe Adams", 3)]


def test_managers_are_the_active_admins_by_name(engineers, admin):
    zed = new_user("ADMIN", "Zed Admin")
    new_user("ADMIN", "Left The Company", is_active=False)
    new_user("ENGINEER", "An Engineer")
    new_user("EMPLOYEE", "An Employee")
    me = db.query("SELECT id FROM users WHERE full_name = 'Admin'")["id"]

    assert invoke(engineers, "GET", "/api/engineers/managers", token=admin) == (
        200,
        {"managers": [{"id": str(me), "full_name": "Admin"}, {"id": str(zed), "full_name": "Zed Admin"}]},
    )


# --- changing --------------------------------------------------------------------------


def test_every_detail_of_an_engineer_can_be_changed_except_the_email(engineers, admin, sam):
    other = add(engineers, admin, email="other@acme.inc", full_name="Other Engineer")
    zed = new_user("ADMIN", "Zed Admin")
    change = {
        "full_name": "  Samantha Carter ",
        "specialism": "Electrical",
        "max_open_tickets": 9,
        "is_available": False,
        "is_active": True,
        "manager_id": str(zed),
        "email": "ignored@acme.inc",
    }
    status, body = invoke(engineers, "PATCH", f"/api/engineers/profiles/{sam['id']}", token=admin, body=change)

    assert status == 200
    assert body["profile"] == {
        **sam,
        "full_name": "Samantha Carter",
        "specialism": "Electrical",
        "max_open_tickets": 9,
        "is_available": False,
        "manager_id": str(zed),
        "manager_name": "Zed Admin",
    }
    assert listed(engineers, admin) == [other, body["profile"]]  # the other engineer is untouched


def test_deactivating_an_engineer_ends_their_sessions_for_good(engineers, admin, sam, auth_service):
    token = invoke(auth_service, "POST", "/login", body=SAM)[1]["access_token"]
    assert invoke(auth_service, "GET", "/me", token=token)[0] == 200

    status, body = invoke(engineers, "PATCH", f"/profiles/{sam['id']}", token=admin, body=edited(sam, is_active=False))
    assert (status, body["profile"]["is_active"]) == (200, False)
    assert invoke(auth_service, "GET", "/me", token=token)[0] == 401
    assert invoke(auth_service, "POST", "/login", body=SAM)[0] != 200

    # Reactivated: they can sign in again, but the old token stays dead
    assert invoke(engineers, "PATCH", f"/profiles/{sam['id']}", token=admin, body=edited(sam))[0] == 200
    assert invoke(auth_service, "GET", "/me", token=token)[0] == 401
    token = invoke(auth_service, "POST", "/login", body=SAM)[1]["access_token"]
    # ...and an ordinary edit does not sign them out
    assert invoke(engineers, "PATCH", f"/profiles/{sam['id']}", token=admin, body=edited(sam))[0] == 200
    assert invoke(auth_service, "GET", "/me", token=token)[0] == 200


@pytest.mark.parametrize(
    "field, value, message",
    [
        ("full_name", "", "Full name is required"),
        ("specialism", None, "Specialism is required"),
        ("max_open_tickets", 0, "Max open tickets must be a whole number from 1 to 50"),
        ("is_available", "yes", "Available must be true or false"),
        ("is_active", 1, "Active must be true or false"),
        ("manager_id", None, "Manager is required"),
        ("manager_id", "not-an-id", "Manager is required"),
        ("manager_id", MISSING, NOT_A_MANAGER),
    ],
)
def test_change_checks_each_field_and_changes_nothing(engineers, admin, sam, field, value, message):
    status, body = invoke(
        engineers, "PATCH", f"/profiles/{sam['id']}", token=admin, body=edited(sam, **{"specialism": "Changed", field: value})
    )
    assert (status, body["error"]["code"]) == (400, "validation_error")
    assert body["error"]["details"] == {field: message}
    assert listed(engineers, admin) == [sam]


@pytest.mark.parametrize("who", ["an engineer", "an employee", "an inactive admin"])
def test_only_an_active_admin_can_be_the_manager(engineers, admin, sam, who):
    manager = {
        "an engineer": lambda: user_of(sam)["id"],
        "an employee": lambda: new_user("EMPLOYEE", "An Employee"),
        "an inactive admin": lambda: new_user("ADMIN", "Left The Company", is_active=False),
    }[who]()
    status, body = invoke(
        engineers, "PATCH", f"/profiles/{sam['id']}", token=admin, body=edited(sam, manager_id=str(manager))
    )
    assert (status, body["error"]["details"]) == (400, {"manager_id": NOT_A_MANAGER})
    assert listed(engineers, admin) == [sam]


def test_changing_an_unknown_engineer_is_404(engineers, admin, sam):
    status, body = invoke(engineers, "PATCH", f"/profiles/{MISSING}", token=admin, body=edited(sam, full_name="Changed"))
    assert (status, body["error"]["message"]) == (404, "Engineer not found")
    assert listed(engineers, admin) == [sam]


# --- removing --------------------------------------------------------------------------


def test_removing_an_engineer_removes_the_profile_and_the_login_only_for_them(engineers, admin, sam):
    other = add(engineers, admin, email="other@acme.inc", full_name="Other Engineer")
    assert invoke(engineers, "DELETE", f"/api/engineers/profiles/{sam['id']}", token=admin) == (204, None)
    assert listed(engineers, admin) == [other]
    assert rows() == {"users": 2, "profiles": 1}  # the admin and the other engineer
    assert db.query("SELECT 1 AS found FROM users WHERE email = %s", (SAM["email"],)) is None


@pytest.mark.parametrize("status", ["OPEN", "CLOSED"])
def test_an_engineer_who_was_assigned_an_incident_cannot_be_removed(engineers, admin, sam, status):
    report_incident(new_user("EMPLOYEE", "Reporter"), sam["id"], status)
    before = rows()
    status_code, body = invoke(engineers, "DELETE", f"/profiles/{sam['id']}", token=admin)
    assert (status_code, body["error"]["code"], body["error"]["message"]) == (409, "conflict", IN_USE)
    assert rows() == before


def test_an_engineer_whose_login_is_used_elsewhere_keeps_their_profile_too(engineers, admin, sam):
    # Only the users row is referenced (they reported an incident): the profile, deleted
    # first, must come back when the second delete is refused.
    report_incident(user_of(sam)["id"])
    status, body = invoke(engineers, "DELETE", f"/profiles/{sam['id']}", token=admin)
    assert (status, body["error"]["message"]) == (409, IN_USE)
    assert listed(engineers, admin) == [sam]


def test_removing_an_unknown_engineer_is_404(engineers, admin, sam):
    status, body = invoke(engineers, "DELETE", f"/profiles/{MISSING}", token=admin)
    assert (status, body["error"]["code"], body["error"]["message"]) == (404, "not_found", "Engineer not found")
    assert listed(engineers, admin) == [sam]
