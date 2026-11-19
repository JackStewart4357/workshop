"""
Feedback service: what the person who reported an incident thought of the engineer's work.

Reached as /api/feedback/* (the local proxy and CloudFront both route here).

    GET  /                           service health
    GET  /incidents/{incident_id}    can the caller give feedback on this incident? (its reporter)
    POST /incidents/{incident_id}    give feedback: a rating from 1 to 5 and a comment (its reporter)
    GET  /engineers                  rating summary of each engineer the caller manages
    GET  /engineers/{profile_id}     every piece of feedback on one engineer (their manager only)

Feedback is read by one person only: the engineer's manager (engineer_profiles.manager_id).
No endpoint returns it to the engineer, to other admins, or back to its author.

The same handler runs as a Lambda and, through server.py, in a container on ECS Fargate.
"""

import logging

from db import query, query_all
from http_utils import ApiError, clean_int, clean_text, dispatch, json_body, optional, respond, validate
from security import protected

logger = logging.getLogger()
logger.setLevel(logging.INFO)

RULES = {"rating": clean_int("Rating", 1, 5), "comment": optional(clean_text("Comment", 1000))}
NOT_YET = "Feedback can be given once the incident is resolved"
NO_ENGINEER = "No engineer worked on this incident"
ALREADY_GIVEN = "You have already given feedback on this incident"
NOT_THE_MANAGER = "Only this engineer's manager can read their feedback"


def health(_event):
    return respond(200, {"service": "feedback", "status": "ok"})


def reported_incident(user, incident_id):
    """The incident, if the caller reported it. Anyone else is told it does not exist."""
    incident = query(
        "SELECT i.id, i.status, i.assignee_id, f.id AS feedback_id FROM incidents i "
        "LEFT JOIN incident_feedback f ON f.incident_id = i.id WHERE i.id = %s AND i.reporter_id = %s",
        (incident_id, user["id"]),
    )
    if not incident:
        raise ApiError(404, "not_found", "Incident not found")
    return incident


def refusal(incident):
    """Why feedback cannot be given on this incident right now, or None when it can."""
    if incident["feedback_id"]:
        return ALREADY_GIVEN
    if incident["status"] not in ("RESOLVED", "CLOSED"):
        return NOT_YET
    if not incident["assignee_id"]:
        return NO_ENGINEER
    return None


@protected()
def feedback_state(_event, user, incident_id):
    """Drives the feedback box on the incident page. Never returns the feedback itself."""
    incident = reported_incident(user, incident_id)
    return respond(200, {"given": bool(incident["feedback_id"]), "can_give": refusal(incident) is None})


@protected()
def give_feedback(event, user, incident_id):
    fields = validate(json_body(event), RULES)
    incident = reported_incident(user, incident_id)
    reason = refusal(incident)
    if reason:
        raise ApiError(409, "conflict", reason)
    # The feedback is about whoever the incident is assigned to at this moment.
    saved = query(
        "INSERT INTO incident_feedback (incident_id, engineer_id, author_id, rating, comment) "
        "VALUES (%s, %s, %s, %s, %s) ON CONFLICT (incident_id) DO NOTHING RETURNING id",
        (incident_id, incident["assignee_id"], user["id"], fields["rating"], fields["comment"]),
    )
    if not saved:  # two submissions at once: the first one won
        raise ApiError(409, "conflict", ALREADY_GIVEN)
    return respond(201, {"given": True, "can_give": False})


@protected("ADMIN")
def managed_engineers(_event, admin):
    """One row per engineer the caller manages, for the Engineers screen."""
    engineers = query_all(
        "SELECT p.id AS engineer_id, count(f.id) AS count, round(avg(f.rating), 1)::float AS average "
        "FROM engineer_profiles p LEFT JOIN incident_feedback f ON f.engineer_id = p.id "
        "WHERE p.manager_id = %s GROUP BY p.id",
        (admin["id"],),
    )
    return respond(200, {"engineers": engineers})


@protected("ADMIN")
def engineer_feedback(_event, admin, profile_id):
    profile = query("SELECT manager_id FROM engineer_profiles WHERE id = %s", (profile_id,))
    if not profile:
        raise ApiError(404, "not_found", "Engineer not found")
    if profile["manager_id"] != admin["id"]:
        raise ApiError(403, "access_denied", NOT_THE_MANAGER)
    feedback = query_all(
        "SELECT f.id, f.incident_id, i.title AS incident, f.rating, f.comment, u.full_name AS author, f.created_at "
        "FROM incident_feedback f JOIN incidents i ON i.id = f.incident_id JOIN users u ON u.id = f.author_id "
        "WHERE f.engineer_id = %s ORDER BY f.created_at DESC",
        (profile_id,),
    )
    return respond(200, {"feedback": feedback})


ROUTES = {
    ("GET", "/"): health,
    ("GET", "/incidents/{incident_id}"): feedback_state,
    ("POST", "/incidents/{incident_id}"): give_feedback,
    ("GET", "/engineers"): managed_engineers,
    ("GET", "/engineers/{profile_id}"): engineer_feedback,
}


def handler(event=None, context=None):
    """Lambda entry point."""
    return dispatch(event, "feedback", ROUTES)
