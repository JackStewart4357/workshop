"""Integration tests for the facilities service: every endpoint, through the Lambda
handler, against a real database."""

import pytest

import db
from conftest import invoke, load_service, sign_in_as

MISSING = "00000000-0000-4000-8000-000000000000"  # a well-formed id that no row has


@pytest.fixture(scope="session")
def facilities():
    return load_service("facilities")


@pytest.fixture
def admin():
    return sign_in_as("ADMIN")


@pytest.fixture
def site(facilities, admin):
    """Headquarters with a ground floor and one seat on it: the ids of all three."""
    building = invoke(facilities, "POST", "/buildings", token=admin, body={"name": "Headquarters", "address": "1 Acme Plaza"})
    floor = invoke(facilities, "POST", f"/buildings/{building[1]['building']['id']}/floors", token=admin, body={"level": 0})
    seat = invoke(facilities, "POST", f"/floors/{floor[1]['floor']['id']}/seats", token=admin, body={"code": "GF-A01"})
    assert (building[0], floor[0], seat[0]) == (201, 201, 201)
    return {"building": building[1]["building"]["id"], "floor": floor[1]["floor"]["id"], "seat": seat[1]["seat"]["id"]}


def report_incident(building, floor=None, seat=None):
    """An incident at this location, as the incidents service will create them."""
    db.query(
        "INSERT INTO incidents (title, description, category_id, building_id, floor_id, seat_id, reporter_id) "
        "VALUES ('Broken light', 'Flickers', (SELECT id FROM categories LIMIT 1), %s, %s, %s, (SELECT id FROM users LIMIT 1))",
        (building, floor, seat),
        fetch=False,
    )


def counts():
    return db.query(
        "SELECT (SELECT count(*) FROM buildings) AS buildings, (SELECT count(*) FROM floors) AS floors, "
        "(SELECT count(*) FROM seats) AS seats"
    )


# --- health, sign-in and roles ---------------------------------------------------------


@pytest.mark.parametrize("path", ["/", "/api/facilities", "/facilities/"])
def test_health_needs_no_sign_in(facilities, path):
    assert invoke(facilities, "GET", path) == (200, {"service": "facilities", "status": "ok"})


WRITES = [
    ("POST", "/buildings"),
    ("PATCH", f"/buildings/{MISSING}"),
    ("DELETE", f"/buildings/{MISSING}"),
    ("POST", f"/buildings/{MISSING}/floors"),
    ("DELETE", f"/floors/{MISSING}"),
    ("POST", f"/floors/{MISSING}/seats"),
    ("DELETE", f"/seats/{MISSING}"),
]


@pytest.mark.parametrize("method, path", [("GET", "/buildings"), *WRITES])
def test_every_endpoint_needs_a_signed_in_user(facilities, method, path):
    status, body = invoke(facilities, method, path, body={})
    assert (status, body["error"]["code"]) == (401, "unauthorized")


@pytest.mark.parametrize("role", ["EMPLOYEE", "ENGINEER"])
@pytest.mark.parametrize("method, path", WRITES)
def test_only_admins_can_change_anything(facilities, role, method, path):
    # The body is deliberately invalid: the role is checked before anything is read from it
    status, body = invoke(facilities, method, path, token=sign_in_as(role), body={})
    assert (status, body["error"]["code"]) == (403, "access_denied")


@pytest.mark.parametrize("role", ["EMPLOYEE", "ENGINEER", "ADMIN"])
def test_every_role_can_read_the_buildings(facilities, role):
    assert invoke(facilities, "GET", "/buildings", token=sign_in_as(role)) == (200, {"buildings": []})


def test_an_id_that_is_not_a_uuid_is_an_unknown_path(facilities, admin):
    status, body = invoke(facilities, "DELETE", "/buildings/42", token=admin)
    assert (status, body["error"]["code"]) == (404, "not_found")


# --- reading ---------------------------------------------------------------------------


