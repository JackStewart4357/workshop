"""Integration tests for the incidents service: every endpoint, through the Lambda
handler, against a real database."""

import uuid

import pytest

import db
import security
from conftest import invoke, load_service

MISSING = "00000000-0000-4000-8000-000000000000"  # a well-formed id that no row has
STATUSES = ["OPEN", "IN_PROGRESS", "BLOCKED", "RESOLVED", "CLOSED"]
# The workflow as the brief states it, written out again here on purpose.
ALLOWED = {
    ("OPEN", "IN_PROGRESS"),
    ("OPEN", "CLOSED"),
    ("IN_PROGRESS", "BLOCKED"),
    ("IN_PROGRESS", "RESOLVED"),
    ("BLOCKED", "IN_PROGRESS"),
    ("RESOLVED", "CLOSED"),
    ("RESOLVED", "IN_PROGRESS"),
}
# The moves that take an assigned incident from Open to each status.
ROUTE_TO = {
    "OPEN": [],
    "IN_PROGRESS": ["IN_PROGRESS"],
    "BLOCKED": ["IN_PROGRESS", "BLOCKED"],
    "RESOLVED": ["IN_PROGRESS", "RESOLVED"],
    "CLOSED": ["IN_PROGRESS", "RESOLVED", "CLOSED"],
}
LIST_KEYS = {
    "id", "title", "status", "priority", "category", "building", "floor_level", "seat", "reporter", "assignee",
    "assignee_id", "is_escalated", "blocked_reason", "escalation_reason", "created_at", "updated_at",
}  # fmt: skip
DENIED = "You do not have permission to perform this action"


@pytest.fixture(scope="session")
def incidents():
    return load_service("incidents")


def person(role, name):
    """A user with this role: id, name, an access token and, for an engineer, their profile id."""
    user = db.query(
        "INSERT INTO users (email, full_name, password_hash, role) VALUES (%s, %s, 'x', %s) RETURNING *",
        (f"{uuid.uuid4().hex[:10]}@acme.inc", name, role),
    )
    profile = None
    if role == "ENGINEER":
        profile = db.query(
            "INSERT INTO engineer_profiles (user_id, specialism) VALUES (%s, 'General') RETURNING id", (user["id"],)
        )["id"]
    return {
        "id": str(user["id"]),
        "name": name,
        "token": security.issue_token(user, "access", 60),
        "profile": profile and str(profile),
    }


@pytest.fixture
def cast():
    """One of everybody an incident can involve."""
    return {
        "admin": person("ADMIN", "Ada Admin"),
        "engineer": person("ENGINEER", "Eve Engineer"),  # the one incidents get assigned to
        "other_engineer": person("ENGINEER", "Omar Engineer"),
        "reporter": person("EMPLOYEE", "Rita Reporter"),
        "other_employee": person("EMPLOYEE", "Olga Employee"),
    }


@pytest.fixture
def site():
    """Two buildings, each with a floor and a seat, and two categories: all as ids."""

    def one(sql, *params):
        return str(db.query(sql + " RETURNING id", params)["id"])

    hq = one("INSERT INTO buildings (name, address) VALUES ('Headquarters', '1 Acme Plaza')")
    floor = one("INSERT INTO floors (building_id, level) VALUES (%s, 2)", hq)
    annex = one("INSERT INTO buildings (name, address) VALUES ('Annex', '25 Wharf Road')")
    annex_floor = one("INSERT INTO floors (building_id, level) VALUES (%s, 0)", annex)
    return {
        "building": hq,
        "floor": floor,
        "seat": one("INSERT INTO seats (floor_id, code) VALUES (%s, '2F-A14')", floor),
        "annex": annex,
        "annex_floor": annex_floor,
        "annex_seat": one("INSERT INTO seats (floor_id, code) VALUES (%s, 'GF-R01')", annex_floor),
        "category": str(db.query("SELECT id FROM categories WHERE name = 'Plumbing'")["id"]),
        "network": str(db.query("SELECT id FROM categories WHERE name = 'Network'")["id"]),
    }


class Desk:
    """The requests most tests need, each made as one of the cast."""

    def __init__(self, service, cast, site):
        self.service, self.cast, self.site = service, cast, site

    def call(self, who, method, path, **kwargs):
        return invoke(self.service, method, path, token=self.cast[who]["token"], **kwargs)

    def report(self, who="reporter", **changes):
        body = {
            "title": "Leaking tap",
            "description": "Drips all night",
            "category_id": self.site["category"],
            "building_id": self.site["building"],
            **changes,
        }
        status, body = self.call(who, "POST", "/tickets", body=body)
        assert status == 201, body
        return body["incident"]

    def assign(self, incident, engineer="engineer", priority=None):
        """As the admin: give the incident to this engineer (None for nobody), keeping its priority unless one is given."""
        body = {"priority": priority or incident["priority"], "assignee_id": engineer and self.cast[engineer]["profile"]}
        status, body = self.call("admin", "PATCH", f"/tickets/{incident['id']}", body=body)
        assert status == 200, body
        return body["incident"]

    def move(self, who, incident, status, reason=None):
        return self.call(who, "POST", f"/tickets/{incident['id']}/status", body={"status": status, "reason": reason})

    def note(self, who, incident, **body):
        return self.call(who, "POST", f"/tickets/{incident['id']}/notes", body=body)

    def at(self, status, who="reporter", **changes):
        """An incident assigned to the engineer and taken to this status by the admin."""
        incident = self.assign(self.report(who, **changes))
        for step in ROUTE_TO[status]:
            code, body = self.move("admin", incident, step, "Waiting for a part")
            assert code == 200, body
            incident = body["incident"]
        return incident

    def see(self, who, incident):
        status, body = self.call(who, "GET", f"/tickets/{incident['id']}")
        assert status == 200, body
        return body["incident"]

    def titles(self, who, **query):
        status, body = self.call(who, "GET", "/tickets", query=query)
        assert status == 200, body
        return [incident["title"] for incident in body["incidents"]]


@pytest.fixture
def desk(incidents, cast, site):
    return Desk(incidents, cast, site)


def saved():
    return db.query(
        "SELECT (SELECT count(*) FROM incidents) AS incidents, (SELECT count(*) FROM incident_notes) AS notes, "
        "(SELECT count(*) FROM incident_status_history) AS history"
    )


def row(incident):
    return db.query("SELECT * FROM incidents WHERE id = %s", (incident["id"],))


def break_query(monkeypatch, service, start):
    """Make the service's next statement that starts like this fail, as a lost connection or a bug would."""
    real = service.query

    def failing(sql, *args, **kwargs):
        if sql.startswith(start):
            raise RuntimeError("simulated failure")
        return real(sql, *args, **kwargs)

    monkeypatch.setattr(service, "query", failing)


# --- health, sign-in and roles ---------------------------------------------------------


@pytest.mark.parametrize("path", ["/", "/api/incidents", "/incidents/"])
def test_health_needs_no_sign_in(incidents, path):
    assert invoke(incidents, "GET", path) == (200, {"service": "incidents", "status": "ok"})


ENDPOINTS = [
    ("GET", "/categories"),
    ("GET", "/summary"),
    ("GET", "/tickets"),
    ("POST", "/tickets"),
    ("GET", f"/tickets/{MISSING}"),
    ("PATCH", f"/tickets/{MISSING}"),
    ("DELETE", f"/tickets/{MISSING}"),
    ("POST", f"/tickets/{MISSING}/status"),
    ("POST", f"/tickets/{MISSING}/notes"),
    ("POST", f"/tickets/{MISSING}/escalate"),
]


@pytest.mark.parametrize("method, path", ENDPOINTS)
def test_every_endpoint_needs_a_signed_in_user(incidents, method, path):
    status, body = invoke(incidents, method, path, body={})
    assert (status, body["error"]["code"]) == (401, "unauthorized")


