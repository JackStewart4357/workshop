"""HTTP plumbing for Lambda Function URLs: errors, responses, request validation, routing.

Errors always look like: {"error": {"code": "...", "message": "...", "details": {...}}}

Named http_utils rather than http so it cannot shadow Python's standard 'http' module.
"""

import base64
import json
import logging
import re

logger = logging.getLogger()

# ---------------------------------------------------------------------------
# Errors and responses
# ---------------------------------------------------------------------------


class ApiError(Exception):
    """An error that maps directly onto an HTTP response."""

    def __init__(self, status, code, message, details=None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details


def respond(status, body=None):
    if body is None:
        return {"statusCode": status, "headers": {}, "body": ""}
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=str),
    }


def respond_error(error):
    payload = {"code": error.code, "message": error.message}
    if error.details:
        payload["details"] = error.details
    return respond(error.status, {"error": payload})


# ---------------------------------------------------------------------------
# Request body and validation
# ---------------------------------------------------------------------------

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
    except (TypeError, ValueError):
        raise ApiError(400, "validation_error", "Request body must be valid JSON") from None
    if not isinstance(data, dict):
        raise ApiError(400, "validation_error", "Request body must be a JSON object")
    return data


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


def clean_text(label, max_length):
    """Cleaner factory: a required, trimmed string of at most max_length characters."""

    def clean(value):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{label} is required")
        if len(value.strip()) > max_length:
            raise ValueError(f"{label} must be at most {max_length} characters")
        return value.strip()

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


def dispatch(event, service, routes, before=None):
    """Route a Function URL event and always return a well-formed response.

    service: the folder name, i.e. the '<service>' in /api/<service>/...
    routes:  {(METHOD, "/path"): endpoint(event)}
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
        endpoint = routes.get((method, path))
        if endpoint:
            return endpoint(event)
        if any(route_path == path for _, route_path in routes):
            raise ApiError(405, "method_not_allowed", f"{method} is not allowed on {path}")
        raise ApiError(404, "not_found", f"No route for {method} {path}")
    except ApiError as error:
        return respond_error(error)
    except Exception:  # noqa: BLE001 - never leak internals to the client
        logger.exception("Unhandled error on %s %s", method, path)
        return respond_error(ApiError(500, "internal_error", "An unexpected error occurred"))
