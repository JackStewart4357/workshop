"""Integration tests for the feedback service: every endpoint, through the Lambda handler,
against a real database, plus the small web server that runs it in a container."""

import importlib.util
import json
import sys
import threading
import urllib.error
import urllib.request
import uuid

import pytest

import db
import security
from conftest import BACKEND_DIR, invoke, load_service

MISSING = "00000000-0000-4000-8000-000000000000"  # a well-formed id that no row has
NOT_THE_MANAGER = "Only this engineer's manager can read their feedback"


@pytest.fixture(scope="session")
def feedback():
    return load_service("feedback")


def person(role, full_name=None):
    """A user with this role: their id and an access token."""
    user = db.query(
        "INSERT INTO users (email, full_name, password_hash, role) VALUES (%s, %s, 'x', %s) RETURNING *",
        (f"{uuid.uuid4().hex[:10]}@acme.inc", full_name or role.title(), role),
    )
    return {"id": user["id"], "token": security.issue_token(user, "access", 60)}


def profile_for(engineer, manager):
    return db.query(
        "INSERT INTO engineer_profiles (user_id, specialism, manager_id) VALUES (%s, 'Plumbing', %s) RETURNING id",
        (engineer["id"], manager["id"]),
    )["id"]


def incident(reporter, assignee=None, status="RESOLVED", title="Leak"):
    building = db.query("INSERT INTO buildings (name, address) VALUES (%s, 'x') RETURNING id", (uuid.uuid4().hex,))
    return str(
        db.query(
            "INSERT INTO incidents (title, description, status, blocked_reason, category_id, building_id, reporter_id, assignee_id) "
            "VALUES (%s, 'Dripping', %s, 'Waiting for a part', (SELECT id FROM categories LIMIT 1), %s, %s, %s) RETURNING id",
            (title, status, building["id"], reporter["id"], assignee),
        )["id"]
    )


@pytest.fixture
def cast():
    """A manager, an engineer they manage, the employee who reported a resolved incident
    that engineer worked on, and bystanders of every role."""
    people = {
        "manager": person("ADMIN", "Mia Manager"),
        "other_admin": person("ADMIN", "Other Admin"),
        "engineer": person("ENGINEER", "Eve Engineer"),
        "reporter": person("EMPLOYEE", "Rae Reporter"),
        "bystander": person("EMPLOYEE", "By Stander"),
    }
    people["profile"] = profile_for(people["engineer"], people["manager"])
    people["incident"] = incident(people["reporter"], people["profile"])
    return people


def give(feedback, cast, who="reporter", incident_id=None, **body):
    return invoke(
        feedback, "POST", f"/incidents/{incident_id or cast['incident']}", token=cast[who]["token"], body={"rating": 4, **body}
    )


def saved():
    return db.query_all("SELECT incident_id, engineer_id, author_id, rating, comment FROM incident_feedback")


# --- health, sign-in and roles ---------------------------------------------------------


@pytest.mark.parametrize("path", ["/", "/api/feedback", "/feedback/"])
def test_health_needs_no_sign_in(feedback, path):
    assert invoke(feedback, "GET", path) == (200, {"service": "feedback", "status": "ok"})


@pytest.mark.parametrize(
    "method, path",
    [("GET", f"/incidents/{MISSING}"), ("POST", f"/incidents/{MISSING}"), ("GET", "/engineers"), ("GET", f"/engineers/{MISSING}")],
)
def test_every_endpoint_needs_a_signed_in_user(feedback, method, path):
    status, body = invoke(feedback, method, path, body={})
    assert (status, body["error"]["code"]) == (401, "unauthorized")


# --- giving feedback -------------------------------------------------------------------


def test_the_reporter_rates_the_engineer_once_the_incident_is_resolved(feedback, cast):
    assert invoke(feedback, "GET", f"/api/feedback/incidents/{cast['incident']}", token=cast["reporter"]["token"]) == (
        200,
        {"given": False, "can_give": True},
    )
    assert give(feedback, cast, rating=5, comment="  Fixed in an hour ") == (201, {"given": True, "can_give": False})
    assert [dict(row, incident_id=str(row["incident_id"])) for row in saved()] == [
        {
            "incident_id": cast["incident"],
            "engineer_id": cast["profile"],
            "author_id": cast["reporter"]["id"],
            "rating": 5,
            "comment": "Fixed in an hour",
        }
    ]
    assert invoke(feedback, "GET", f"/incidents/{cast['incident']}", token=cast["reporter"]["token"]) == (
        200,
        {"given": True, "can_give": False},
    )


@pytest.mark.parametrize("comment", [None, "", "   "])
def test_the_comment_is_optional(feedback, cast, comment):
    assert give(feedback, cast, comment=comment)[0] == 201
    assert saved()[0]["comment"] is None


def test_feedback_is_also_accepted_on_a_closed_incident(feedback, cast):
    closed = incident(cast["reporter"], cast["profile"], "CLOSED")
    assert give(feedback, cast, incident_id=closed)[0] == 201


