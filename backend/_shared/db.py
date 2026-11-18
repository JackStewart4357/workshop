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


def _connection():
    global _conn
    if _conn is None or _conn.closed:
        _conn = psycopg.connect(pg_conninfo(), row_factory=dict_row)
    return _conn


def _connection_lost():
    return _conn is None or _conn.closed or _conn.broken


def _discard():
    """Forget the cached connection so the next call opens a new one."""
    global _conn
    if _conn is not None:
        try:
            _conn.close()
        except psycopg.Error:
            pass
    _conn = None


def _execute(sql, params, fetch):
    with _connection().cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchone() if fetch and cur.description else None


def query(sql, params=None, fetch=True):
    """Run one statement in its own transaction and return the first row (or None).

    Rows come back as dicts. Pass fetch=False for statements whose result is not needed.
    """
    reused = _conn is not None and not _conn.closed
    try:
        try:
            row = _execute(sql, params, fetch)
        except psycopg.OperationalError:
            # A cached connection can die while the Lambda is frozen or Aurora is paused,
            # and that only shows on first use. Nothing was applied, so retry once on a
            # fresh connection instead of failing the request.
            if not (reused and _connection_lost()):
                raise
            _discard()
            row = _execute(sql, params, fetch)
        _conn.commit()
        return row
    except Exception:
        if _connection_lost():
            _discard()  # reconnect on the next call
        else:
            _conn.rollback()
        raise