def test_buildings_come_back_as_a_sorted_tree(facilities, admin):
    def add(path, **body):
        status, created = invoke(facilities, "POST", path, token=admin, body=body)
        assert status == 201
        return next(iter(created.values()))["id"]

    riverside = add("/buildings", name="Riverside Annex", address="25 Wharf Road")
    hq = add("/buildings", name="Headquarters", address="30 Acme Plaza")
    first = add(f"/buildings/{hq}/floors", level=1)
    basement = add(f"/buildings/{hq}/floors", level=-1)
    b2 = add(f"/floors/{first}/seats", code="1F-B02")
    a1 = add(f"/floors/{first}/seats", code="1F-A01")

    status, body = invoke(facilities, "GET", "/api/facilities/buildings", token=admin)
    assert status == 200
    assert body == {
        "buildings": [
            {
                "id": hq,
                "name": "Headquarters",
                "address": "30 Acme Plaza",
                "floors": [
                    {"id": basement, "level": -1, "seats": []},
                    {"id": first, "level": 1, "seats": [{"id": a1, "code": "1F-A01"}, {"id": b2, "code": "1F-B02"}]},
                ],
            },
            {"id": riverside, "name": "Riverside Annex", "address": "25 Wharf Road", "floors": []},
        ]
    }


# --- buildings -------------------------------------------------------------------------


def test_admin_adds_a_building(facilities, admin):
    status, body = invoke(facilities, "POST", "/buildings", token=admin, body={"name": "  HQ ", "address": " 1 Acme Plaza "})
    assert status == 201
    assert body["building"] == {"id": body["building"]["id"], "name": "HQ", "address": "1 Acme Plaza", "floors": []}
    assert counts()["buildings"] == 1


@pytest.mark.parametrize(
    "body, field",
    [({"address": "x"}, "name"), ({"name": "x"}, "address"), ({"name": "n" * 101, "address": "x"}, "name"),
     ({"name": "x", "address": "a" * 201}, "address"), ({"name": 7, "address": "x"}, "name")],
)
def test_building_fields_are_validated(facilities, admin, site, body, field):
    for method, path in (("POST", "/buildings"), ("PATCH", f"/buildings/{site['building']}")):
        status, answer = invoke(facilities, method, path, token=admin, body=body)
        assert (status, answer["error"]["code"]) == (400, "validation_error")
        assert list(answer["error"]["details"]) == [field]
    assert counts()["buildings"] == 1


def test_two_buildings_cannot_share_a_name(facilities, admin, site):
    status, body = invoke(facilities, "POST", "/buildings", token=admin, body={"name": "Headquarters", "address": "Elsewhere"})
    assert (status, body["error"]["code"]) == (409, "conflict")
    assert body["error"]["details"] == {"name": "A building with this name already exists"}
    assert counts()["buildings"] == 1


def test_admin_changes_a_building(facilities, admin, site):
    status, body = invoke(
        facilities, "PATCH", f"/buildings/{site['building']}", token=admin, body={"name": "HQ", "address": "2 Acme Plaza"}
    )
    assert (status, body) == (200, {"building": {"id": site["building"], "name": "HQ", "address": "2 Acme Plaza"}})
    row = db.query("SELECT name, address, updated_at > created_at AS touched FROM buildings")
    assert row == {"name": "HQ", "address": "2 Acme Plaza", "touched": True}


def test_a_building_can_keep_its_own_name_when_changed(facilities, admin, site):
    invoke(facilities, "POST", "/buildings", token=admin, body={"name": "Annex", "address": "x"})
    status, _ = invoke(
        facilities, "PATCH", f"/buildings/{site['building']}", token=admin, body={"name": "Headquarters", "address": "New"}
    )
    assert status == 200