@pytest.mark.parametrize("who", ["engineer", "reporter"])
@pytest.mark.parametrize("method", ["PATCH", "DELETE"])
def test_only_admins_can_assign_prioritise_or_remove(desk, who, method):
    incident = desk.assign(desk.report())  # even their own incident, even assigned to them
    status, body = desk.call(who, method, f"/tickets/{incident['id']}", body={"priority": "LOW", "assignee_id": None})
    assert (status, body["error"]["code"]) == (403, "access_denied")
    assert desk.see("admin", incident) == incident


def test_an_id_that_is_not_a_uuid_is_an_unknown_path(desk):
    status, body = desk.call("admin", "GET", "/tickets/42")
    assert (status, body["error"]["code"]) == (404, "not_found")


@pytest.mark.parametrize("who", ["admin", "engineer", "reporter"])
def test_everyone_gets_the_categories_by_name(desk, who):
    status, body = desk.call(who, "GET", "/api/incidents/categories")
    names = [category["name"] for category in body["categories"]]
    assert (status, len(names), names) == (200, 10, sorted(names, key=str.lower))  # as a person would sort them
    assert {"id": desk.site["category"], "name": "Plumbing", "type": "FACILITY"} in body["categories"]


# --- reporting -------------------------------------------------------------------------


def test_reporting_returns_the_whole_incident_with_its_first_history_row(desk):
    site, reporter = desk.site, desk.cast["reporter"]
    status, body = desk.call(
        "reporter",
        "POST",
        "/api/incidents/tickets",
        body={
            "title": "  Leaking tap ",
            "description": " Drips all night ",
            "category_id": site["category"],
            "building_id": site["building"],
            "floor_id": site["floor"],
            "seat_id": site["seat"],
            "priority": "HIGH",
            "status": "CLOSED",  # not something the reporter can choose
            "reporter_id": desk.cast["admin"]["id"],
            "assignee_id": desk.cast["engineer"]["profile"],
        },
    )
    incident = body["incident"]
    assert status == 201
    assert incident == {
        "id": incident["id"],
        "title": "Leaking tap",
        "status": "OPEN",
        "priority": "HIGH",
        "category": "Plumbing",
        "building": "Headquarters",
        "floor_level": 2,
        "seat": "2F-A14",
        "reporter": "Rita Reporter",
        "assignee": None,
        "assignee_id": None,
        "is_escalated": False,
        "created_at": incident["created_at"],
        "updated_at": incident["created_at"],
        "description": "Drips all night",
        "blocked_reason": None,
        "escalation_reason": None,
        "escalated_at": None,
        "escalated_by": None,
        "category_id": site["category"],
        "building_id": site["building"],
        "floor_id": site["floor"],
        "seat_id": site["seat"],
        "reporter_id": reporter["id"],
        "acknowledged_at": None,
        "assigned_at": None,
        "resolved_at": None,
        "closed_at": None,
        "notes": [],
        "history": [
            {
                "from_status": None,
                "to_status": "OPEN",
                "changed_by": "Rita Reporter",
                "reason": None,
                "changed_at": incident["created_at"],
            }
        ],
        "next_statuses": [],
        "is_staff": False,
        "can_escalate": True,
    }
    assert incident["created_at"][10] == "T"  # ISO 8601, which every browser's Date reads
    assert desk.see("reporter", incident) == incident


@pytest.mark.parametrize("who", ["admin", "engineer", "reporter"])
def test_anyone_signed_in_can_report_with_only_the_required_fields(desk, who):
    incident = desk.report(who, floor_id="", seat_id=None, priority="")  # blank means left out
    assert (incident["reporter"], incident["priority"]) == (desk.cast[who]["name"], "MEDIUM")
    assert (incident["floor_level"], incident["seat"], incident["floor_id"]) == (None, None, None)


def test_the_longest_title_and_description_are_accepted(desk):
    incident = desk.report(title="t" * 150, description="d" * 4000, floor_id=desk.site["floor"])
    assert (len(incident["title"]), len(incident["description"]), incident["seat"]) == (150, 4000, None)


@pytest.mark.parametrize(
    "field, value, message",
    [
        ("title", "  ", "Title is required"),
        ("title", "t" * 151, "Title must be at most 150 characters"),
        ("description", None, "Description is required"),
        ("description", "d" * 4001, "Description must be at most 4000 characters"),
        ("category_id", "plumbing", "Category is required"),
        ("building_id", None, "Building is required"),
        ("floor_id", "2", "Floor is required"),
        ("seat_id", 14, "Seat is required"),
        ("priority", "URGENT", "Priority must be one of: LOW, MEDIUM, HIGH, CRITICAL"),
        ("priority", 3, "Priority must be one of: LOW, MEDIUM, HIGH, CRITICAL"),
        ("seat_id", "site:seat", "Choose the floor the seat is on"),  # a seat, but no floor
        ("category_id", MISSING, "Choose a category from the list"),
        ("building_id", MISSING, "Choose a building from the list"),
        ("floor_id", MISSING, "Choose a floor in this building"),
        ("floor_id", "site:annex_floor", "Choose a floor in this building"),
    ],
)
def test_report_checks_each_field_and_saves_nothing(desk, field, value, message):
    if isinstance(value, str) and value.startswith("site:"):
        value = desk.site[value[5:]]
    body = {"title": "Leak", "description": "Drip", "category_id": desk.site["category"], "building_id": desk.site["building"]}
    status, answer = desk.call("reporter", "POST", "/tickets", body={**body, field: value})
    assert (status, answer["error"]["code"], answer["error"]["message"]) == (400, "validation_error", "Some fields are invalid")
    assert answer["error"]["details"] == {field: message}
    assert saved() == {"incidents": 0, "notes": 0, "history": 0}


@pytest.mark.parametrize("seat", [MISSING, "annex_seat"])
def test_a_seat_must_be_on_the_chosen_floor(desk, seat):
    status, body = desk.call(
        "reporter",
        "POST",
        "/tickets",
        body={
            "title": "Leak",
            "description": "Drip",
            "category_id": desk.site["category"],
            "building_id": desk.site["building"],
            "floor_id": desk.site["floor"],
            "seat_id": desk.site.get(seat, seat),
        },
    )
    assert (status, body["error"]["details"]) == (400, {"seat_id": "Choose a seat on this floor"})
    assert saved()["incidents"] == 0


def test_report_names_every_missing_field_at_once(desk):
    status, body = desk.call("reporter", "POST", "/tickets", body={})
    assert status == 400
    assert set(body["error"]["details"]) == {"title", "description", "category_id", "building_id"}


def test_an_incident_is_never_saved_without_its_first_history_row(desk, incidents, monkeypatch):
    break_query(monkeypatch, incidents, "INSERT INTO incident_status_history")
    status, body = desk.call(
        "reporter",
        "POST",
        "/tickets",
        body={"title": "Leak", "description": "Drip", "category_id": desk.site["category"], "building_id": desk.site["building"]},
    )
    assert (status, body["error"]["code"]) == (500, "internal_error")
    assert saved() == {"incidents": 0, "notes": 0, "history": 0}


# --- who sees what ---------------------------------------------------------------------


@pytest.fixture
def three(desk):
    """Three incidents, one per way of being involved."""
    return {
        "tap": desk.assign(desk.report("reporter", title="Tap")),  # the reporter's, assigned to the engineer
        "door": desk.report("other_employee", title="Door"),  # the other employee's, assigned to nobody
        "wifi": desk.report("other_engineer", title="Wifi"),  # reported by an engineer, assigned to nobody
    }


