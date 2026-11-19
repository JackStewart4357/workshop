"""HTTP plumbing for Lambda Function URLs: errors, responses, request validation, routing.

Errors always look like: {"error": {"code": "...", "message": "...", "details": {...}}}

Named http_utils rather than http so it cannot shadow Python's standard 'http' module.
"""

import base64
import json
import logging
import re
from urllib.parse import parse_qsl

logger = logging.getLogger()

# ---------------------------------------------------------------------------
# Errors and responses
# ---------------------------------------------------------------------------


class ApiError(Exception):
    """An error that maps directly onto an HTTP response."""

    def __init__(self, status, code, message, details=None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details


def _json_default(value):
    """What JSON has no type for: dates and times as ISO 8601 (which JavaScript's Date
    reads everywhere), ids and anything else as text."""
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def respond(status, body=None):
    if body is None:
        return {"statusCode": status, "headers": {}, "body": ""}
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=_json_default),
    }


def respond_error(error):
    payload = {"code": error.code, "message": error.message}
    if error.details:
        payload["details"] = error.details
    return respond(error.status, {"error": payload})


# ---------------------------------------------------------------------------
# Request body and validation
# ---------------------------------------------------------------------------

_UUID = r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"
_EMAIL_RE = re.compile(r"^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$")


def json_body(event):
    """Parse the request body as a JSON object, or raise a 400."""
    raw = event.get("body")
    if not raw:
        raise ApiError(400, "validation_error", "Request body is required")
    try:
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw).decode("utf-8")
        data = json.loads(raw)
    except (TypeError, ValueError, RecursionError):
        raise ApiError(400, "validation_error", "Request body must be valid JSON") from None
    if not isinstance(data, dict):
        raise ApiError(400, "validation_error", "Request body must be a JSON object")
    return data


def query_params(event):
    """The query string as a dict: '?status=OPEN&q=leak' -> {"status": "OPEN", "q": "leak"}."""
    return dict(parse_qsl(event.get("rawQueryString") or "", keep_blank_values=True))


def validate(data, rules):
    """Apply {field: cleaner} to data, reporting every failed field in one 400.

    A cleaner takes the raw value and returns the cleaned one, or raises ValueError
    with a message suitable for showing next to the field.
    """
    cleaned, errors = {}, {}
    for field, cleaner in rules.items():
        try:
            cleaned[field] = cleaner(data.get(field))
        except ValueError as error:
            errors[field] = str(error)
    if errors:
        raise ApiError(400, "validation_error", "Some fields are invalid", errors)
    return cleaned


def is_storable_text(value):
    """False for strings PostgreSQL or UTF-8 cannot hold: NUL bytes and lone surrogates,
    both of which valid JSON can carry."""
    return "\x00" not in value and not any(0xD800 <= ord(char) <= 0xDFFF for char in value)


def clean_text(label, max_length):
    """Cleaner factory: a required, trimmed string of at most max_length characters."""

    def clean(value):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{label} is required")
        if not is_storable_text(value):
            raise ValueError(f"{label} contains characters that are not valid text")
        if len(value.strip()) > max_length:
            raise ValueError(f"{label} must be at most {max_length} characters")
        return value.strip()

    return clean


def clean_int(label, minimum, maximum):
    """Cleaner factory: a required whole number from minimum to maximum."""

    def clean(value):
        # JSON true is an int to Python (True == 1), so it has to be ruled out by name
        if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
            raise ValueError(f"{label} must be a whole number from {minimum} to {maximum}")
        return value

    return clean


def clean_bool(label):
    """Cleaner factory: a required JSON true or false."""

    def clean(value):
        if not isinstance(value, bool):
            raise ValueError(f"{label} must be true or false")
        return value

    return clean


def clean_uuid(label):
    """Cleaner factory: a required row id, in the same form dispatch() accepts in a path."""

    def clean(value):
        if not isinstance(value, str) or not re.fullmatch(_UUID, value):
            raise ValueError(f"{label} is required")
        return value

    return clean


def clean_choice(label, choices):
    """Cleaner factory: a required value from a fixed list, such as a status."""

    def clean(value):
        if not isinstance(value, str) or value not in choices:
            raise ValueError(f"{label} must be one of: {', '.join(choices)}")
        return value

    return clean


def optional(cleaner):
    """Wrap a cleaner for a field that may be left out: missing, null and blank all become None."""

    def clean(value):
        if value is None or (isinstance(value, str) and not value.strip()):
            return None
        return cleaner(value)

    return clean


def clean_email(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Email is required")
    value = value.strip().lower()
    if len(value) > 254 or not _EMAIL_RE.match(value):
        raise ValueError("Enter a valid email address")
    return value


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------


def _path_params(route_path, path):
    """The ids in path if it is this route, else None: '/floors/{floor_id}' -> {'floor_id': '...'}.

    Every id in the database is a UUID, so a {name} part only matches one. Anything else
    is simply not this route and ends as a 404, never as a database error.
    """
    pattern = re.sub(r"\\\{(\w+)\\\}", rf"(?P<\1>{_UUID})", re.escape(route_path))
    found = re.fullmatch(pattern, path)
    return found.groupdict() if found else None


def dispatch(event, service, routes, before=None):
    """Route a Function URL event and always return a well-formed response.

    service: the folder name, i.e. the '<service>' in /api/<service>/...
    routes:  {(METHOD, "/path"): endpoint(event)}. A path may hold ids, which are passed
             on by name: {("GET", "/floors/{floor_id}"): endpoint(event, floor_id)}
    before:  optional callable run before every request (e.g. one-time setup)
    """
    event = event or {}
    http = (event.get("requestContext") or {}).get("http") or {}
    method = (http.get("method") or "GET").upper()
    # CloudFront leaves '/api/<service>' on the path; the local proxy strips it.
    prefix = rf"^/(api/)?{re.escape(service)}(?=/|$)"
    path = "/" + re.sub(prefix, "", event.get("rawPath") or "/").strip("/")
    try:
        if before:
            before()
        path_exists = False
        for (route_method, route_path), endpoint in routes.items():
            params = _path_params(route_path, path)
            if params is None:
                continue
            if route_method == method:
                return endpoint(event, **params)
            path_exists = True
        if path_exists:
            raise ApiError(405, "method_not_allowed", f"{method} is not allowed on {path}")
        raise ApiError(404, "not_found", f"No route for {method} {path}")
    except ApiError as error:
        return respond_error(error)
    except Exception:  # noqa: BLE001 - never leak internals to the client
        logger.exception("Unhandled error on %s %s", method, path)
        return respond_error(ApiError(500, "internal_error", "An unexpected error occurred"))
