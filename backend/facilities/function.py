"""
Facilities service: the buildings, floors and seats an incident can be reported against.

Reached as /api/facilities/* (the local proxy and CloudFront both route here).

    GET    /                                 service health
    GET    /buildings                        every building with its floors and seats
    POST   /buildings                        add a building                       (admin)
    PATCH  /buildings/{building_id}          change a building's name or address  (admin)
    DELETE /buildings/{building_id}          remove a building, floors and seats  (admin)
    POST   /buildings/{building_id}/floors   add a floor                          (admin)
    PATCH  /floors/{floor_id}                change a floor's number              (admin)
    DELETE /floors/{floor_id}                remove a floor and its seats         (admin)
    POST   /floors/{floor_id}/seats          add a seat                           (admin)
    PATCH  /seats/{seat_id}                  change a seat's code                 (admin)
    DELETE /seats/{seat_id}                  remove a seat                        (admin)

Anything an incident points at cannot be removed: the answer is 409 and nothing changes.
"""

import logging

import psycopg

from db import query, query_all, transaction
from http_utils import ApiError, clean_int, clean_text, dispatch, json_body, respond, validate
from security import protected

logger = logging.getLogger()
logger.setLevel(logging.INFO)

BUILDING_RULES = {"name": clean_text("Name", 100), "address": clean_text("Address", 200)}
NAME_TAKEN = "A building with this name already exists"
FLOOR_TAKEN = "This building already has that floor"
SEAT_TAKEN = "This floor already has a seat with that code"


def not_found(what):
    return ApiError(404, "not_found", f"{what} not found")


def health(_event):
    return respond(200, {"service": "facilities", "status": "ok"})


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


@protected()
def list_buildings(_event, _user):
    """The whole tree in one response. It is small, and both the admin screen and the
    incident form need all of it."""
    buildings = query_all("SELECT id, name, address FROM buildings ORDER BY name")
    floors = query_all("SELECT id, building_id, level FROM floors ORDER BY level")
    seats = query_all("SELECT id, floor_id, code FROM seats ORDER BY code")
    for floor in floors:
        floor["seats"] = [{"id": seat["id"], "code": seat["code"]} for seat in seats if seat["floor_id"] == floor["id"]]
    for building in buildings:
        building["floors"] = [
            {"id": floor["id"], "level": floor["level"], "seats": floor["seats"]}
            for floor in floors
            if floor["building_id"] == building["id"]
        ]
    return respond(200, {"buildings": buildings})


# ---------------------------------------------------------------------------
# Adding and changing
# ---------------------------------------------------------------------------


@protected("ADMIN")
def create_building(event, _user):
    fields = validate(json_body(event), BUILDING_RULES)
    building = query(
        "INSERT INTO buildings (name, address) VALUES (%s, %s) "
        "ON CONFLICT (name) DO NOTHING RETURNING id, name, address",
        (fields["name"], fields["address"]),
    )
    if not building:
        raise ApiError(409, "conflict", NAME_TAKEN, {"name": NAME_TAKEN})
    return respond(201, {"building": {**building, "floors": []}})


@protected("ADMIN")
def update_building(event, _user, building_id):
    fields = validate(json_body(event), BUILDING_RULES)
    building = change(
        "Building",
        "UPDATE buildings SET name = %s, address = %s, updated_at = now() WHERE id = %s RETURNING id, name, address",
        (fields["name"], fields["address"], building_id),
        "name",
        NAME_TAKEN,
    )
    return respond(200, {"building": building})


@protected("ADMIN")
def update_floor(event, _user, floor_id):
    fields = validate(json_body(event), {"level": clean_int("Level", -5, 200)})
    floor = change(
        "Floor",
        "UPDATE floors SET level = %s WHERE id = %s RETURNING id, building_id, level",
        (fields["level"], floor_id),
        "level",
        FLOOR_TAKEN,
    )
    return respond(200, {"floor": floor})


@protected("ADMIN")
def update_seat(event, _user, seat_id):
    fields = validate(json_body(event), {"code": clean_text("Seat code", 20)})
    seat = change(
        "Seat",
        "UPDATE seats SET code = %s WHERE id = %s RETURNING id, floor_id, code",
        (fields["code"], seat_id),
        "code",
        SEAT_TAKEN,
    )
    return respond(200, {"seat": seat})


