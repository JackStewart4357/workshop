"""PostgreSQL access: one connection reused across warm Lambda invocations."""

import os
from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row

IS_LOCAL = os.getenv("IS_LOCAL", "false") == "true"

_conn = None
_in_transaction = False


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
        if not (fetch and cur.description):
            return None
        return cur.fetchall() if fetch == "all" else cur.fetchone()


def _undo(error):
    """Roll back after a failure. Never reuse a connection that is lost, that was interrupted
    mid-statement, or that cannot be rolled back: a half-finished transaction must not leak
    into the next call."""
    if _connection_lost() or not isinstance(error, Exception):
        _discard()
    else:
        try:
            _conn.rollback()
        except psycopg.Error:
            _discard()


def query(sql, params=None, fetch=True):
    """Run one statement in its own transaction and return the first row (or None).

    Rows come back as dicts. Pass fetch=False for statements whose result is not needed.
    Inside a transaction() block the statement joins that block instead.
    """
    if _in_transaction:
        return _execute(sql, params, fetch)  # transaction() saves or undoes the whole block
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
    except BaseException as error:
        _undo(error)
        raise


def query_all(sql, params=None):
    """Like query(), but returns every row as a list (empty when nothing matches)."""
    return query(sql, params, fetch="all") or []


@contextmanager
def transaction():
    """Make every query() in the block one unit: all of them are saved, or none if one fails.

        with transaction():
            query("UPDATE incidents SET status = ...")
            query("INSERT INTO incident_status_history ...")
    """
    global _in_transaction
    if _in_transaction:
        raise RuntimeError("transaction() blocks cannot be nested")
    # Replace a dead cached connection now. Once the block has started a statement cannot be
    # retried on a new connection, because the earlier ones would be missing from it.
    query("SELECT 1", fetch=False)
    connection = _conn
    _in_transaction = True
    try:
        yield
        # A statement error the block caught has already undone it: COMMIT would only roll back.
        if connection.info.transaction_status == psycopg.pq.TransactionStatus.INERROR:
            raise RuntimeError("a statement failed inside transaction(): nothing was saved")
        connection.commit()  # the one the block started on, never a replacement
    except BaseException as error:
        _undo(error)
        raise
    finally:
        _in_transaction = False
