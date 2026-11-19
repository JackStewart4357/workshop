"""
Incidents service: the tickets themselves, their status workflow, notes and the dashboard numbers.

Reached as /api/incidents/* (the local proxy and CloudFront both route here).

    GET    /                                service health
    GET    /categories                      the categories an incident can have
    GET    /summary                         counts and averages for the dashboard
    GET    /tickets                         the incidents the caller may see, with filters
    POST   /tickets                         report an incident
    GET    /tickets/{incident_id}           one incident with its notes and history
    PATCH  /tickets/{incident_id}           set the priority and the assignee          (admin)
    DELETE /tickets/{incident_id}           remove an incident                         (admin)
    POST   /tickets/{incident_id}/status    move an incident along the workflow
    POST   /tickets/{incident_id}/notes     add a note

Who sees what: an admin sees every incident; anyone else sees the ones they reported and,
for an engineer, the ones assigned to them. An incident the caller may not see answers
404, exactly like one that does not exist. "Staff" on an incident means an admin or the
engineer it is assigned to.
"""

import logging
import re
import uuid

import psycopg

from db import query, query_all, transaction
from http_utils import (
    ApiError,
    clean_bool,
    clean_choice,
    clean_text,
    clean_uuid,
    dispatch,
    json_body,
    optional,
    query_params,
    respond,
    validate,
)
from security import protected

logger = logging.getLogger()
logger.setLevel(logging.INFO)

STATUSES = ("OPEN", "IN_PROGRESS", "BLOCKED", "RESOLVED", "CLOSED")
PRIORITIES = ("LOW", "MEDIUM", "HIGH", "CRITICAL")
# The workflow: from each status, where an incident may go next. Closed is final.
WORKFLOW = {
    "OPEN": ("IN_PROGRESS", "CLOSED"),
    "IN_PROGRESS": ("BLOCKED", "RESOLVED"),
    "BLOCKED": ("IN_PROGRESS",),
    "RESOLVED": ("CLOSED", "IN_PROGRESS"),  # the second one reopens it
    "CLOSED": (),
}
# "Open" for counting means still needing work, the same definition backend/engineers uses.
STILL_OPEN = "i.status NOT IN ('RESOLVED', 'CLOSED')"
ACKNOWLEDGE = ", acknowledged_at = coalesce(acknowledged_at, now())"  # the first staff action

# An incident as the list shows it; the detail adds MORE. "ae" is the assigned engineer's
# profile, which visible_to() and is_staff() rely on.
COLUMNS = (
    "i.id, i.title, i.status, i.priority, c.name AS category, b.name AS building, f.level AS floor_level, "
    "s.code AS seat, r.full_name AS reporter, au.full_name AS assignee, i.assignee_id, i.is_escalated, "
    "i.created_at, i.updated_at"
)
MORE = (
    ", i.description, i.blocked_reason, i.category_id, i.building_id, i.floor_id, i.seat_id, i.reporter_id, "
    "i.acknowledged_at, i.assigned_at, i.resolved_at, i.closed_at, ae.user_id AS assignee_user_id"
)
FROM = (
    " FROM incidents i JOIN categories c ON c.id = i.category_id JOIN buildings b ON b.id = i.building_id "
    "LEFT JOIN floors f ON f.id = i.floor_id LEFT JOIN seats s ON s.id = i.seat_id "
    "JOIN users r ON r.id = i.reporter_id "
    "LEFT JOIN engineer_profiles ae ON ae.id = i.assignee_id LEFT JOIN users au ON au.id = ae.user_id "
)
NOTES = (
    "SELECT n.id, n.body, n.is_internal, u.full_name AS author, u.role AS author_role, n.created_at "
    "FROM incident_notes n JOIN users u ON u.id = n.author_id "
)

CREATE_RULES = {
    "title": clean_text("Title", 150),
    "description": clean_text("Description", 4000),
    "category_id": clean_uuid("Category"),
    "building_id": clean_uuid("Building"),
    "floor_id": optional(clean_uuid("Floor")),
    "seat_id": optional(clean_uuid("Seat")),
    "priority": optional(clean_choice("Priority", PRIORITIES)),
}
# When the database refuses a new incident, the broken constraint says which field to blame.
BAD_REFERENCE = {
    "incidents_category_id_fkey": ("category_id", "Choose a category from the list"),
    "incidents_building_id_fkey": ("building_id", "Choose a building from the list"),
    "incidents_floor_in_building": ("floor_id", "Choose a floor in this building"),
    "incidents_seat_on_floor": ("seat_id", "Choose a seat on this floor"),
}


def clean_assignee(value):
    """The assignee filter: 'none', 'me', or an engineer's profile id."""
    return value if value in ("none", "me") else clean_uuid("Assignee")(value)