def change(what, sql, params, field, taken):
    """Update a building, floor or seat. The database's unique rules decide whether the new
    name, number or code clashes with a neighbour."""
    try:
        row = query(sql, params)
    except psycopg.errors.UniqueViolation:
        raise ApiError(409, "conflict", taken, {field: taken}) from None
    if not row:
        raise not_found(what)
    return row


def add_inside(parent, sql, params, field, taken):
    """Insert a floor or a seat. The database decides both questions: a parent that does
    not exist breaks the foreign key, and a duplicate is skipped by ON CONFLICT."""
    try:
        row = query(sql, params)
    except psycopg.errors.ForeignKeyViolation:
        raise not_found(parent) from None
    if not row:
        raise ApiError(409, "conflict", taken, {field: taken})
    return row


@protected("ADMIN")
def create_floor(event, _user, building_id):
    fields = validate(json_body(event), {"level": clean_int("Level", -5, 200)})
    floor = add_inside(
        "Building",
        "INSERT INTO floors (building_id, level) VALUES (%s, %s) "
        "ON CONFLICT (building_id, level) DO NOTHING RETURNING id, building_id, level",
        (building_id, fields["level"]),
        "level",
        FLOOR_TAKEN,
    )
    return respond(201, {"floor": floor})


@protected("ADMIN")
def create_seat(event, _user, floor_id):
    fields = validate(json_body(event), {"code": clean_text("Seat code", 20)})
    seat = add_inside(
        "Floor",
        "INSERT INTO seats (floor_id, code) VALUES (%s, %s) "
        "ON CONFLICT (floor_id, code) DO NOTHING RETURNING id, floor_id, code",
        (floor_id, fields["code"]),
        "code",
        SEAT_TAKEN,
    )
    return respond(201, {"seat": seat})


# ---------------------------------------------------------------------------
# Removing
# ---------------------------------------------------------------------------


def remove(what, row_id, *deletes):
    """Run the DELETEs as one unit; the last one removes the row itself.

    Incidents keep foreign keys to their building, floor and seat, so the database
    refuses any of these DELETEs while an incident points at the row, and the whole
    unit is undone.
    """
    try:
        with transaction():
            for sql in deletes:
                removed = query(sql + " RETURNING id", (row_id,))
    except psycopg.errors.ForeignKeyViolation:
        message = f"This {what.lower()} is used by incidents and cannot be removed"
        raise ApiError(409, "conflict", message) from None
    if not removed:
        raise not_found(what)
    return respond(204)


@protected("ADMIN")
def delete_building(_event, _user, building_id):
    return remove(
        "Building",
        building_id,
        "DELETE FROM seats WHERE floor_id IN (SELECT id FROM floors WHERE building_id = %s)",
        "DELETE FROM floors WHERE building_id = %s",
        "DELETE FROM buildings WHERE id = %s",
    )


@protected("ADMIN")
def delete_floor(_event, _user, floor_id):
    return remove("Floor", floor_id, "DELETE FROM seats WHERE floor_id = %s", "DELETE FROM floors WHERE id = %s")


@protected("ADMIN")
def delete_seat(_event, _user, seat_id):
    return remove("Seat", seat_id, "DELETE FROM seats WHERE id = %s")


ROUTES = {
    ("GET", "/"): health,
    ("GET", "/buildings"): list_buildings,
    ("POST", "/buildings"): create_building,
    ("PATCH", "/buildings/{building_id}"): update_building,
    ("DELETE", "/buildings/{building_id}"): delete_building,
    ("POST", "/buildings/{building_id}/floors"): create_floor,
    ("PATCH", "/floors/{floor_id}"): update_floor,
    ("DELETE", "/floors/{floor_id}"): delete_floor,
    ("POST", "/floors/{floor_id}/seats"): create_seat,
    ("PATCH", "/seats/{seat_id}"): update_seat,
    ("DELETE", "/seats/{seat_id}"): delete_seat,
}


def handler(event=None, context=None):
    """Lambda entry point."""
    return dispatch(event, "facilities", ROUTES)
