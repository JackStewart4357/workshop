"""
Database setup: applies schema.sql to the database this Lambda is connected to.

Aurora only accepts connections from inside its VPC, so the schema cannot be loaded with
psql from a workstation the way it is locally. bin/deploy-backend.sh invokes this function
directly (aws lambda invoke) after every AWS deploy. HTTP requests are refused, so the
schema cannot be applied through the function's public URL.

schema.sql beside this file is a copy of backend/_db/schema.sql made by bin/sync-shared.sh.
"""

from pathlib import Path

import psycopg

from db import pg_conninfo
from http_utils import ApiError, respond_error

SCHEMA_FILE = Path(__file__).with_name("schema.sql")


def handler(event=None, context=None):
    """Lambda entry point. A direct invoke has no requestContext; a Function URL call does."""
    if (event or {}).get("requestContext"):
        return respond_error(ApiError(404, "not_found", "Not found"))
    # schema.sql carries its own BEGIN/COMMIT, so it is applied completely or not at all,
    # and it only creates what is missing, so running it again is safe.
    with psycopg.connect(pg_conninfo(), autocommit=True) as conn:
        conn.execute(SCHEMA_FILE.read_text(encoding="utf-8"))
    return {"applied": SCHEMA_FILE.name}