FILTERS = {
    "status": optional(clean_choice("Status", STATUSES)),
    "priority": optional(clean_choice("Priority", PRIORITIES)),
    "category_id": optional(clean_uuid("Category")),
    "building_id": optional(clean_uuid("Building")),
    "assignee": optional(clean_assignee),
    "q": optional(clean_text("Search", 100)),
}


def invalid(field, message):
    return ApiError(400, "validation_error", "Some fields are invalid", {field: message})


def not_found():
    return ApiError(404, "not_found", "Incident not found")


def label(status):
    return status.replace("_", " ").capitalize()  # IN_PROGRESS -> In progress


# ---------------------------------------------------------------------------
# Who may see and do what
# ---------------------------------------------------------------------------


def visible_to(user):
    """The SQL condition for "this user may see incident i", and its parameters."""
    if user["role"] == "ADMIN":
        return "TRUE", []
    return "(i.reporter_id = %s OR ae.user_id = %s)", [user["id"], user["id"]]


def is_staff(user, incident):
    return user["role"] == "ADMIN" or incident["assignee_user_id"] == user["id"]


def may_move(user, incident, to):
    """Whether this user may make this move (the workflow itself is checked separately)."""
    if user["role"] == "ADMIN":
        return True
    if is_staff(user, incident):  # the assigned engineer: anything but closing untouched work
        return (incident["status"], to) != ("OPEN", "CLOSED")
    return incident["status"] == "RESOLVED"  # the reporter: confirm the fix, or reopen


def needs_assignee(incident, to):
    """Work cannot start on an incident nobody is assigned to."""
    return (incident["status"], to) == ("OPEN", "IN_PROGRESS") and not incident["assignee_id"]


def find(user, incident_id):
    """The incident if the user may see it; otherwise the same 404 as for an unknown one."""
    who, params = visible_to(user)
    incident = query(f"SELECT {COLUMNS}{MORE}{FROM} WHERE i.id = %s AND {who}", [incident_id, *params])
    if not incident:
        raise not_found()
    return incident


def detail(user, incident_id):
    """The incident as the detail screen needs it: with notes, history and the moves this
    user can make right now (the buttons to show)."""
    incident = find(user, incident_id)
    staff = is_staff(user, incident)
    incident["notes"] = query_all(  # internal notes are for staff only
        NOTES + "WHERE n.incident_id = %s AND (%s OR NOT n.is_internal) ORDER BY n.created_at, n.id",
        (incident_id, staff),
    )
    incident["history"] = query_all(
        "SELECT h.from_status, h.to_status, u.full_name AS changed_by, h.reason, h.changed_at "
        "FROM incident_status_history h JOIN users u ON u.id = h.changed_by "
        "WHERE h.incident_id = %s ORDER BY h.changed_at, h.id",
        (incident_id,),
    )
    incident["next_statuses"] = [
        to for to in WORKFLOW[incident["status"]] if may_move(user, incident, to) and not needs_assignee(incident, to)
    ]
    incident["is_staff"] = staff  # tells the screen whether to offer internal notes
    del incident["assignee_user_id"]  # only needed for the checks above
    return incident


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


def health(_event):
    return respond(200, {"service": "incidents", "status": "ok"})


@protected()
def list_categories(_event, _user):
    return respond(200, {"categories": query_all("SELECT id, name, type FROM categories ORDER BY name")})


@protected()
def list_incidents(event, user):
    """Newest first, at most 200. Every filter is optional and they combine."""
    filters = validate(query_params(event), FILTERS)
    where, params = visible_to(user)
    for column in ("status", "priority", "category_id", "building_id"):
        if filters[column]:
            where += f" AND i.{column} = %s"
            params.append(filters[column])
    if filters["assignee"] == "none":
        where += " AND i.assignee_id IS NULL"
    elif filters["assignee"] == "me":
        where += " AND ae.user_id = %s"
        params.append(user["id"])
    elif filters["assignee"]:
        where += " AND i.assignee_id = %s"
        params.append(filters["assignee"])
    if filters["q"]:
        # % and _ mean "anything" to ILIKE: escaped, so a search for "50%" finds just that
        pattern = "%" + re.sub(r"([\\%_])", r"\\\1", filters["q"]) + "%"
        where += " AND (i.title ILIKE %s OR i.description ILIKE %s)"
        params += [pattern, pattern]
    incidents = query_all(f"SELECT {COLUMNS}{FROM} WHERE {where} ORDER BY i.created_at DESC, i.id LIMIT 200", params)
    return respond(200, {"incidents": incidents})


@protected()
def get_incident(_event, user, incident_id):
    return respond(200, {"incident": detail(user, incident_id)})