def test_a_building_cannot_take_another_buildings_name(facilities, admin, site):
    invoke(facilities, "POST", "/buildings", token=admin, body={"name": "Annex", "address": "x"})
    status, body = invoke(
        facilities, "PATCH", f"/buildings/{site['building']}", token=admin, body={"name": "Annex", "address": "x"}
    )
    assert (status, body["error"]["code"], body["error"]["details"]) == (409, "conflict", {"name": "A building with this name already exists"})
    assert db.query("SELECT count(*) AS n FROM buildings WHERE name = 'Headquarters'")["n"] == 1
    assert invoke(facilities, "GET", "/buildings", token=admin)[0] == 200  # the connection is still usable


def test_changing_a_building_that_does_not_exist_is_404(facilities, admin):
    status, body = invoke(facilities, "PATCH", f"/buildings/{MISSING}", token=admin, body={"name": "x", "address": "y"})
    assert (status, body["error"]) == (404, {"code": "not_found", "message": "Building not found"})


# --- floors and seats ------------------------------------------------------------------


def test_admin_adds_floors_including_basements(facilities, admin, site):
    for level in (-2, 1, 200):
        status, body = invoke(facilities, "POST", f"/buildings/{site['building']}/floors", token=admin, body={"level": level})
        assert status == 201
        assert body["floor"] == {"id": body["floor"]["id"], "building_id": site["building"], "level": level}
    assert counts()["floors"] == 4


@pytest.mark.parametrize("level", [None, "1", 1.5, True, -6, 201])
def test_floor_level_must_be_a_whole_number_in_range(facilities, admin, site, level):
    status, body = invoke(facilities, "POST", f"/buildings/{site['building']}/floors", token=admin, body={"level": level})
    assert (status, body["error"]["details"]) == (400, {"level": "Level must be a whole number from -5 to 200"})


def test_a_building_has_each_floor_only_once(facilities, admin, site):
    status, body = invoke(facilities, "POST", f"/buildings/{site['building']}/floors", token=admin, body={"level": 0})
    assert (status, body["error"]["code"], body["error"]["details"]) == (409, "conflict", {"level": "This building already has that floor"})
    assert counts()["floors"] == 1


def test_two_buildings_can_have_the_same_floor_level(facilities, admin, site):
    _, annex = invoke(facilities, "POST", "/buildings", token=admin, body={"name": "Annex", "address": "x"})
    status, _ = invoke(facilities, "POST", f"/buildings/{annex['building']['id']}/floors", token=admin, body={"level": 0})
    assert status == 201


def test_admin_adds_a_seat(facilities, admin, site):
    status, body = invoke(facilities, "POST", f"/floors/{site['floor']}/seats", token=admin, body={"code": " GF-A02 "})
    assert status == 201
    assert body["seat"] == {"id": body["seat"]["id"], "floor_id": site["floor"], "code": "GF-A02"}


@pytest.mark.parametrize("code", [None, "", "   ", "x" * 21, 14])
def test_seat_code_is_validated(facilities, admin, site, code):
    status, body = invoke(facilities, "POST", f"/floors/{site['floor']}/seats", token=admin, body={"code": code})
    assert (status, list(body["error"]["details"])) == (400, ["code"])


def test_a_floor_has_each_seat_code_only_once(facilities, admin, site):
    status, body = invoke(facilities, "POST", f"/floors/{site['floor']}/seats", token=admin, body={"code": "GF-A01"})
    assert (status, body["error"]["code"], body["error"]["details"]) == (409, "conflict", {"code": "This floor already has a seat with that code"})
    assert counts()["seats"] == 1


@pytest.mark.parametrize("path, body, what", [("/buildings/{}/floors", {"level": 3}, "Building"), ("/floors/{}/seats", {"code": "X1"}, "Floor")])
def test_adding_inside_something_that_does_not_exist_is_404(facilities, admin, path, body, what):
    status, answer = invoke(facilities, "POST", path.format(MISSING), token=admin, body=body)
    assert (status, answer["error"]) == (404, {"code": "not_found", "message": f"{what} not found"})
    assert invoke(facilities, "GET", "/buildings", token=admin)[0] == 200  # the connection is still usable