@pytest.mark.parametrize(
    "body, field, message",
    [
        ({"rating": 0}, "rating", "Rating must be a whole number from 1 to 5"),
        ({"rating": 6}, "rating", "Rating must be a whole number from 1 to 5"),
        ({"rating": "5"}, "rating", "Rating must be a whole number from 1 to 5"),
        ({"rating": None}, "rating", "Rating must be a whole number from 1 to 5"),
        ({"comment": "x" * 1001}, "comment", "Comment must be at most 1000 characters"),
    ],
)
def test_the_rating_and_comment_are_checked(feedback, cast, body, field, message):
    status, answer = give(feedback, cast, **body)
    assert (status, answer["error"]["details"]) == (400, {field: message})
    assert saved() == []


def test_the_longest_comment_and_both_ends_of_the_scale_are_accepted(feedback, cast):
    second = incident(cast["reporter"], cast["profile"])
    assert give(feedback, cast, rating=1, comment="x" * 1000)[0] == 201
    assert give(feedback, cast, incident_id=second, rating=5)[0] == 201


@pytest.mark.parametrize("status", ["OPEN", "IN_PROGRESS", "BLOCKED"])
def test_feedback_waits_until_the_incident_is_resolved(feedback, cast, status):
    unfinished = incident(cast["reporter"], cast["profile"], status)
    assert invoke(feedback, "GET", f"/incidents/{unfinished}", token=cast["reporter"]["token"])[1] == {
        "given": False,
        "can_give": False,
    }
    status_code, body = give(feedback, cast, incident_id=unfinished)
    assert (status_code, body["error"]["code"]) == (409, "conflict")
    assert body["error"]["message"] == "Feedback can be given once the incident is resolved"
    assert saved() == []


def test_there_is_nobody_to_rate_when_no_engineer_was_assigned(feedback, cast):
    unassigned = incident(cast["reporter"], None, "CLOSED")
    assert invoke(feedback, "GET", f"/incidents/{unassigned}", token=cast["reporter"]["token"])[1]["can_give"] is False
    status, body = give(feedback, cast, incident_id=unassigned)
    assert (status, body["error"]["message"]) == (409, "No engineer worked on this incident")
    assert saved() == []


def test_feedback_is_given_once_per_incident(feedback, cast):
    assert give(feedback, cast, rating=2)[0] == 201
    status, body = give(feedback, cast, rating=5)
    assert (status, body["error"]["message"]) == (409, "You have already given feedback on this incident")
    assert [row["rating"] for row in saved()] == [2]


def test_two_submissions_at_once_save_only_the_first(feedback, cast, monkeypatch):
    assert give(feedback, cast, rating=2)[0] == 201
    # The second request read the incident before the first one saved: it sees no feedback yet
    monkeypatch.setattr(feedback, "refusal", lambda _incident: None)
    status, body = give(feedback, cast, rating=5)
    assert (status, body["error"]["message"]) == (409, "You have already given feedback on this incident")
    assert [row["rating"] for row in saved()] == [2]


@pytest.mark.parametrize("who", ["bystander", "engineer", "manager", "other_admin"])
@pytest.mark.parametrize("method", ["GET", "POST"])
def test_only_the_reporter_can_give_feedback_and_nobody_else_learns_the_incident_exists(feedback, cast, who, method):
    status, body = invoke(feedback, method, f"/incidents/{cast['incident']}", token=cast[who]["token"], body={"rating": 5})
    assert (status, body["error"]["message"]) == (404, "Incident not found")
    assert saved() == []


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_an_unknown_incident_is_404(feedback, cast, method):
    status, body = invoke(feedback, method, f"/incidents/{MISSING}", token=cast["reporter"]["token"], body={"rating": 5})
    assert (status, body["error"]["code"]) == (404, "not_found")


def test_feedback_stays_with_the_engineer_who_did_the_work(feedback, cast):
    assert give(feedback, cast)[0] == 201
    replacement = profile_for(person("ENGINEER", "New Engineer"), cast["other_admin"])
    db.query("UPDATE incidents SET assignee_id = %s WHERE id = %s", (replacement, cast["incident"]), fetch=False)
    assert saved()[0]["engineer_id"] == cast["profile"]


# --- reading feedback: the engineer's manager only -------------------------------------


def test_the_manager_reads_everything_said_about_their_engineer_newest_first(feedback, cast):
    second = incident(cast["reporter"], cast["profile"], "CLOSED", title="Broken light")
    assert give(feedback, cast, rating=5, comment="Quick")[0] == 201
    assert give(feedback, cast, incident_id=second, rating=2)[0] == 201
    db.query("UPDATE incident_feedback SET created_at = now() - interval '1 day' WHERE rating = 5", fetch=False)

    status, body = invoke(feedback, "GET", f"/api/feedback/engineers/{cast['profile']}", token=cast["manager"]["token"])
    assert status == 200
    assert [{k: v for k, v in row.items() if k not in ("id", "created_at")} for row in body["feedback"]] == [
        {"incident_id": second, "incident": "Broken light", "rating": 2, "comment": None, "author": "Rae Reporter"},
        {"incident_id": cast["incident"], "incident": "Leak", "rating": 5, "comment": "Quick", "author": "Rae Reporter"},
    ]
    assert all(row["id"] and "T" in row["created_at"] for row in body["feedback"])


