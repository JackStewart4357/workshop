"""Unit tests for the shared HTTP helpers: responses, body parsing, validation, routing."""

import json

import pytest

import http_utils
from conftest import make_event
from http_utils import ApiError, clean_email, clean_text, dispatch, json_body, respond, respond_error, validate


def body_of(response):
    return json.loads(response["body"])


# --- responses -------------------------------------------------------------------------


def test_respond_serialises_json_with_content_type():
    response = respond(201, {"id": 1})
    assert response["statusCode"] == 201
    assert response["headers"] == {"Content-Type": "application/json"}
    assert body_of(response) == {"id": 1}


def test_respond_without_body_is_empty():
    assert respond(204) == {"statusCode": 204, "headers": {}, "body": ""}


def test_error_response_has_one_consistent_shape():
    response = respond_error(ApiError(400, "validation_error", "Bad input", {"email": "Required"}))
    assert response["statusCode"] == 400
    assert body_of(response) == {
        "error": {"code": "validation_error", "message": "Bad input", "details": {"email": "Required"}}
    }


def test_error_response_omits_empty_details():
    assert body_of(respond_error(ApiError(404, "not_found", "Nope"))) == {
        "error": {"code": "not_found", "message": "Nope"}
    }


# --- request body ----------------------------------------------------------------------


def test_json_body_parses_an_object():
    assert json_body(make_event(body={"a": 1})) == {"a": 1}


def test_json_body_decodes_base64():
    assert json_body(make_event(body={"a": 1}, base64_body=True)) == {"a": 1}


@pytest.mark.parametrize(
    "raw, message",
    [
        (None, "Request body is required"),
        ("", "Request body is required"),
        ("{not json", "Request body must be valid JSON"),
        ("[1, 2]", "Request body must be a JSON object"),
        ('"text"', "Request body must be a JSON object"),
    ],
)
def test_json_body_rejects_bad_input(raw, message):
    with pytest.raises(ApiError) as error:
        json_body({"body": raw})
    assert (error.value.status, error.value.code, error.value.message) == (400, "validation_error", message)


def test_json_body_rejects_absurdly_nested_json():
    with pytest.raises(ApiError) as error:
        json_body({"body": "[" * 200_000})
    assert error.value.status == 400


def test_json_body_rejects_invalid_base64_payload():
    with pytest.raises(ApiError) as error:
        json_body({"body": "%%%", "isBase64Encoded": True})
    assert error.value.status == 400


# --- validation ------------------------------------------------------------------------


def test_validate_returns_cleaned_values():
    cleaned = validate({"name": "  Ada  ", "extra": "ignored"}, {"name": clean_text("Name", 10)})
    assert cleaned == {"name": "Ada"}


def test_validate_reports_every_failing_field_at_once():
    rules = {"name": clean_text("Name", 3), "email": clean_email}
    with pytest.raises(ApiError) as error:
        validate({"name": "too long", "email": "nope"}, rules)
    assert error.value.status == 400
    assert error.value.details == {
        "name": "Name must be at most 3 characters",
        "email": "Enter a valid email address",
    }


@pytest.mark.parametrize("value", [None, "", "   ", 42, ["a"]])
def test_clean_text_requires_a_non_blank_string(value):
    with pytest.raises(ValueError, match="Name is required"):
        clean_text("Name", 10)(value)


@pytest.mark.parametrize("value", ["A\x00B", "A\ud800B"])
def test_clean_text_rejects_characters_the_database_cannot_store(value):
    """Valid JSON can carry NUL bytes and lone surrogates; they must be a 400, not a 500."""
    with pytest.raises(ValueError, match="Name contains characters that are not valid text"):
        clean_text("Name", 10)(value)


def test_clean_text_measures_length_after_trimming():
    assert clean_text("Name", 3)("  abc  ") == "abc"


def test_clean_email_normalises_case_and_whitespace():
    assert clean_email("  Jo.Bloggs@ACME.inc ") == "jo.bloggs@acme.inc"