def test_the_longest_allowed_values_are_accepted(facilities, admin):
    status, body = invoke(facilities, "POST", "/buildings", token=admin, body={"name": "n" * 100, "address": "a" * 200})
    assert status == 201
    _, floor = invoke(facilities, "POST", f"/buildings/{body['building']['id']}/floors", token=admin, body={"level": -5})
    assert invoke(facilities, "POST", f"/floors/{floor['floor']['id']}/seats", token=admin, body={"code": "x" * 20})[0] == 201


# --- removing --------------------------------------------------------------------------


def test_removing_a_seat_leaves_the_rest(facilities, admin, site):
    invoke(facilities, "POST", f"/floors/{site['floor']}/seats", token=admin, body={"code": "GF-A02"})
    assert invoke(facilities, "DELETE", f"/seats/{site['seat']}", token=admin) == (204, None)
    assert counts() == {"buildings": 1, "floors": 1, "seats": 1}


def test_removing_a_floor_removes_its_seats_only(facilities, admin, site):
    _, upstairs = invoke(facilities, "POST", f"/buildings/{site['building']}/floors", token=admin, body={"level": 1})
    invoke(facilities, "POST", f"/floors/{upstairs['floor']['id']}/seats", token=admin, body={"code": "1F-A01"})
    assert invoke(facilities, "DELETE", f"/floors/{site['floor']}", token=admin) == (204, None)
    assert counts() == {"buildings": 1, "floors": 1, "seats": 1}


def test_removing_a_building_removes_its_floors_and_seats_only(facilities, admin, site):
    _, annex = invoke(facilities, "POST", "/buildings", token=admin, body={"name": "Annex", "address": "x"})
    _, floor = invoke(facilities, "POST", f"/buildings/{annex['building']['id']}/floors", token=admin, body={"level": 0})
    invoke(facilities, "POST", f"/floors/{floor['floor']['id']}/seats", token=admin, body={"code": "GF-A01"})

    assert invoke(facilities, "DELETE", f"/buildings/{site['building']}", token=admin) == (204, None)
    assert counts() == {"buildings": 1, "floors": 1, "seats": 1}
    assert db.query("SELECT name FROM buildings") == {"name": "Annex"}


@pytest.mark.parametrize("kind, what", [("buildings", "Building"), ("floors", "Floor"), ("seats", "Seat")])
def test_removing_something_that_does_not_exist_is_404(facilities, admin, site, kind, what):
    status, body = invoke(facilities, "DELETE", f"/{kind}/{MISSING}", token=admin)
    assert (status, body["error"]) == (404, {"code": "not_found", "message": f"{what} not found"})
    assert counts() == {"buildings": 1, "floors": 1, "seats": 1}


@pytest.mark.parametrize(
    "target, located_at",
    [
        ("seat", ("building", "floor", "seat")),
        ("floor", ("building", "floor", "seat")),  # the incident is at a seat on that floor
        ("floor", ("building", "floor")),
        ("building", ("building", "floor", "seat")),
        ("building", ("building", "floor")),
        ("building", ("building",)),
    ],
)
def test_nothing_an_incident_points_at_can_be_removed(facilities, admin, site, target, located_at):
    report_incident(*(site[part] for part in located_at))

    status, body = invoke(facilities, "DELETE", f"/{target}s/{site[target]}", token=admin)

    message = f"This {target} is used by incidents and cannot be removed"
    assert (status, body["error"]) == (409, {"code": "conflict", "message": message})
    assert counts() == {"buildings": 1, "floors": 1, "seats": 1}  # nothing half-removed
    assert db.query("SELECT count(*) AS n FROM incidents")["n"] == 1


def test_a_seat_no_incident_uses_can_go_even_when_its_building_is_in_use(facilities, admin, site):
    report_incident(site["building"])
    assert invoke(facilities, "DELETE", f"/seats/{site['seat']}", token=admin) == (204, None)
    assert invoke(facilities, "DELETE", f"/floors/{site['floor']}", token=admin) == (204, None)
