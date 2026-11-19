"""
Engineers service: the engineers who work on incidents, managed by facility admins.

Reached as /api/engineers/* (the local proxy and CloudFront both route here).

    GET    /                        service health
    GET    /profiles                every engineer, with their open-ticket count   (admin)
    POST   /profiles                create an engineer: their login and profile    (admin)
    PATCH  /profiles/{profile_id}   change an engineer's details                   (admin)
    DELETE /profiles/{profile_id}   remove an engineer who has no incident history (admin)
    GET    /managers                the admins who can be an engineer's manager    (admin)

An engineer is a row in users (the login, role ENGINEER) plus a row in engineer_profiles
(specialism, availability, capacity, manager). The two are always written together.
"""

import logging

import psycopg

from db import query, query_all, transaction
from http_utils import ApiError, clean_bool, clean_int, clean_text, clean_uuid, dispatch, json_body, respond, validate
from security import EMAIL_TAKEN, clean_company_email, clean_new_password, hash_password, protected

logger = logging.getLogger()
logger.setLevel(logging.INFO)

PROFILE_RULES = {
    "full_name": clean_text("Full name", 100),
    "specialism": clean_text("Specialism", 100),
    "max_open_tickets": clean_int("Max open tickets", 1, 50),
}
NOT_A_MANAGER = "Choose a facility admin as the manager"
NOT_YOURS = "Only the engineer's current manager can hand them to another manager"
IN_USE = "This engineer has incident history and cannot be removed. Deactivate them instead."

# One engineer as the API returns it. Open tickets are the incidents assigned to the
# engineer that still need work: that count is their workload.
PROFILES = (
    "SELECT p.id, u.full_name, u.email, u.is_active, p.specialism, p.is_available, p.max_open_tickets, "
    "p.manager_id, m.full_name AS manager_name, "
    "(SELECT count(*) FROM incidents i WHERE i.assignee_id = p.id AND i.status NOT IN ('RESOLVED', 'CLOSED')) "
    "AS open_tickets "
    "FROM engineer_profiles p JOIN users u ON u.id = p.user_id LEFT JOIN users m ON m.id = p.manager_id "
)


def not_found():
    return ApiError(404, "not_found", "Engineer not found")


def health(_event):
    return respond(200, {"service": "engineers", "status": "ok"})


@protected("ADMIN")
def list_profiles(_event, _admin):
    return respond(200, {"profiles": query_all(PROFILES + "ORDER BY u.full_name, u.email")})


@protected("ADMIN")
def list_managers(_event, _admin):
    managers = query_all("SELECT id, full_name FROM users WHERE role = 'ADMIN' AND is_active ORDER BY full_name")
    return respond(200, {"managers": managers})


@protected("ADMIN")
def create_profile(event, admin):
    """The login and the profile are saved together or not at all. The admin who creates
    an engineer becomes their manager."""
    fields = validate(
        json_body(event), {"email": clean_company_email, "password": clean_new_password, **PROFILE_RULES}
    )
    password_hash = hash_password(fields["password"])  # slow on purpose, so done before the transaction
    with transaction():
        user = query(
            "INSERT INTO users (email, full_name, password_hash, role) VALUES (%s, %s, %s, 'ENGINEER') "
            "ON CONFLICT (email) DO NOTHING RETURNING id",
            (fields["email"], fields["full_name"], password_hash),
        )
        if not user:
            raise ApiError(409, "conflict", EMAIL_TAKEN, {"email": EMAIL_TAKEN})
        profile = query(
            "INSERT INTO engineer_profiles (user_id, specialism, max_open_tickets, manager_id) "
            "VALUES (%s, %s, %s, %s) RETURNING id",
            (user["id"], fields["specialism"], fields["max_open_tickets"], admin["id"]),
        )
    return respond(201, {"profile": query(PROFILES + "WHERE p.id = %s", (profile["id"],))})


@protected("ADMIN")
def update_profile(event, admin, profile_id):
    """Every field is sent each time. Setting is_active to false blocks the engineer's
    sign-in at once: current_user() refuses inactive users."""
    fields = validate(
        json_body(event),
        {
            **PROFILE_RULES,
            "is_available": clean_bool("Available"),
            "is_active": clean_bool("Active"),
            "manager_id": clean_uuid("Manager"),
        },
    )
    if not query("SELECT 1 AS found FROM users WHERE id = %s AND role = 'ADMIN' AND is_active", (fields["manager_id"],)):
        raise ApiError(400, "validation_error", "Some fields are invalid", {"manager_id": NOT_A_MANAGER})
    with transaction():
        current = query(
            "SELECT p.user_id, p.manager_id, COALESCE(m.role = 'ADMIN' AND m.is_active, FALSE) AS managed "
            "FROM engineer_profiles p LEFT JOIN users m ON m.id = p.manager_id WHERE p.id = %s FOR UPDATE OF p",
            (profile_id,),
        )
        if not current:
            raise not_found()
        # Feedback on an engineer is for their manager only, so another admin must not be
        # able to take an engineer over. With no working manager, any admin may step in.
        handing_over = str(current["manager_id"]) != fields["manager_id"].lower()
        if handing_over and current["managed"] and current["manager_id"] != admin["id"]:
            raise ApiError(403, "access_denied", NOT_YOURS)
        query(
            "UPDATE engineer_profiles SET specialism = %s, max_open_tickets = %s, is_available = %s, "
            "manager_id = %s, updated_at = now() WHERE id = %s",
            (fields["specialism"], fields["max_open_tickets"], fields["is_available"], fields["manager_id"], profile_id),
            fetch=False,
        )
        # Deactivating also bumps token_version, so tokens issued before it stay dead even
        # if the engineer is reactivated later: they have to sign in again.
        query(
            "UPDATE users SET full_name = %s, is_active = %s, "
            "token_version = token_version + CASE WHEN %s THEN 0 ELSE 1 END, updated_at = now() WHERE id = %s",
            (fields["full_name"], fields["is_active"], fields["is_active"], current["user_id"]),
            fetch=False,
        )
    return respond(200, {"profile": query(PROFILES + "WHERE p.id = %s", (profile_id,))})


@protected("ADMIN")
def delete_profile(_event, _admin, profile_id):
    """Remove the profile and the login together. Incidents, notes and history keep foreign
    keys to both, so the database refuses while anything points at the engineer, and the
    whole unit is undone."""
    try:
        with transaction():
            profile = query("DELETE FROM engineer_profiles WHERE id = %s RETURNING user_id", (profile_id,))
            if not profile:
                raise not_found()
            query("DELETE FROM users WHERE id = %s", (profile["user_id"],), fetch=False)
    except psycopg.errors.ForeignKeyViolation:
        raise ApiError(409, "conflict", IN_USE) from None
    return respond(204)


ROUTES = {
    ("GET", "/"): health,
    ("GET", "/profiles"): list_profiles,
    ("POST", "/profiles"): create_profile,
    ("PATCH", "/profiles/{profile_id}"): update_profile,
    ("DELETE", "/profiles/{profile_id}"): delete_profile,
    ("GET", "/managers"): list_managers,
}


def handler(event=None, context=None):
    """Lambda entry point."""
    return dispatch(event, "engineers", ROUTES)