@pytest.mark.parametrize("value", [None, "", "  ", 7])
def test_clean_email_is_required(value):
    with pytest.raises(ValueError, match="Email is required"):
        clean_email(value)


@pytest.mark.parametrize(
    "value", ["plain", "@acme.inc", "a@b", "a b@acme.inc", "a@acme..inc", "a@@acme.inc", "x" * 250 + "@acme.inc"]
)
def test_clean_email_rejects_malformed_addresses(value):
    with pytest.raises(ValueError, match="Enter a valid email address"):
        clean_email(value)


# --- routing ---------------------------------------------------------------------------


def echo(event):
    return respond(200, {"path": event.get("rawPath")})


ROUTES = {("GET", "/"): echo, ("GET", "/items"): echo, ("POST", "/items"): echo}


@pytest.mark.parametrize(
    "raw_path, expected_route",
    [
        ("/", "/"),
        ("", "/"),
        ("/items", "/items"),
        ("/items/", "/items"),
        ("/api/things", "/"),  # CloudFront keeps the /api/<service> prefix
        ("/api/things/items", "/items"),
        ("/things/items", "/items"),
    ],
)
def test_dispatch_strips_the_service_prefix(raw_path, expected_route):
    response = dispatch(make_event("GET", raw_path), "things", ROUTES)
    assert response["statusCode"] == 200, f"{raw_path} should route to {expected_route}"


def test_dispatch_does_not_strip_a_lookalike_prefix():
    assert dispatch(make_event("GET", "/thingsmore"), "things", ROUTES)["statusCode"] == 404


def test_dispatch_unknown_path_is_404():
    response = dispatch(make_event("GET", "/missing"), "things", ROUTES)
    assert response["statusCode"] == 404
    assert body_of(response)["error"]["code"] == "not_found"


def test_dispatch_known_path_wrong_method_is_405():
    response = dispatch(make_event("DELETE", "/items"), "things", ROUTES)
    assert response["statusCode"] == 405
    assert body_of(response)["error"]["code"] == "method_not_allowed"


def test_dispatch_defaults_to_get_root_for_an_empty_event():
    assert dispatch(None, "things", ROUTES)["statusCode"] == 200


def test_dispatch_method_is_case_insensitive():
    event = make_event("GET", "/items")
    event["requestContext"]["http"]["method"] = "post"
    assert dispatch(event, "things", ROUTES)["statusCode"] == 200


def test_dispatch_runs_the_before_hook_first():
    calls = []

    def endpoint(_event):
        calls.append("route")
        return respond(200)

    dispatch(make_event("GET", "/"), "things", {("GET", "/"): endpoint}, before=lambda: calls.append("before"))
    assert calls == ["before", "route"]


def test_dispatch_turns_api_errors_into_responses():
    def endpoint(_event):
        raise ApiError(403, "access_denied", "No")

    response = dispatch(make_event("GET", "/"), "things", {("GET", "/"): endpoint})
    assert response["statusCode"] == 403
    assert body_of(response)["error"]["code"] == "access_denied"


def test_dispatch_hides_unexpected_errors(caplog):
    def endpoint(_event):
        raise RuntimeError("password=hunter2 leaked from the database driver")

    response = dispatch(make_event("GET", "/"), "things", {("GET", "/"): endpoint})
    assert response["statusCode"] == 500
    assert body_of(response) == {"error": {"code": "internal_error", "message": "An unexpected error occurred"}}
    assert "hunter2" not in response["body"]
    assert "hunter2" in caplog.text  # ...but the real cause is logged for operators


def test_dispatch_reports_a_failing_before_hook_as_500():
    def before():
        raise RuntimeError("database is down")

    assert dispatch(make_event("GET", "/"), "things", ROUTES, before=before)["statusCode"] == 500


def test_module_does_not_shadow_the_standard_library():
    import http.client  # noqa: F401 - would fail if our module were named http.py

    assert http_utils.__name__ == "http_utils"