@pytest.mark.parametrize(
    "who, titles",
    [
        ("admin", {"Tap", "Door", "Wifi"}),
        ("engineer", {"Tap"}),
        ("other_engineer", {"Wifi"}),
        ("reporter", {"Tap"}),
        ("other_employee", {"Door"}),
    ],
)
def test_the_list_holds_only_what_the_caller_may_see(desk, three, who, titles):
    assert set(desk.titles(who)) == titles
    assert desk.call(who, "GET", "/summary")[1]["total"] == len(titles)


@pytest.mark.parametrize("who", ["admin", "engineer", "reporter"])
def test_an_incident_opens_for_the_admin_its_engineer_and_its_reporter(desk, three, who):
    assert desk.see(who, three["tap"])["title"] == "Tap"


REQUESTS_ON_ONE = [
    ("GET", "", None),
    ("POST", "/status", {"status": "CLOSED"}),
    ("POST", "/notes", {"body": "Me too"}),
]


@pytest.mark.parametrize("who", ["other_engineer", "other_employee"])
@pytest.mark.parametrize("method, tail, body", REQUESTS_ON_ONE)
def test_someone_elses_incident_looks_exactly_like_one_that_does_not_exist(desk, three, who, method, tail, body):
    answer = desk.call(who, method, f"/tickets/{three['tap']['id']}{tail}", body=body)
    assert answer == desk.call(who, method, f"/tickets/{MISSING}{tail}", body=body)
    assert answer == (404, {"error": {"code": "not_found", "message": "Incident not found"}})
    assert desk.see("admin", three["tap"]) == three["tap"]


@pytest.mark.parametrize(
    "method, tail, body",
    [*REQUESTS_ON_ONE, ("PATCH", "", {"priority": "LOW", "assignee_id": None}), ("DELETE", "", None)],
)
def test_an_unknown_incident_is_404_for_the_admin_too(desk, three, method, tail, body):
    status, answer = desk.call("admin", method, f"/tickets/{MISSING}{tail}", body=body)
    assert (status, answer["error"]["message"]) == (404, "Incident not found")
    assert saved() == {"incidents": 3, "notes": 0, "history": 3}


# --- the list and its filters ----------------------------------------------------------


def test_the_list_is_newest_first_with_the_columns_the_screen_shows(desk):
    for title, age in (("Middle", 2), ("Oldest", 3), ("Newest", 1)):
        incident = desk.report(title=title, floor_id=desk.site["floor"], seat_id=desk.site["seat"])
        db.query(
            "UPDATE incidents SET created_at = now() - %s * interval '1 day' WHERE id = %s",
            (age, incident["id"]),
            fetch=False,
        )
    newest = desk.assign(incident, priority="CRITICAL")

    status, body = desk.call("admin", "GET", "/api/incidents/tickets")
    assert (status, [each["title"] for each in body["incidents"]]) == (200, ["Newest", "Middle", "Oldest"])
    assert set(body["incidents"][0]) == LIST_KEYS
    assert body["incidents"][0] == {key: desk.see("admin", newest)[key] for key in LIST_KEYS}
    assert (body["incidents"][0]["assignee"], body["incidents"][0]["floor_level"]) == ("Eve Engineer", 2)


EVERY = {"Tap", "Router", "Door", "Projector"}


@pytest.fixture
def mixed(desk):
    """Four incidents that differ in everything the list can filter on."""
    site = desk.site
    desk.report(title="Tap", description="Drips all night")  # open, medium, plumbing, HQ, nobody
    desk.at("IN_PROGRESS", title="Router", description="No wifi on floor 2", category_id=site["network"])
    desk.assign(desk.report("other_employee", title="Door", building_id=site["annex"]), "other_engineer", "HIGH")
    desk.at("RESOLVED", "other_employee", title="Projector", description="The TAP adapter is missing", building_id=site["annex"])


@pytest.mark.parametrize(
    "query, titles",
    [
        ({}, EVERY),
        ({"status": "OPEN"}, {"Tap", "Door"}),
        ({"status": "RESOLVED"}, {"Projector"}),
        ({"status": "CLOSED"}, set()),
        ({"priority": "HIGH"}, {"Door"}),
        ({"priority": "MEDIUM"}, {"Tap", "Router", "Projector"}),
        ({"category_id": "site:network"}, {"Router"}),
        ({"building_id": "site:annex"}, {"Door", "Projector"}),
        ({"assignee": "none"}, {"Tap"}),
        ({"assignee": "cast:other_engineer"}, {"Door"}),
        ({"assignee": "cast:engineer"}, {"Router", "Projector"}),
        ({"assignee": "me"}, set()),  # the admin is nobody's assignee
        ({"q": "tap"}, {"Tap", "Projector"}),  # title or description, any case
        ({"q": "  WIFI "}, {"Router"}),
        ({"q": "nothing like this"}, set()),
        ({"status": "OPEN", "building_id": "site:annex"}, {"Door"}),
        ({"q": "tap", "assignee": "cast:engineer", "building_id": "site:annex", "priority": "MEDIUM"}, {"Projector"}),
        (dict.fromkeys(("status", "priority", "category_id", "building_id", "assignee", "q"), " "), EVERY),  # blank
        ({"unknown": "ignored"}, EVERY),
    ],
)
def test_filters_narrow_the_list_alone_and_together(desk, mixed, query, titles):
    def resolve(value):
        kind, _, name = value.partition(":")
        return {"site": lambda: desk.site[name], "cast": lambda: desk.cast[name]["profile"]}.get(kind, lambda: value)()

    assert set(desk.titles("admin", **{key: resolve(value) for key, value in query.items()})) == titles


def test_filters_never_widen_what_the_caller_may_see(desk, mixed):
    assert set(desk.titles("reporter", status="OPEN")) == {"Tap"}
    assert set(desk.titles("engineer", assignee="me")) == {"Router", "Projector"}
    assert set(desk.titles("engineer", assignee="none")) == set()
    assert set(desk.titles("other_employee", q="o")) == {"Door", "Projector"}
    assert set(desk.titles("other_employee", assignee="me")) == set()


@pytest.mark.parametrize(
    "search, titles",
    [
        ("100%", {"100% broken"}),
        ("%", {"100% broken"}),
        ("snake_case", {"snake_case"}),
        ("_", {"snake_case"}),
        ("C:\\temp", {"C:\\temp full"}),
        ("\\", {"C:\\temp full"}),
        ("'; DROP TABLE incidents; --", set()),
    ],
)
def test_search_treats_wildcards_as_ordinary_characters(desk, search, titles):
    for title in ("100% broken", "100 percent", "snake_case", "snakeXcase", "C:\\temp full"):
        desk.report(title=title)
    assert set(desk.titles("admin", q=search)) == titles


@pytest.mark.parametrize(
    "filter_name, value, message",
    [
        ("status", "DONE", "Status must be one of: OPEN, IN_PROGRESS, BLOCKED, RESOLVED, CLOSED"),
        ("status", "open", "Status must be one of: OPEN, IN_PROGRESS, BLOCKED, RESOLVED, CLOSED"),
        ("priority", "URGENT", "Priority must be one of: LOW, MEDIUM, HIGH, CRITICAL"),
        ("category_id", "7", "Category is required"),
        ("building_id", "hq", "Building is required"),
        ("assignee", "eve", "Assignee is required"),
        ("q", "x" * 101, "Search must be at most 100 characters"),
    ],
)
def test_a_malformed_filter_is_refused_by_name(desk, filter_name, value, message):
    status, body = desk.call("admin", "GET", "/tickets", query={"status": "OPEN", filter_name: value})
    assert (status, body["error"]["code"]) == (400, "validation_error")
    assert body["error"]["details"] == {filter_name: message}