@pytest.mark.parametrize(
    "who, status, code",
    [
        ("other_admin", 403, "access_denied"),  # an admin, but not this engineer's manager
        ("engineer", 403, "access_denied"),  # the engineer the feedback is about
        ("reporter", 403, "access_denied"),  # even its author cannot read it back
        ("bystander", 403, "access_denied"),
    ],
)
def test_nobody_but_the_manager_can_read_an_engineers_feedback(feedback, cast, who, status, code):
    assert give(feedback, cast, comment="Private")[0] == 201
    for path in (f"/engineers/{cast['profile']}", "/engineers"):
        answer_status, body = invoke(feedback, "GET", path, token=cast[who]["token"])
        if who == "other_admin" and path == "/engineers":
            assert (answer_status, body) == (200, {"engineers": []})  # they manage nobody
        else:
            assert (answer_status, body["error"]["code"]) == (status, code)
        assert "Private" not in json.dumps(body)


def test_the_other_admin_is_told_why(feedback, cast):
    status, body = invoke(feedback, "GET", f"/engineers/{cast['profile']}", token=cast["other_admin"]["token"])
    assert (status, body["error"]["message"]) == (403, NOT_THE_MANAGER)


def test_an_engineer_with_no_manager_has_feedback_nobody_can_read(feedback, cast):
    db.query("UPDATE engineer_profiles SET manager_id = NULL", fetch=False)
    assert invoke(feedback, "GET", f"/engineers/{cast['profile']}", token=cast["manager"]["token"])[0] == 403


def test_feedback_on_an_unknown_engineer_is_404(feedback, cast):
    status, body = invoke(feedback, "GET", f"/engineers/{MISSING}", token=cast["manager"]["token"])
    assert (status, body["error"]["message"]) == (404, "Engineer not found")


def test_a_manager_sees_a_rating_summary_for_each_engineer_they_manage_and_no_others(feedback, cast):
    quiet = profile_for(person("ENGINEER", "Quiet Engineer"), cast["manager"])
    theirs = profile_for(person("ENGINEER", "Someone Else's"), cast["other_admin"])
    for rating in (5, 4, 4):
        assert give(feedback, cast, incident_id=incident(cast["reporter"], cast["profile"]), rating=rating)[0] == 201
    assert give(feedback, cast, incident_id=incident(cast["reporter"], theirs), rating=1)[0] == 201

    status, body = invoke(feedback, "GET", "/api/feedback/engineers", token=cast["manager"]["token"])
    assert status == 200
    assert sorted(body["engineers"], key=lambda row: row["count"]) == [
        {"engineer_id": str(quiet), "count": 0, "average": None},
        {"engineer_id": str(cast["profile"]), "count": 3, "average": 4.3},
    ]
    assert invoke(feedback, "GET", "/engineers", token=cast["other_admin"]["token"])[1] == {
        "engineers": [{"engineer_id": str(theirs), "count": 1, "average": 1.0}]
    }


# --- the container's web server --------------------------------------------------------


@pytest.fixture
def container(feedback, monkeypatch):
    """server.py listening on a free port, as it does in the container: its base URL."""
    monkeypatch.setitem(sys.modules, "function", feedback)  # server.py does `from function import handler`
    spec = importlib.util.spec_from_file_location("feedback_server", BACKEND_DIR / "feedback" / "server.py")
    server_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server_module)
    server = server_module.HTTPServer(("127.0.0.1", 0), server_module.Adapter)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


def call(url, method="GET", body=None, token=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, response.headers["Content-Type"], json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, error.headers["Content-Type"], json.loads(error.read())


def test_the_container_serves_the_same_handler_over_http(container, cast):
    assert call(container + "/") == (200, "application/json", {"service": "feedback", "status": "ok"})
    assert call(container + "/api/feedback/?probe=1")[0] == 200  # prefix and query string as CloudFront sends them
    assert call(container + f"/incidents/{cast['incident']}")[0] == 401  # no token
    assert call(container + "/nope")[0] == 404

    token = cast["reporter"]["token"]
    assert call(container + f"/incidents/{cast['incident']}", "POST", {"rating": 5, "comment": "Great"}, token) == (
        201,
        "application/json",
        {"given": True, "can_give": False},
    )
    assert saved()[0]["comment"] == "Great"
    status, _, body = call(container + f"/engineers/{cast['profile']}", token=cast["manager"]["token"])
    assert (status, body["feedback"][0]["rating"]) == (200, 5)
