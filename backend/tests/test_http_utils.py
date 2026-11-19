"""Unit tests for the shared HTTP helpers: responses, body parsing, validation, routing."""

import datetime
import decimal
import json
import uuid

import pytest

import http_utils
from conftest import make_event
from http_utils import (
    ApiError,
    clean_bool,
    clean_choice,
    clean_email,
    clean_int,
    clean_text,
    clean_uuid,
    dispatch,
    json_body,
    optional,
    query_params,
    respond,
    respond_error,
    validate,
)


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


def test_respond_writes_times_as_iso_8601_and_other_values_as_text():
    moment = datetime.datetime(2026, 11, 19, 9, 30, tzinfo=datetime.timezone.utc)
    row_id = uuid.UUID("10000000-0000-4000-8000-00000000000a")
    response = respond(200, {"at": moment, "day": moment.date(), "id": row_id, "amount": decimal.Decimal("2.50")})
    assert body_of(response) == {
        "at": "2026-11-19T09:30:00+00:00",
        "day": "2026-11-19",
        "id": "10000000-0000-4000-8000-00000000000a",
        "amount": "2.50",
    }


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


# --- the query string ------------------------------------------------------------------


def test_query_params_decodes_the_query_string():
    event = make_event(query={"status": "OPEN", "q": "50% off & more", "empty": ""})
    assert event["rawQueryString"] == "status=OPEN&q=50%25+off+%26+more&empty="
    assert query_params(event) == {"status": "OPEN", "q": "50% off & more", "empty": ""}


@pytest.mark.parametrize("event", [{}, {"rawQueryString": None}, {"rawQueryString": ""}, make_event()])
def test_query_params_is_empty_without_a_query_string(event):
    assert query_params(event) == {}


def test_query_params_keeps_the_last_of_a_repeated_name():
    assert query_params({"rawQueryString": "status=OPEN&status=CLOSED&q=caf%C3%A9"}) == {"status": "CLOSED", "q": "café"}


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


@pytest.mark.parametrize("value", [-5, 0, 7, 200])
def test_clean_int_accepts_whole_numbers_in_range(value):
    assert clean_int("Level", -5, 200)(value) == value


@pytest.mark.parametrize("value", [None, "", "2", 2.0, 2.5, True, False, -6, 201, [2], {"n": 2}])
def test_clean_int_rejects_everything_else(value):
    with pytest.raises(ValueError, match="Level must be a whole number from -5 to 200"):
        clean_int("Level", -5, 200)(value)


@pytest.mark.parametrize("value", [True, False])
def test_clean_bool_accepts_only_true_and_false(value):
    assert clean_bool("Active")(value) is value


@pytest.mark.parametrize("value", [None, 0, 1, "true", "", [], {}])
def test_clean_bool_rejects_everything_else(value):
    with pytest.raises(ValueError, match="Active must be true or false"):
        clean_bool("Active")(value)


@pytest.mark.parametrize("value", ["10000000-0000-4000-8000-00000000000a", "ABCDEF12-3456-7890-ABCD-EF1234567890"])
def test_clean_uuid_accepts_an_id(value):
    assert clean_uuid("Manager")(value) == value


@pytest.mark.parametrize(
    "value",
    [None, "", 7, "42", "10000000-0000-4000-8000-00000000000", "10000000-0000-4000-8000-00000000000a\n", " 10000000-0000-4000-8000-00000000000a", "g0000000-0000-4000-8000-00000000000a", ["10000000-0000-4000-8000-00000000000a"]],
)
def test_clean_uuid_rejects_everything_else(value):
    with pytest.raises(ValueError, match="Manager is required"):
        clean_uuid("Manager")(value)


@pytest.mark.parametrize("value", ["LOW", "HIGH"])
def test_clean_choice_accepts_a_listed_value(value):
    assert clean_choice("Priority", ("LOW", "HIGH"))(value) == value


@pytest.mark.parametrize("value", [None, "", "low", "URGENT", " LOW", 1, True, ["LOW"], {"LOW": 1}])
def test_clean_choice_rejects_everything_else(value):
    with pytest.raises(ValueError, match="^Priority must be one of: LOW, HIGH$"):
        clean_choice("Priority", ("LOW", "HIGH"))(value)