def test_the_list_stops_at_the_200_newest(desk):
    oldest = desk.report(title="Oldest")
    db.query("UPDATE incidents SET created_at = now() - interval '1 day' WHERE id = %s", (oldest["id"],), fetch=False)
    db.query(
        "INSERT INTO incidents (title, description, category_id, building_id, reporter_id) "
        "SELECT 'Copy ' || n, 'x', %s, %s, %s FROM generate_series(1, 200) AS n",
        (desk.site["category"], desk.site["building"], desk.cast["reporter"]["id"]),
        fetch=False,
    )
    titles = desk.titles("admin")
    assert (len(titles), "Oldest" in titles) == (200, False)
    assert desk.titles("admin", q="oldest") == ["Oldest"]  # filtering happens before the cut


# --- assigning and prioritising --------------------------------------------------------


def test_assigning_records_who_and_when_and_counts_as_acknowledging(desk):
    incident = desk.report()
    assigned = desk.assign(incident, priority="CRITICAL")
    assert (assigned["assignee"], assigned["assignee_id"]) == ("Eve Engineer", desk.cast["engineer"]["profile"])
    assert (assigned["priority"], assigned["status"]) == ("CRITICAL", "OPEN")
    assert assigned["assigned_at"] == assigned["acknowledged_at"] == assigned["updated_at"] > incident["updated_at"]
    assert assigned["next_statuses"] == ["IN_PROGRESS", "CLOSED"]
    assert desk.see("engineer", incident)["next_statuses"] == ["IN_PROGRESS"]
    # Staff on an incident: any admin and the engineer it is assigned to, not its reporter
    assert [desk.see(who, incident)["is_staff"] for who in ("admin", "engineer", "reporter")] == [True, True, False]


def test_only_a_new_assignee_moves_the_assigned_time(desk):
    first = desk.assign(desk.report())
    same = desk.call(  # the same engineer, written differently, with a new priority
        "admin", "PATCH", f"/api/incidents/tickets/{first['id']}",
        body={"priority": "LOW", "assignee_id": first["assignee_id"].upper()},
    )[1]["incident"]  # fmt: skip
    assert (same["priority"], same["assigned_at"]) == ("LOW", first["assigned_at"])
    assert same["acknowledged_at"] == first["acknowledged_at"]
    assert same["updated_at"] > first["updated_at"]

    moved = desk.assign(first, "other_engineer")
    assert (moved["assignee"], moved["acknowledged_at"]) == ("Omar Engineer", first["acknowledged_at"])
    assert moved["assigned_at"] > first["assigned_at"]

    nobody = desk.assign(first, None)
    assert (nobody["assignee"], nobody["assignee_id"], nobody["assigned_at"]) == (None, None, moved["assigned_at"])
    assert desk.titles("other_engineer") == []  # no longer theirs to see


def test_an_assignee_who_was_deactivated_later_can_stay_while_the_priority_changes(desk):
    incident = desk.assign(desk.report())
    db.query("UPDATE users SET is_active = FALSE WHERE id = %s", (desk.cast["engineer"]["id"],), fetch=False)
    assert desk.assign(incident, priority="HIGH")["priority"] == "HIGH"


@pytest.mark.parametrize(
    "field, value, message",
    [
        ("priority", None, "Priority must be one of: LOW, MEDIUM, HIGH, CRITICAL"),
        ("priority", "URGENT", "Priority must be one of: LOW, MEDIUM, HIGH, CRITICAL"),
        ("assignee_id", "eve", "Assignee is required"),
        ("assignee_id", MISSING, "Choose an active engineer"),
        ("assignee_id", "the engineer's user id", "Choose an active engineer"),
        ("assignee_id", "an inactive engineer", "Choose an active engineer"),
    ],
)
def test_assigning_checks_each_field_and_changes_nothing(desk, field, value, message):
    incident = desk.assign(desk.report(), "other_engineer")
    if value == "the engineer's user id":
        value = desk.cast["engineer"]["id"]
    if value == "an inactive engineer":
        db.query("UPDATE users SET is_active = FALSE WHERE id = %s", (desk.cast["engineer"]["id"],), fetch=False)
        value = desk.cast["engineer"]["profile"]
    body = {"priority": "CRITICAL", "assignee_id": desk.cast["engineer"]["profile"], field: value}
    status, answer = desk.call("admin", "PATCH", f"/tickets/{incident['id']}", body=body)
    assert (status, answer["error"]["details"]) == (400, {field: message})
    assert desk.see("admin", incident) == incident


def test_a_closed_incident_cannot_be_reassigned_or_reprioritised(desk):
    closed = desk.at("CLOSED")
    status, body = desk.call("admin", "PATCH", f"/tickets/{closed['id']}", body={"priority": "LOW", "assignee_id": None})
    assert (status, body["error"]) == (409, {"code": "conflict", "message": "A closed incident cannot be changed"})
    assert desk.see("admin", closed) == closed


# --- the workflow ----------------------------------------------------------------------


def expected(who, old, new):
    """What the brief says should happen when this caller asks for this move."""
    if (old, new) not in ALLOWED:
        return 409
    if who == "admin":
        return 200
    if who == "engineer":  # the assigned one
        return 403 if (old, new) == ("OPEN", "CLOSED") else 200
    return 200 if old == "RESOLVED" else 403  # the reporter


@pytest.mark.parametrize("who", ["admin", "engineer", "reporter"])
@pytest.mark.parametrize("old", STATUSES)
@pytest.mark.parametrize("new", STATUSES)
def test_every_move_is_allowed_or_refused_as_the_workflow_says(desk, who, old, new):
    incident = desk.at(old)
    status, body = desk.move(who, incident, new, "Because")
    assert status == expected(who, old, new)
    after = desk.see("admin", incident)
    if status == 200:
        assert (after["status"], len(after["history"])) == (new, len(incident["history"]) + 1)
        assert after["history"][-1] == {
            "from_status": old,
            "to_status": new,
            "changed_by": desk.cast[who]["name"],
            "reason": "Because",
            "changed_at": after["updated_at"],
        }
    else:
        assert body["error"]["code"] == {409: "conflict", 403: "access_denied"}[status]
        assert after == incident


@pytest.mark.parametrize("who", ["admin", "engineer", "reporter"])
@pytest.mark.parametrize("status", STATUSES)
def test_the_incident_lists_exactly_the_moves_its_reader_can_make(desk, who, status):
    incident = desk.at(status)
    can = [new for new in STATUSES if expected(who, status, new) == 200]
    assert sorted(desk.see(who, incident)["next_statuses"]) == sorted(can)


@pytest.mark.parametrize(
    "old, new, message",
    [
        ("CLOSED", "IN_PROGRESS", "An incident that is Closed cannot be moved to In progress"),
        ("OPEN", "RESOLVED", "An incident that is Open cannot be moved to Resolved"),
        ("IN_PROGRESS", "IN_PROGRESS", "An incident that is In progress cannot be moved to In progress"),
        ("BLOCKED", "OPEN", "An incident that is Blocked cannot be moved to Open"),
    ],
)
def test_a_move_outside_the_workflow_is_explained_in_words(desk, old, new, message):
    status, body = desk.move("admin", desk.at(old), new)
    assert (status, body["error"]) == (409, {"code": "conflict", "message": message})


def test_a_move_the_caller_may_not_make_is_access_denied(desk):
    status, body = desk.move("reporter", desk.at("IN_PROGRESS"), "RESOLVED")
    assert (status, body["error"]) == (403, {"code": "access_denied", "message": DENIED})


def test_work_cannot_start_until_someone_is_assigned(desk):
    incident = desk.report()
    assert desk.see("admin", incident)["next_statuses"] == ["CLOSED"]
    status, body = desk.move("admin", incident, "IN_PROGRESS")
    assert (status, body["error"]) == (409, {"code": "conflict", "message": "Assign an engineer before work starts"})
    assert row(incident)["status"] == "OPEN"


