"""Shared test setup.

Tests run against a real PostgreSQL, inside a throwaway schema that is created from
backend/_db/schema.sql at the start of the run and dropped at the end. The connection's
search_path is pinned to that schema, so the tests can never touch the application's
own tables. Connection settings come from the same POSTGRES_* variables the services
use, defaulting to the local development database.
"""

import base64
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import uuid

import pytest

BACKEND_DIR = pathlib.Path(__file__).resolve().parents[1]
TEST_SCHEMA = f"test_{uuid.uuid4().hex[:12]}"

# The tests import backend/_shared directly, but a running or deployed Lambda imports the
# copy inside its own folder. Refresh the copies first so the two can never drift apart.
subprocess.run([str(BACKEND_DIR.parent / "bin" / "sync-shared.sh")], check=True, stdout=subprocess.DEVNULL)

# The shared modules read their settings at import time, so set these first.
os.environ["IS_LOCAL"] = "true"
os.environ["BCRYPT_ROUNDS"] = "4"  # minimum cost: keeps the suite fast
os.environ["PGOPTIONS"] = f"-csearch_path={TEST_SCHEMA}"
os.environ.pop("JWT_SECRET", None)

import db  # noqa: E402
import psycopg  # noqa: E402
import security  # noqa: E402


def load_service(name):
    """Import backend/<name>/function.py under a unique module name.

    Every service's entry point is called function.py, so they cannot all be imported
    as 'function'.
    """
    module_name = f"{name}_function"
    if module_name in sys.modules:
        return sys.modules[module_name]
    spec = importlib.util.spec_from_file_location(module_name, BACKEND_DIR / name / "function.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def load_fresh(module):
    """A second copy of a shared module, so its import-time settings can be tested
    without disturbing the copy every other test (and the services) use."""
    spec = importlib.util.spec_from_file_location(f"{module.__name__}_fresh", module.__file__)
    fresh = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fresh)
    return fresh


def make_event(method="GET", path="/", body=None, token=None, headers=None, raw_body=None, base64_body=False):
    """Build a Lambda Function URL (payload v2) event."""
    headers = dict(headers or {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    payload = raw_body if raw_body is not None else (json.dumps(body) if body is not None else None)
    if base64_body and payload is not None:
        payload = base64.b64encode(payload.encode()).decode()
    return {
        "requestContext": {"http": {"method": method}},
        "rawPath": path,
        "headers": headers,
        "body": payload,
        "isBase64Encoded": base64_body,
    }


def invoke(service, method="GET", path="/", **kwargs):
    """Call a service's handler and return (status, parsed JSON body or None)."""
    response = service.handler(make_event(method, path, **kwargs), None)
    assert set(response) == {"statusCode", "headers", "body"}
    body = json.loads(response["body"]) if response["body"] else None
    return response["statusCode"], body


@pytest.fixture(scope="session", autouse=True)
def database():
    """Create the throwaway schema from schema.sql; drop it when the run ends."""
    try:
        admin = psycopg.connect(db.pg_conninfo(), autocommit=True)
    except psycopg.OperationalError as error:
        pytest.exit(f"PostgreSQL is not reachable ({error}). Start it with ./bin/start-dev.sh", returncode=2)
    try:
        # The search_path names a schema that must not exist yet: if this is not None the
        # connection is pointing somewhere real and nothing below may run.
        if admin.execute("SELECT current_schema()").fetchone()[0] is not None:
            pytest.exit("Test connection is not isolated from existing schemas; refusing to run", returncode=2)
        admin.execute(f'CREATE SCHEMA "{TEST_SCHEMA}"')
        admin.execute((BACKEND_DIR / "_db" / "schema.sql").read_text())
        if db.query("SELECT current_schema() AS name")["name"] != TEST_SCHEMA:
            pytest.exit("Services are not connected to the throwaway schema; refusing to run", returncode=2)
        yield
    finally:
        if db._conn is not None and not db._conn.closed:
            db._conn.close()
        db._conn = None
        if not admin.closed:
            admin.rollback()
            admin.execute(f'DROP SCHEMA IF EXISTS "{TEST_SCHEMA}" CASCADE')
            admin.close()


@pytest.fixture(autouse=True)
def clean_state(database):
    """Every test starts with empty user tables and no cached signing key."""
    db.query("TRUNCATE users, app_secrets CASCADE", fetch=False)
    security._jwt_secret = ""
    yield


@pytest.fixture(scope="session")
def auth_service():
    return load_service("auth")


@pytest.fixture
def auth(auth_service):
    """The auth service with its one-time setup reset, as on a cold start."""
    auth_service._ready = False
    return auth_service