@protected()
def summary(_event, user):
    """The dashboard numbers, over the incidents this user may see."""
    who, params = visible_to(user)

    def hours(column):  # average time from being reported, over the incidents that got there
        return f"round((avg(extract(epoch FROM i.{column} - i.created_at)) / 3600)::numeric, 1)::float"

    def tally(column, values):  # one count per status or priority, zeros included
        return ", ".join(f"count(*) FILTER (WHERE i.{column} = '{value}') AS \"{value}\"" for value in values)

    row = query(
        f"SELECT count(*) AS total, {tally('status', STATUSES)}, {tally('priority', PRIORITIES)}, "
        f"count(*) FILTER (WHERE {STILL_OPEN} AND i.assignee_id IS NULL) AS unassigned_open, "
        f"count(*) FILTER (WHERE {STILL_OPEN} AND i.is_escalated) AS escalated_open, "
        f"{hours('acknowledged_at')} AS to_acknowledge, {hours('assigned_at')} AS to_assign, "
        f"{hours('resolved_at')} AS to_resolve{FROM} WHERE {who}",
        params,
    )
    by_assignee = []
    if user["role"] == "ADMIN":  # how work is spread across the engineers
        by_assignee = query_all(
            "SELECT p.id AS assignee_id, u.full_name AS assignee, p.is_available, p.max_open_tickets, "
            f"(SELECT count(*) FROM incidents i WHERE i.assignee_id = p.id AND {STILL_OPEN}) AS open "
            "FROM engineer_profiles p JOIN users u ON u.id = p.user_id ORDER BY u.full_name, u.email"
        )
    return respond(
        200,
        {
            "total": row["total"],
            "by_status": {status: row[status] for status in STATUSES},
            "by_priority": {priority: row[priority] for priority in PRIORITIES},
            "unassigned_open": row["unassigned_open"],
            "escalated_open": row["escalated_open"],
            "by_assignee": by_assignee,
            "average_hours": {key: row[key] for key in ("to_acknowledge", "to_assign", "to_resolve")},
        },
    )


# ---------------------------------------------------------------------------
# Reporting and managing
# ---------------------------------------------------------------------------


@protected()
def create_incident(event, user):
    """Anyone signed in can report an incident. The first history row is written with it,
    so the history always starts at Open."""
    fields = validate(json_body(event), CREATE_RULES)
    if fields["seat_id"] and not fields["floor_id"]:
        raise invalid("seat_id", "Choose the floor the seat is on")
    try:
        with transaction():
            incident = query(
                "INSERT INTO incidents (title, description, category_id, building_id, floor_id, seat_id, priority, "
                "reporter_id) VALUES (%(title)s, %(description)s, %(category_id)s, %(building_id)s, %(floor_id)s, "
                "%(seat_id)s, %(priority)s, %(reporter_id)s) RETURNING id",
                {**fields, "priority": fields["priority"] or "MEDIUM", "reporter_id": user["id"]},
            )
            query(
                "INSERT INTO incident_status_history (incident_id, to_status, changed_by) VALUES (%s, 'OPEN', %s)",
                (incident["id"], user["id"]),
                fetch=False,
            )
    except psycopg.errors.ForeignKeyViolation as error:
        # An id that does not exist (or was removed a moment ago), a floor in another
        # building or a seat on another floor: the foreign keys check all of it.
        raise invalid(*BAD_REFERENCE[error.diag.constraint_name]) from None
    return respond(201, {"incident": detail(user, incident["id"])})


@protected("ADMIN")
def update_incident(event, admin, incident_id):
    """Set the priority and who works on it; both are sent each time, the assignee may be
    null. Availability and capacity are shown to the admin, not enforced: they decide."""
    body = json_body(event)
    if "assignee_id" not in body:  # left out is not null: it must not quietly unassign
        raise invalid("assignee_id", "Send the assignee, or null for nobody")
    fields = validate(
        body, {"priority": clean_choice("Priority", PRIORITIES), "assignee_id": optional(clean_uuid("Assignee"))}
    )
    incident = find(admin, incident_id)
    assignee = fields["assignee_id"] and uuid.UUID(fields["assignee_id"])
    if incident["status"] == "RESOLVED" and assignee != incident["assignee_id"]:
        # Feedback goes to the assignee, so whoever resolved it stays until it is reopened or closed
        raise ApiError(409, "conflict", "Reopen a resolved incident before changing who works on it")
    newly_assigned = bool(assignee) and assignee != incident["assignee_id"]
    if newly_assigned and not query(
        "SELECT 1 AS found FROM engineer_profiles p JOIN users u ON u.id = p.user_id WHERE p.id = %s AND u.is_active",
        (assignee,),
    ):
        raise invalid("assignee_id", "Choose an active engineer")
    if not query(  # the status is checked by the UPDATE itself, so a close a moment ago still counts
        "UPDATE incidents SET priority = %s, assignee_id = %s, updated_at = now()"
        + ACKNOWLEDGE
        + (", assigned_at = now()" if newly_assigned else "")
        + " WHERE id = %s AND status <> 'CLOSED' RETURNING id",
        (fields["priority"], assignee, incident_id),
    ):
        raise ApiError(409, "conflict", "A closed incident cannot be changed")
    return respond(200, {"incident": detail(admin, incident_id)})