@pytest.mark.parametrize(
    "old, body, details",
    [
        ("IN_PROGRESS", {"status": "BLOCKED"}, {"reason": "Say what is blocking it"}),
        ("IN_PROGRESS", {"status": "BLOCKED", "reason": "   "}, {"reason": "Say what is blocking it"}),
        ("RESOLVED", {"status": "IN_PROGRESS", "reason": ""}, {"reason": "Say why it needs more work"}),
        ("IN_PROGRESS", {"status": "RESOLVED", "reason": "r" * 501}, {"reason": "Reason must be at most 500 characters"}),
        ("IN_PROGRESS", {"status": "RESOLVED", "reason": 7}, {"reason": "Reason is required"}),
        ("IN_PROGRESS", {"status": "DONE"}, {"status": "Status must be one of: OPEN, IN_PROGRESS, BLOCKED, RESOLVED, CLOSED"}),
        ("IN_PROGRESS", {}, {"status": "Status must be one of: OPEN, IN_PROGRESS, BLOCKED, RESOLVED, CLOSED"}),
    ],
)
def test_a_move_checks_its_status_and_reason_and_changes_nothing(desk, old, body, details):
    incident = desk.at(old)
    status, answer = desk.call("engineer", "POST", f"/tickets/{incident['id']}/status", body=body)
    assert (status, answer["error"]["code"], answer["error"]["details"]) == (400, "validation_error", details)
    assert desk.see("admin", incident) == incident


def test_moves_that_need_no_reason_work_without_one_and_a_long_one_is_kept(desk):
    incident = desk.at("IN_PROGRESS")
    status, body = desk.call("engineer", "POST", f"/api/incidents/tickets/{incident['id']}/status", body={"status": "RESOLVED"})
    assert (status, body["incident"]["history"][-1]["reason"]) == (200, None)
    status, body = desk.move("reporter", incident, "IN_PROGRESS", "  " + "r" * 500 + " ")
    assert (status, body["incident"]["history"][-1]["reason"]) == (200, "r" * 500)


def test_each_move_stamps_the_incident_as_it_goes(desk):
    incident = desk.assign(desk.report())
    working = desk.move("engineer", incident, "IN_PROGRESS")[1]["incident"]
    assert (working["blocked_reason"], working["resolved_at"], working["closed_at"]) == (None, None, None)
    assert working["acknowledged_at"] == incident["acknowledged_at"]  # the first staff action stays the first

    blocked = desk.move("engineer", incident, "BLOCKED", " Waiting for a part ")[1]["incident"]
    assert (blocked["blocked_reason"], blocked["history"][-1]["reason"]) == ("Waiting for a part", "Waiting for a part")
    unblocked = desk.move("engineer", incident, "IN_PROGRESS", "The part arrived")[1]["incident"]
    assert (unblocked["blocked_reason"], unblocked["resolved_at"]) == (None, None)

    resolved = desk.move("engineer", incident, "RESOLVED", "Replaced the washer")[1]["incident"]
    assert (resolved["resolved_at"], resolved["closed_at"], resolved["blocked_reason"]) == (resolved["updated_at"], None, None)
    reopened = desk.move("reporter", incident, "IN_PROGRESS", "Still dripping")[1]["incident"]
    assert (reopened["resolved_at"], reopened["closed_at"]) == (resolved["resolved_at"], None)  # the last time it was resolved
    resolved_again = desk.move("admin", incident, "RESOLVED")[1]["incident"]
    assert resolved_again["resolved_at"] > resolved["resolved_at"]

    closed = desk.move("reporter", incident, "CLOSED")[1]["incident"]
    assert (closed["closed_at"], closed["resolved_at"]) == (closed["updated_at"], resolved_again["resolved_at"])
    assert closed["closed_at"] > resolved_again["updated_at"]
    assert [(step["from_status"], step["to_status"], step["changed_by"]) for step in closed["history"]] == [
        (None, "OPEN", "Rita Reporter"),
        ("OPEN", "IN_PROGRESS", "Eve Engineer"),
        ("IN_PROGRESS", "BLOCKED", "Eve Engineer"),
        ("BLOCKED", "IN_PROGRESS", "Eve Engineer"),
        ("IN_PROGRESS", "RESOLVED", "Eve Engineer"),
        ("RESOLVED", "IN_PROGRESS", "Rita Reporter"),
        ("IN_PROGRESS", "RESOLVED", "Ada Admin"),
        ("RESOLVED", "CLOSED", "Rita Reporter"),
    ]
    assert (closed["next_statuses"], desk.see("admin", incident)["next_statuses"]) == ([], [])


def test_a_staff_move_acknowledges_an_incident_and_a_reporters_move_does_not(desk):
    untouched = desk.report()
    closed = desk.move("admin", untouched, "CLOSED")[1]["incident"]  # nobody was ever assigned
    assert closed["acknowledged_at"] == closed["closed_at"] == closed["updated_at"]

    resolved = desk.at("RESOLVED")
    db.query("UPDATE incidents SET acknowledged_at = NULL WHERE id = %s", (resolved["id"],), fetch=False)
    assert desk.move("reporter", resolved, "CLOSED")[1]["incident"]["acknowledged_at"] is None


def test_two_people_moving_the_same_incident_at_once_cannot_both_win(desk, incidents, monkeypatch):
    incident = desk.at("IN_PROGRESS")
    real = incidents.find

    def read_then_lose_the_race(user, incident_id):
        found = real(user, incident_id)
        db.query("UPDATE incidents SET status = 'RESOLVED' WHERE id = %s", (incident_id,), fetch=False)
        return found

    monkeypatch.setattr(incidents, "find", read_then_lose_the_race)
    status, body = desk.move("engineer", incident, "BLOCKED", "Waiting for a part")
    assert (status, body["error"]) == (
        409,
        {"code": "conflict", "message": "This incident was just changed by someone else. Reload and try again."},
    )
    after = row(incident)
    assert (after["status"], after["blocked_reason"], saved()["history"]) == ("RESOLVED", None, len(incident["history"]))


def test_a_move_and_its_history_row_are_saved_together_or_not_at_all(desk, incidents, monkeypatch):
    incident = desk.at("IN_PROGRESS")
    break_query(monkeypatch, incidents, "INSERT INTO incident_status_history")
    status, body = desk.move("engineer", incident, "RESOLVED")
    assert (status, body["error"]["code"]) == (500, "internal_error")
    monkeypatch.undo()
    assert desk.see("admin", incident) == incident


# --- notes -----------------------------------------------------------------------------


def test_a_note_comes_back_as_the_incident_will_show_it(desk):
    incident = desk.at("IN_PROGRESS")
    status, body = desk.call("reporter", "POST", f"/api/incidents/tickets/{incident['id']}/notes", body={"body": "  Worse today "})
    note = body["note"]
    assert status == 201
    assert note == {
        "id": note["id"],
        "body": "Worse today",
        "is_internal": False,
        "author": "Rita Reporter",
        "author_role": "EMPLOYEE",
        "created_at": note["created_at"],
    }
    for who in ("admin", "engineer", "reporter"):
        assert desk.see(who, incident)["notes"] == [note]


def test_internal_notes_are_written_and_read_by_staff_only(desk):
    incident = desk.at("IN_PROGRESS")
    public = desk.note("engineer", incident, body="On my way", is_internal=False)[1]["note"]
    private = desk.note("engineer", incident, body="Third time this month", is_internal=True)[1]["note"]
    from_admin = desk.note("admin", incident, body="Check the warranty", is_internal=True)[1]["note"]
    assert (private["is_internal"], private["author_role"], from_admin["author_role"]) == (True, "ENGINEER", "ADMIN")

    assert desk.see("admin", incident)["notes"] == desk.see("engineer", incident)["notes"] == [public, private, from_admin]
    assert desk.see("reporter", incident)["notes"] == [public]


