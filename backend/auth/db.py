"""PostgreSQL access: one connection reused across warm Lambda invocations."""

import os

import psycopg
from psycopg.rows import dict_row

IS_LOCAL = os.getenv("IS_LOCAL", "false") == "true"

_conn = None


def pg_conninfo():
    """Connection string from the injected variables. Aurora requires SSL; local has none."""
    parts = {
        "host": os.getenv("POSTGRES_HOST", "localhost"),
        "port": os.getenv("POSTGRES_PORT", "5432"),
        "user": os.getenv("POSTGRES_USER", "postgres"),
        "password": os.getenv("POSTGRES_PASS", "postgres123"),
        "dbname": os.getenv("POSTGRES_NAME", "postgres"),
        "connect_timeout": "15",
    }
    if not IS_LOCAL:
        parts["sslmode"] = "require"
    return " ".join(f"{key}={value}" for key, value in parts.items())


def query(sql, params=None, fetch=True):
    """Run one statement in its own transaction and return the first row (or None).

    Rows come back as dicts. Pass fetch=False for statements whose result is not needed.
    """
    global _conn
    try:
        if _conn is None or _conn.closed:
            _conn = psycopg.connect(pg_conninfo(), row_factory=dict_row)
        with _conn.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone() if fetch and cur.description else None
        _conn.commit()
        return row
    except psycopg.OperationalError:
        _conn = None  # broken connection: reconnect on the next call
        raise
    except Exception:
        _conn.rollback()
        raise