@protected("ADMIN")
def delete_incident(_event, _admin, incident_id):
    """Its notes, history, suggestions and feedback go with it (ON DELETE CASCADE in the schema)."""
    if not query("DELETE FROM incidents WHERE id = %s RETURNING id", (incident_id,)):
        raise not_found()
    return respond(204)


# ---------------------------------------------------------------------------
# The workflow and notes
# ---------------------------------------------------------------------------


@protected()
def change_status(event, user, incident_id):
    """Move an incident along the workflow. The incident and its history row change
    together, and only if nobody else moved it in the meantime."""
    fields = validate(
        json_body(event), {"status": clean_choice("Status", STATUSES), "reason": optional(clean_text("Reason", 500))}
    )
    incident = find(user, incident_id)
    old, new, reason = incident["status"], fields["status"], fields["reason"]
    if new not in WORKFLOW[old]:
        raise ApiError(409, "conflict", f"An incident that is {label(old)} cannot be moved to {label(new)}")
    if not may_move(user, incident, new):
        raise ApiError(403, "access_denied", "You do not have permission to perform this action")
    if new == "BLOCKED" and not reason:
        raise invalid("reason", "Say what is blocking it")
    if (old, new) == ("RESOLVED", "IN_PROGRESS") and not reason:
        raise invalid("reason", "Say why it needs more work")
    if needs_assignee(incident, new):
        raise ApiError(409, "conflict", "Assign an engineer before work starts")

    stamps = {"RESOLVED": ", resolved_at = now()", "CLOSED": ", closed_at = now()"}.get(new, "")
    with transaction():
        moved = query(
            "UPDATE incidents SET status = %s, blocked_reason = %s, updated_at = now()"
            + stamps
            + (ACKNOWLEDGE if is_staff(user, incident) else "")
            + " WHERE id = %s AND status = %s RETURNING id",
            (new, reason if new == "BLOCKED" else None, incident_id, old),
        )
        if not moved:
            raise ApiError(409, "conflict", "This incident was just changed by someone else. Reload and try again.")
        query(
            "INSERT INTO incident_status_history (incident_id, from_status, to_status, changed_by, reason) "
            "VALUES (%s, %s, %s, %s, %s)",
            (incident_id, old, new, user["id"], reason),
            fetch=False,
        )
    return respond(200, {"incident": detail(user, incident_id)})


@protected()
def add_note(event, user, incident_id):
    """Anyone who can see an incident can add to it until it is closed. An internal note
    is one only staff will see, so only staff can write one. A note from staff also counts
    as acknowledging the incident."""
    fields = validate(
        json_body(event), {"body": clean_text("Note", 2000), "is_internal": optional(clean_bool("Internal"))}
    )
    incident = find(user, incident_id)
    staff = is_staff(user, incident)
    if fields["is_internal"] and not staff:
        raise ApiError(403, "access_denied", "You do not have permission to perform this action")
    try:
        with transaction():
            note = query(
                "INSERT INTO incident_notes (incident_id, author_id, body, is_internal) "
                "VALUES (%s, %s, %s, %s) RETURNING id",
                (incident_id, user["id"], fields["body"], bool(fields["is_internal"])),
            )
            if not query(  # checked by the UPDATE itself, so a close a moment ago still counts
                "UPDATE incidents SET updated_at = now()"
                + (ACKNOWLEDGE if staff else "")
                + " WHERE id = %s AND status <> 'CLOSED' RETURNING id",
                (incident_id,),
            ):
                raise ApiError(409, "conflict", "A closed incident cannot take new notes")
    except psycopg.errors.ForeignKeyViolation:  # the incident was removed a moment ago
        raise not_found() from None
    return respond(201, {"note": query(NOTES + "WHERE n.id = %s", (note["id"],))})


ROUTES = {
    ("GET", "/"): health,
    ("GET", "/categories"): list_categories,
    ("GET", "/summary"): summary,
    ("GET", "/tickets"): list_incidents,
    ("POST", "/tickets"): create_incident,
    ("GET", "/tickets/{incident_id}"): get_incident,
    ("PATCH", "/tickets/{incident_id}"): update_incident,
    ("DELETE", "/tickets/{incident_id}"): delete_incident,
    ("POST", "/tickets/{incident_id}/status"): change_status,
    ("POST", "/tickets/{incident_id}/notes"): add_note,
}


def handler(event=None, context=None):
    """Lambda entry point."""
    return dispatch(event, "incidents", ROUTES)
