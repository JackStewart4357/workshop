"""dbsetup: applies schema.sql on a direct invoke and refuses HTTP requests."""

import psycopg
import pytest

import db
from conftest import BACKEND_DIR, invoke, load_service


@pytest.fixture(scope="session")
def dbsetup():
    return load_service("dbsetup")


def table_exists(name):
    return db.query("SELECT to_regclass(%s) IS NOT NULL AS found", (name,))["found"]


def test_packaged_schema_is_the_real_schema(dbsetup):
    # Only the service folder is zipped into the Lambda, so the file must live inside it.
    assert dbsetup.SCHEMA_FILE == BACKEND_DIR / "dbsetup" / "schema.sql"
    assert dbsetup.SCHEMA_FILE.read_text() == (BACKEND_DIR / "_db" / "schema.sql").read_text()


def test_direct_invoke_creates_what_is_missing(dbsetup):
    db.query("DROP TABLE ai_suggestions", fetch=False)
    assert not table_exists("ai_suggestions")

    assert dbsetup.handler({}, None) == {"applied": ["schema.sql"]}

    assert table_exists("ai_suggestions")


def test_applying_again_keeps_existing_data(dbsetup):
    db.query(
        "INSERT INTO users (email, full_name, password_hash, role) VALUES ('kept@acme.inc', 'Kept', 'x', 'EMPLOYEE')",
        fetch=False,
    )
    categories = db.query("SELECT count(*) AS total FROM categories")["total"]

    assert dbsetup.handler() == {"applied": ["schema.sql"]}

    assert db.query("SELECT count(*) AS total FROM users")["total"] == 1
    assert db.query("SELECT count(*) AS total FROM categories")["total"] == categories


def test_packaged_demo_data_is_the_real_demo_data(dbsetup):
    assert dbsetup.SEED_FILE == BACKEND_DIR / "dbsetup" / "seed.sql"
    assert dbsetup.SEED_FILE.read_text() == (BACKEND_DIR / "_db" / "seed.sql").read_text()


def demo_rows():
    return db.query(
        "SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM users WHERE role = 'ADMIN') AS admins, "
        "(SELECT count(*) FROM engineer_profiles WHERE manager_id IS NOT NULL) AS managed_engineers, "
        "(SELECT count(*) FROM buildings) AS buildings, (SELECT count(*) FROM incidents) AS incidents"
    )


def test_the_demo_data_is_loaded_only_when_asked_for_and_loading_it_again_changes_nothing(dbsetup):
    assert dbsetup.handler({"seed": False}, None) == {"applied": ["schema.sql"]}
    assert demo_rows()["users"] == 0

    assert dbsetup.handler({"seed": True}, None) == {"applied": ["schema.sql", "seed.sql"]}
    loaded = demo_rows()
    assert loaded == {"users": 9, "admins": 2, "managed_engineers": 3, "buildings": 2, "incidents": 12}

    assert dbsetup.handler({"seed": True}, None) == {"applied": ["schema.sql", "seed.sql"]}
    assert demo_rows() == loaded


def test_the_demo_data_loads_over_an_admin_the_app_created_first_and_keeps_their_password(dbsetup):
    # The auth service creates admin@acme.inc, with an id of its own, the first time the app is opened
    db.query(
        "INSERT INTO users (email, full_name, password_hash, role) VALUES ('admin@acme.inc', 'Facility Admin', 'their-own', 'ADMIN')",
        fetch=False,
    )
    assert dbsetup.handler({"seed": True}, None) == {"applied": ["schema.sql", "seed.sql"]}
    assert demo_rows() == {"users": 9, "admins": 2, "managed_engineers": 3, "buildings": 2, "incidents": 12}
    admin = db.query("SELECT id, password_hash FROM users WHERE email = 'admin@acme.inc'")
    assert (str(admin["id"]), admin["password_hash"]) == ("10000000-0000-4000-8000-000000000001", "their-own")


def test_a_failing_schema_is_not_half_applied(dbsetup, monkeypatch, tmp_path):
    broken = tmp_path / "schema.sql"
    broken.write_text("BEGIN; CREATE TABLE half_applied (id INT); SELECT 1 / 0; COMMIT;")
    monkeypatch.setattr(dbsetup, "SCHEMA_FILE", broken)

    with pytest.raises(psycopg.Error):
        dbsetup.handler({}, None)

    assert not table_exists("half_applied")


def test_http_requests_are_refused_without_touching_the_database(dbsetup, monkeypatch):
    def no_database(*args, **kwargs):
        raise AssertionError("an HTTP request must not reach the database")

    monkeypatch.setattr(dbsetup.psycopg, "connect", no_database)

    for method in ("GET", "POST"):
        status, body = invoke(dbsetup, method, "/")
        assert status == 404
        assert body["error"]["code"] == "not_found"