@pytest.mark.parametrize("value", [None, "", "   ", "\n\t"])
def test_optional_turns_missing_null_and_blank_into_none(value):
    assert optional(clean_text("Reason", 5))(value) is None


def test_optional_runs_the_cleaner_on_anything_else():
    assert optional(clean_text("Reason", 5))("  late ") == "late"
    assert optional(clean_bool("Internal"))(False) is False
    assert optional(clean_int("Level", 0, 9))(0) == 0
    with pytest.raises(ValueError, match="Reason must be at most 5 characters"):
        optional(clean_text("Reason", 5))("too long")
    with pytest.raises(ValueError, match="Reason is required"):
        optional(clean_text("Reason", 5))(7)
    assert validate({}, {"reason": optional(clean_text("Reason", 5))}) == {"reason": None}


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


FLOOR = "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90"
SEAT = "0B1C2D3E-4F50-4A61-8B72-9C8D7E6F5A40"


def show_ids(_event, **ids):
    return respond(200, ids)


ID_ROUTES = {
    ("GET", "/floors"): show_ids,
    ("GET", "/floors/{floor_id}"): show_ids,
    ("DELETE", "/floors/{floor_id}"): show_ids,
    ("GET", "/floors/{floor_id}/seats/{seat_id}"): show_ids,
}


def test_dispatch_passes_ids_in_the_path_to_the_endpoint_by_name():
    response = dispatch(make_event("GET", f"/api/things/floors/{FLOOR}/seats/{SEAT}/"), "things", ID_ROUTES)
    assert response["statusCode"] == 200
    assert body_of(response) == {"floor_id": FLOOR, "seat_id": SEAT}


def test_dispatch_routes_without_ids_get_no_extra_arguments():
    assert body_of(dispatch(make_event("GET", "/floors"), "things", ID_ROUTES)) == {}


def test_dispatch_picks_the_method_among_routes_sharing_a_path():
    assert dispatch(make_event("DELETE", f"/floors/{FLOOR}"), "things", ID_ROUTES)["statusCode"] == 200
    response = dispatch(make_event("POST", f"/floors/{FLOOR}"), "things", ID_ROUTES)
    assert response["statusCode"] == 405


@pytest.mark.parametrize(
    "bad_id",
    [
        "42",
        "not-a-uuid",
        FLOOR[:-1],  # one character short
        FLOOR + "0",
        FLOOR.replace("-", ""),
        "------------------------------------",  # right length, no digits
        "g" + FLOOR[1:],
        FLOOR + "%0A",
        FLOOR + "\n",  # what the local stack hands over for %0A
        FLOOR[1:],  # first group one short
        FLOOR[:8] + FLOOR[13:],  # one group missing
        FLOOR[:8] + "-0000" + FLOOR[8:],  # one group too many
        FLOOR[:9] + FLOOR[10:],  # a middle group one short
        "'; DROP TABLE users; --",
    ],
)
def test_dispatch_treats_anything_but_a_uuid_as_an_unknown_path(bad_id):
    def must_not_run(_event, **_ids):  # pragma: no cover - the point is that it is not called
        raise AssertionError("endpoint reached with a malformed id")

    response = dispatch(make_event("GET", f"/floors/{bad_id}"), "things", {("GET", "/floors/{floor_id}"): must_not_run})
    assert response["statusCode"] == 404
    assert body_of(response)["error"]["code"] == "not_found"


def test_dispatch_route_text_is_matched_literally():
    routes = {("GET", "/a.b"): echo, ("GET", "/c+"): echo}
    assert dispatch(make_event("GET", "/a.b"), "things", routes)["statusCode"] == 200
    assert dispatch(make_event("GET", "/c+"), "things", routes)["statusCode"] == 200
    assert dispatch(make_event("GET", "/aXb"), "things", routes)["statusCode"] == 404
    assert dispatch(make_event("GET", "/ccc"), "things", routes)["statusCode"] == 404


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