@pytest.mark.parametrize("who, reported_by", [("reporter", "reporter"), ("other_engineer", "other_engineer")])
def test_someone_who_only_reported_an_incident_cannot_write_an_internal_note(desk, who, reported_by):
    incident = desk.assign(desk.report(reported_by))  # an engineer who reported it is not its engineer
    status, body = desk.note(who, incident, body="Secret", is_internal=True)
    assert (status, body["error"]) == (403, {"code": "access_denied", "message": DENIED})
    assert saved()["notes"] == 0


@pytest.mark.parametrize(
    "body, details",
    [
        ({}, {"body": "Note is required"}),
        ({"body": "  "}, {"body": "Note is required"}),
        ({"body": "n" * 2001}, {"body": "Note must be at most 2000 characters"}),
        ({"body": "Fine", "is_internal": "yes"}, {"is_internal": "Internal must be true or false"}),
    ],
)
def test_a_note_checks_its_fields_and_saves_nothing(desk, body, details):
    incident = desk.at("IN_PROGRESS")
    status, answer = desk.note("engineer", incident, **body)
    assert (status, answer["error"]["details"]) == (400, details)
    assert saved()["notes"] == 0


def test_the_longest_note_is_accepted_and_a_closed_incident_takes_none(desk):
    assert len(desk.note("reporter", desk.at("RESOLVED"), body="n" * 2000, is_internal=None)[1]["note"]["body"]) == 2000
    for who in ("admin", "reporter"):
        status, body = desk.note(who, desk.at("CLOSED"), body="One more thing")
        assert (status, body["error"]) == (409, {"code": "conflict", "message": "A closed incident cannot take new notes"})
    assert saved()["notes"] == 1


def test_the_first_staff_note_acknowledges_an_incident_and_a_reporters_does_not(desk):
    incident = desk.report()
    desk.note("reporter", incident, body="Any news?")
    asked = desk.see("admin", incident)
    assert (asked["acknowledged_at"], asked["updated_at"] > incident["updated_at"]) == (None, True)

    desk.note("admin", incident, body="Looking into it")
    first = desk.see("admin", incident)
    assert first["acknowledged_at"] == first["updated_at"] > asked["updated_at"]
    desk.note("admin", incident, body="Ordered a part", is_internal=True)
    assert desk.see("admin", incident)["acknowledged_at"] == first["acknowledged_at"]
    assert [note["body"] for note in desk.see("admin", incident)["notes"]] == ["Any news?", "Looking into it", "Ordered a part"]


def test_a_note_on_an_incident_removed_a_moment_ago_is_404_and_not_saved(desk, incidents, monkeypatch):
    monkeypatch.setattr(incidents, "find", lambda _user, _id: {"status": "OPEN", "assignee_user_id": None})
    status, body = desk.call("admin", "POST", f"/tickets/{MISSING}/notes", body={"body": "Too late"})
    assert (status, body["error"]["message"]) == (404, "Incident not found")
    assert saved()["notes"] == 0


@pytest.mark.parametrize("who", ["admin", "reporter"])
def test_a_note_and_the_change_to_its_incident_are_saved_together_or_not_at_all(desk, incidents, monkeypatch, who):
    incident = desk.report()
    break_query(monkeypatch, incidents, "UPDATE incidents")
    assert desk.note(who, incident, body="Looking into it")[0] == 500
    monkeypatch.undo()
    assert (saved()["notes"], desk.see("reporter", incident)) == (0, incident)


# --- removing --------------------------------------------------------------------------


def test_removing_an_incident_takes_its_notes_and_history_and_nothing_else(desk):
    doomed, kept = desk.at("RESOLVED"), desk.at("IN_PROGRESS")
    desk.note("reporter", doomed, body="Thanks")
    desk.note("reporter", kept, body="Any news?")
    kept = desk.see("admin", kept)

    assert desk.call("admin", "DELETE", f"/api/incidents/tickets/{doomed['id']}") == (204, None)
    assert desk.call("admin", "GET", f"/tickets/{doomed['id']}")[0] == 404
    assert saved() == {"incidents": 1, "notes": 1, "history": len(kept["history"])}
    assert desk.see("admin", kept) == kept


# --- the dashboard numbers -------------------------------------------------------------

EMPTY = {
    "total": 0,
    "by_status": {"OPEN": 0, "IN_PROGRESS": 0, "BLOCKED": 0, "RESOLVED": 0, "CLOSED": 0},
    "by_priority": {"LOW": 0, "MEDIUM": 0, "HIGH": 0, "CRITICAL": 0},
    "unassigned_open": 0,
    "escalated_open": 0,
    "by_assignee": [],
    "by_category": [],
    "by_location": {"buildings": [], "floors": [], "seats": []},
    "needs_attention": [],
    "kept_informed": None,
    "average_hours": {"to_acknowledge": None, "to_assign": None, "to_resolve": None},
}
NOBODY_WAITING = {"open": 0, "quiet": 0, "awaiting_confirmation": 0, "closed": 0, "confirmed_by_reporter": 0, "quietest": []}


def load(desk, who, tickets):
    """An engineer's row in the admin's summary."""
    engineer = desk.cast[who]
    return {
        "assignee_id": engineer["profile"],
        "assignee": engineer["name"],
        "is_available": True,
        "max_open_tickets": 5,
        "open": tickets,
    }


def test_the_summary_of_nothing_is_all_zeros(desk):
    assert desk.call("reporter", "GET", "/api/incidents/summary") == (200, EMPTY)
    engineers = [load(desk, "engineer", 0), load(desk, "other_engineer", 0)]
    assert desk.call("admin", "GET", "/summary") == (
        200,
        {**EMPTY, "by_assignee": engineers, "kept_informed": NOBODY_WAITING},
    )


@pytest.fixture
def busy(desk):
    """Six incidents covering every status, with known times so the averages can be checked.
    Hours from being reported:                                  acknowledged, assigned, resolved"""
    plan = {
        "Tap": None,  # open, nobody assigned, never acknowledged
        "Router": (1, 2, None),  # in progress with Eve
        "Lights": (2, 2, 10),  # resolved by Eve
        "Projector": (3, 4, 4.5),  # resolved by Eve, then closed
        "Door": (0.25, 0.25, None),  # blocked with Omar, escalated
        "Blind": (4, None, None),  # closed by the admin without assigning anyone, escalated
    }
    desk.report(title="Tap", priority="LOW")
    desk.at("IN_PROGRESS", title="Router", priority="HIGH")
    desk.at("RESOLVED", title="Lights", priority="CRITICAL")
    desk.at("CLOSED", "other_employee", title="Projector")
    door = desk.assign(desk.report("other_employee", title="Door"), "other_engineer")
    desk.move("admin", door, "IN_PROGRESS")
    desk.move("admin", door, "BLOCKED", "Waiting for a key")
    desk.move("admin", desk.report("other_employee", title="Blind"), "CLOSED")
    db.query(
        "UPDATE incidents SET is_escalated = TRUE, escalation_reason = 'Urgent', escalated_by = %s, escalated_at = now() "
        "WHERE title IN ('Door', 'Blind')",
        (desk.cast["admin"]["id"],),
        fetch=False,
    )
    for title, hours in plan.items():
        acknowledged, assigned, resolved = hours or (None, None, None)
        db.query(
            "UPDATE incidents SET acknowledged_at = created_at + %s * interval '1 hour', "
            "assigned_at = created_at + %s * interval '1 hour', resolved_at = created_at + %s * interval '1 hour' WHERE title = %s",
            (acknowledged, assigned, resolved, title),
            fetch=False,
        )


def test_the_admin_summary_counts_everything_and_shows_each_engineers_load(desk, busy):
    status, body = desk.call("admin", "GET", "/summary")
    # Door is blocked and escalated; Blind is escalated too, but closed, so it needs nobody's attention
    # Three still need work, none of them quiet; Lights waits for its reporter; both closed ones were closed by staff
    assert body.pop("kept_informed") == {
        "open": 3, "quiet": 0, "awaiting_confirmation": 1, "closed": 2, "confirmed_by_reporter": 0, "quietest": [],
    }  # fmt: skip
    assert [{key: value for key, value in row.items() if key != "id"} for row in body.pop("needs_attention")] == [
        {
            "title": "Door",
            "status": "BLOCKED",
            "priority": "MEDIUM",
            "is_escalated": True,
            "blocked_reason": "Waiting for a key",
            "escalation_reason": "Urgent",
            "assignee": desk.cast["other_engineer"]["name"],
        }
    ]
    assert (status, body) == (
        200,
        {
            "total": 6,
            "by_status": {"OPEN": 1, "IN_PROGRESS": 1, "BLOCKED": 1, "RESOLVED": 1, "CLOSED": 2},
            "by_priority": {"LOW": 1, "MEDIUM": 3, "HIGH": 1, "CRITICAL": 1},
            "unassigned_open": 1,  # Tap; Blind is unassigned too, but closed
            "escalated_open": 1,  # Door; Blind is escalated too, but closed
            "by_assignee": [load(desk, "engineer", 1), load(desk, "other_engineer", 1)],  # Router; Door
            "by_category": [{"category_id": desk.site["category"], "category": "Plumbing", "type": "FACILITY", "count": 6}],
            "by_location": {
                "buildings": [{"building_id": desk.site["building"], "building": "Headquarters", "count": 6}],
                "floors": [],  # nobody named a floor or a seat
                "seats": [],
            },
            # (1 + 2 + 3 + 0.25 + 4) / 5 = 2.05, (2 + 2 + 4 + 0.25) / 4 = 2.0625, (10 + 4.5) / 2 = 7.25
            "average_hours": {"to_acknowledge": 2.1, "to_assign": 2.1, "to_resolve": 7.3},
        },
    )


def test_everyone_else_gets_the_summary_of_their_own_incidents(desk, busy):
    assert desk.call("reporter", "GET", "/summary")[1] == {  # Tap, Router, Lights
        "total": 3,
        "by_status": {"OPEN": 1, "IN_PROGRESS": 1, "BLOCKED": 0, "RESOLVED": 1, "CLOSED": 0},
        "by_priority": {"LOW": 1, "MEDIUM": 0, "HIGH": 1, "CRITICAL": 1},
        "unassigned_open": 1,
        "escalated_open": 0,
        "by_assignee": [],
        "by_category": [],  # the site-wide rankings are for admins
        "by_location": {"buildings": [], "floors": [], "seats": []},
        "needs_attention": [],
        "kept_informed": None,
        "average_hours": {"to_acknowledge": 1.5, "to_assign": 2.0, "to_resolve": 10.0},
    }
    mine = desk.call("engineer", "GET", "/summary")[1]  # Router, Lights, Projector
    assert (mine["total"], mine["by_status"]["CLOSED"], mine["unassigned_open"], mine["by_assignee"]) == (3, 1, 0, [])
    assert mine["average_hours"] == {"to_acknowledge": 2.0, "to_assign": 2.7, "to_resolve": 7.3}
    theirs = desk.call("other_employee", "GET", "/summary")[1]  # Projector, Door, Blind
    assert (theirs["total"], theirs["escalated_open"], theirs["by_status"]["BLOCKED"]) == (3, 1, 1)


def test_the_admin_sees_which_categories_and_places_have_the_most_incidents(desk):
    site = desk.site
    hq_seat = {"floor_id": site["floor"], "seat_id": site["seat"]}
    annex_seat = {"building_id": site["annex"], "floor_id": site["annex_floor"], "seat_id": site["annex_seat"]}
    for where in (hq_seat, hq_seat, hq_seat, {"floor_id": site["floor"]}, {}):  # five at Headquarters
        desk.report(**where)
    desk.report(**annex_seat, category_id=site["network"])  # and three at the Annex
    desk.report("other_employee", **annex_seat, category_id=site["network"])
    desk.report(building_id=site["annex"])

    status, body = desk.call("admin", "GET", "/summary")
    assert status == 200
    assert body["by_category"] == [
        {"category_id": site["category"], "category": "Plumbing", "type": "FACILITY", "count": 6},
        {"category_id": site["network"], "category": "Network", "type": "TECHNOLOGY", "count": 2},
    ]
    assert body["by_location"] == {
        "buildings": [
            {"building_id": site["building"], "building": "Headquarters", "count": 5},
            {"building_id": site["annex"], "building": "Annex", "count": 3},
        ],
        "floors": [  # only incidents that named a floor
            {"building": "Headquarters", "floor_level": 2, "count": 4},
            {"building": "Annex", "floor_level": 0, "count": 2},
        ],
        "seats": [  # only incidents that named a seat
            {"building": "Headquarters", "floor_level": 2, "seat": "2F-A14", "count": 3},
            {"building": "Annex", "floor_level": 0, "seat": "GF-R01", "count": 2},
        ],
    }
    # Whoever else asks sees no site-wide ranking, even of their own incidents
    for who in ("reporter", "engineer"):
        mine = desk.call(who, "GET", "/summary")[1]
        assert (mine["by_category"], mine["by_location"]) == ([], {"buildings": [], "floors": [], "seats": []})


def test_the_rankings_show_the_five_worst_places_and_break_ties_by_name(desk):
    for name in ("Zeta", "Beta", "Alpha", "Gamma", "Delta"):
        building = db.query("INSERT INTO buildings (name, address) VALUES (%s, 'x') RETURNING id", (name,))["id"]
        desk.report(building_id=str(building))
    desk.report()
    desk.report()  # Headquarters has two; the five others one each
    buildings = desk.call("admin", "GET", "/summary")[1]["by_location"]["buildings"]
    assert [(b["building"], b["count"]) for b in buildings] == [
        ("Headquarters", 2), ("Alpha", 1), ("Beta", 1), ("Delta", 1), ("Gamma", 1),
    ]


# --- escalating ------------------------------------------------------------------------


@pytest.mark.parametrize("who", ["reporter", "engineer", "admin"])
def test_anyone_who_can_see_an_open_incident_can_escalate_it_saying_why(desk, who):
    incident = desk.assign(desk.report())
    status, body = desk.call(who, "POST", f"/api/incidents/tickets/{incident['id']}/escalate", body={"reason": "  Third time this week "})
    escalated = body["incident"]
    assert status == 200
    assert (escalated["is_escalated"], escalated["escalation_reason"], escalated["escalated_by"]) == (
        True,
        "Third time this week",
        desk.cast[who]["name"],
    )
    assert escalated["escalated_at"] == escalated["updated_at"] > incident["updated_at"]
    assert (incident["can_escalate"], escalated["can_escalate"]) == (True, False)
    assert (escalated["status"], escalated["history"]) == (incident["status"], incident["history"])  # not a workflow move
    # ...and the list says why, without opening the incident
    listed = desk.call("admin", "GET", "/tickets")[1]["incidents"][0]
    assert (listed["is_escalated"], listed["escalation_reason"]) == (True, "Third time this week")


@pytest.mark.parametrize(
    "reason, message",
    [(None, "Say why it needs escalating"), ("   ", "Say why it needs escalating"), ("r" * 501, "Reason must be at most 500 characters")],
)
def test_escalating_needs_a_reason(desk, reason, message):
    incident = desk.report()
    status, body = desk.call("reporter", "POST", f"/tickets/{incident['id']}/escalate", body={"reason": reason})
    assert (status, body["error"]["details"]) == (400, {"reason": message})
    assert desk.see("reporter", incident) == incident


def test_an_incident_is_escalated_once_and_only_while_it_still_needs_work(desk):
    incident = desk.report()
    first = desk.call("reporter", "POST", f"/tickets/{incident['id']}/escalate", body={"reason": "First"})[1]["incident"]
    status, body = desk.call("admin", "POST", f"/tickets/{incident['id']}/escalate", body={"reason": "Second"})
    assert (status, body["error"]["message"]) == (409, "This incident is already escalated")
    assert desk.see("admin", incident)["escalation_reason"] == first["escalation_reason"] == "First"

    for status_name in ("RESOLVED", "CLOSED"):
        done = desk.at(status_name)
        status, body = desk.call("reporter", "POST", f"/tickets/{done['id']}/escalate", body={"reason": "Too late"})
        assert (status, body["error"]["message"]) == (409, "A resolved or closed incident cannot be escalated")
        after = desk.see("admin", done)
        assert (after["is_escalated"], after["can_escalate"]) == (False, False)


def test_an_incident_someone_may_not_see_cannot_be_escalated_by_them(desk):
    incident = desk.report()
    status, body = desk.call("other_employee", "POST", f"/tickets/{incident['id']}/escalate", body={"reason": "Mine too"})
    assert (status, body["error"]["message"]) == (404, "Incident not found")
    assert desk.see("admin", incident)["is_escalated"] is False


def test_the_list_can_be_narrowed_to_escalated_incidents(desk):
    desk.report(title="Quiet")
    loud = desk.report(title="Loud")
    desk.call("reporter", "POST", f"/tickets/{loud['id']}/escalate", body={"reason": "Flooding"})
    assert desk.titles("admin", escalated="true") == ["Loud"]
    assert desk.titles("admin", escalated="") == ["Loud", "Quiet"]  # blank means not asked for
    status, body = desk.call("admin", "GET", "/tickets", query={"escalated": "yes"})
    assert (status, body["error"]["details"]) == (400, {"escalated": "Escalated must be one of: true"})


def test_the_admin_summary_lists_at_most_ten_needing_attention_longest_waiting_first(desk):
    for number in range(12):
        incident = desk.report(title=f"Flood {number:02}")
        desk.call("reporter", "POST", f"/tickets/{incident['id']}/escalate", body={"reason": "Wet"})
        db.query("UPDATE incidents SET updated_at = now() - %s * interval '1 hour' WHERE id = %s", (number, incident["id"]), fetch=False)
    waiting = desk.call("admin", "GET", "/summary")[1]["needs_attention"]
    assert [row["title"] for row in waiting] == [f"Flood {number:02}" for number in range(11, 1, -1)]


# --- keeping reporters informed --------------------------------------------------------


def test_the_admin_sees_how_well_reporters_are_kept_informed(desk):
    def days_ago(table, column, days, where, *params):
        db.query(f"UPDATE {table} SET {column} = now() - %s * interval '1 day' WHERE {where}", (days, *params), fetch=False)

    def reported(title, days, status=None):
        incident = desk.at(status, title=title) if status else desk.report(title=title)
        days_ago("incidents", "created_at", days, "id = %s", incident["id"])
        days_ago("incident_status_history", "changed_at", days, "incident_id = %s", incident["id"])
        return incident

    reported("Never answered", 5)  # open, and nobody has said or done anything
    answered = reported("Answered yesterday", 10)
    desk.note("admin", answered, body="Parts ordered")
    days_ago("incident_notes", "created_at", 1, "incident_id = %s", answered["id"])
    stale = reported("Went quiet", 10, "IN_PROGRESS")  # the admin's moves, ten days ago...
    days_ago("incident_status_history", "changed_at", 6, "incident_id = %s AND to_status = 'IN_PROGRESS'", stale["id"])
    desk.note("admin", stale, body="Internal chatter", is_internal=True)  # ...which the reporter cannot see
    desk.note("reporter", stale, body="Any news?")  # ...and their own question is not news to them
    desk.report(title="Reported today")
    reported("Waiting for the reporter", 2, "RESOLVED")
    desk.move("reporter", reported("Confirmed fixed", 3, "RESOLVED"), "CLOSED")
    reported("Closed by staff", 3, "CLOSED")

    informed = desk.call("admin", "GET", "/summary")[1]["kept_informed"]
    quietest = informed.pop("quietest")
    assert informed == {"open": 4, "quiet": 2, "awaiting_confirmation": 1, "closed": 2, "confirmed_by_reporter": 1}
    assert [(row["title"], row["status"], row["assignee"]) for row in quietest] == [
        ("Went quiet", "IN_PROGRESS", desk.cast["engineer"]["name"]),  # last heard six days ago
        ("Never answered", "OPEN", None),  # reported five days ago, heard nothing
    ]
    assert quietest[0]["last_heard"][10] == "T" and quietest[1]["last_heard"] is None
    assert set(quietest[0]) == {"id", "title", "status", "last_heard", "assignee"}
    for who in ("reporter", "engineer"):
        assert desk.call(who, "GET", "/summary")[1]["kept_informed"] is None


def test_only_the_five_longest_silences_are_listed(desk):
    for number in range(7):
        incident = desk.report(title=f"Silent {number}")
        db.query("UPDATE incidents SET created_at = now() - %s * interval '1 day' WHERE id = %s", (4 + number, incident["id"]), fetch=False)
    informed = desk.call("admin", "GET", "/summary")[1]["kept_informed"]
    assert (informed["open"], informed["quiet"]) == (7, 7)
    assert [row["title"] for row in informed["quietest"]] == [f"Silent {number}" for number in (6, 5, 4, 3, 2)]


# --- found by review -------------------------------------------------------------------


def test_a_resolved_incident_keeps_its_engineer_until_it_is_reopened_or_closed(desk):
    resolved = desk.at("RESOLVED")  # feedback goes to the assignee, so it must stay who did the work
    for engineer in ("other_engineer", None):
        body = {"priority": "LOW", "assignee_id": engineer and desk.cast[engineer]["profile"]}
        status, answer = desk.call("admin", "PATCH", f"/tickets/{resolved['id']}", body=body)
        assert (status, answer["error"]["message"]) == (409, "Reopen a resolved incident before changing who works on it")
    assert desk.see("admin", resolved) == resolved
    assert desk.assign(resolved, priority="LOW")["priority"] == "LOW"  # the priority alone can still change


def test_setting_only_the_priority_also_counts_as_acknowledging(desk):
    triaged = desk.assign(desk.report(), None, priority="CRITICAL")
    assert (triaged["acknowledged_at"], triaged["assigned_at"]) == (triaged["updated_at"], None)


def test_leaving_the_assignee_out_is_refused_instead_of_unassigning(desk):
    incident = desk.assign(desk.report())
    status, body = desk.call("admin", "PATCH", f"/tickets/{incident['id']}", body={"priority": "LOW"})
    assert (status, body["error"]["details"]) == (400, {"assignee_id": "Send the assignee, or null for nobody"})
    assert desk.see("admin", incident) == incident


@pytest.mark.parametrize(
    "method, tail, body",
    [("PATCH", "", {"priority": "LOW", "assignee_id": None}), ("POST", "/notes", {"body": "One more thing"})],
)
def test_an_incident_closed_a_moment_ago_takes_no_change_and_no_note(desk, incidents, monkeypatch, method, tail, body):
    incident = desk.at("RESOLVED")
    real = incidents.find

    def read_then_see_it_closed(user, incident_id):
        found = real(user, incident_id)
        db.query("UPDATE incidents SET status = 'CLOSED' WHERE id = %s", (incident_id,), fetch=False)
        return found

    monkeypatch.setattr(incidents, "find", read_then_see_it_closed)
    status, answer = desk.call("admin", method, f"/tickets/{incident['id']}{tail}", body=body)
    assert (status, answer["error"]["code"]) == (409, "conflict")
    after = row(incident)
    assert (after["priority"], str(after["assignee_id"]), saved()["notes"]) == ("MEDIUM", incident["assignee_id"], 0)

