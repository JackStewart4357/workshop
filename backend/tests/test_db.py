"""Tests for the shared database helper."""

import psycopg
import pytest

import db
from conftest import load_fresh
from http_utils import ApiError


def test_conninfo_local_has_no_ssl(monkeypatch):
    monkeypatch.setattr(db, "IS_LOCAL", True)
    assert "sslmode" not in db.pg_conninfo()


def test_conninfo_cloud_requires_ssl(monkeypatch):
    monkeypatch.setattr(db, "IS_LOCAL", False)
    assert "sslmode=require" in db.pg_conninfo()


def test_ssl_is_required_unless_is_local_is_explicitly_true(monkeypatch):
    monkeypatch.delenv("IS_LOCAL")
    assert "sslmode=require" in load_fresh(db).pg_conninfo()


def test_conninfo_reads_the_injected_variables(monkeypatch):
    for name, value in {
        "POSTGRES_HOST": "db.example",
        "POSTGRES_PORT": "6543",
        "POSTGRES_USER": "svc",
        "POSTGRES_PASS": "s3cret",
        "POSTGRES_NAME": "incidents",
    }.items():
        monkeypatch.setenv(name, value)
    conninfo = db.pg_conninfo()
    for part in ("host=db.example", "port=6543", "user=svc", "password=s3cret", "dbname=incidents"):
        assert part in conninfo


def test_query_returns_the_first_row_as_a_dict():
    assert db.query("SELECT 1 AS one, 'x' AS letter") == {"one": 1, "letter": "x"}


def test_query_returns_none_when_no_rows_match():
    assert db.query("SELECT 1 AS one WHERE false") is None


def test_query_fetch_false_returns_none():
    assert db.query("SELECT 1 AS one", fetch=False) is None


def test_query_binds_parameters_safely():
    hostile = "x'; DROP TABLE users; --"
    assert db.query("SELECT %s AS value", (hostile,)) == {"value": hostile}
    assert db.query("SELECT count(*) AS n FROM users") == {"n": 0}


def test_query_commits_its_own_transaction():
    db.query(
        "INSERT INTO users (email, full_name, password_hash, role) VALUES (%s, %s, %s, %s)",
        ("commit@acme.inc", "C", "hash", "EMPLOYEE"),
        fetch=False,
    )
    with psycopg.connect(db.pg_conninfo()) as other:
        assert other.execute("SELECT count(*) FROM users").fetchone()[0] == 1


def test_failed_statement_rolls_back_and_the_connection_stays_usable():
    with pytest.raises(psycopg.Error):
        db.query("SELECT * FROM table_that_does_not_exist")
    assert db.query("SELECT 1 AS one") == {"one": 1}


def test_schema_constraint_errors_surface_to_the_caller():
    with pytest.raises(psycopg.errors.CheckViolation):
        db.query(
            "INSERT INTO users (email, full_name, password_hash, role) VALUES (%s, %s, %s, %s)",
            ("outsider@gmail.com", "O", "hash", "EMPLOYEE"),
            fetch=False,
        )


def test_query_reconnects_after_the_connection_is_closed():
    db.query("SELECT 1 AS one")
    db._conn.close()
    assert db.query("SELECT 1 AS one") == {"one": 1}


def test_connection_failure_is_raised_and_retried_next_time(monkeypatch):
    db.query("SELECT 1 AS one")
    db._conn.close()
    monkeypatch.setenv("POSTGRES_PORT", "1")  # nothing listens here
    monkeypatch.setenv("POSTGRES_HOST", "127.0.0.1")
    with pytest.raises(psycopg.OperationalError):
        db.query("SELECT 1 AS one")
    assert db._conn is None
    monkeypatch.undo()
    assert db.query("SELECT 1 AS one") == {"one": 1}


def kill_cached_connection():
    """Terminate the service's connection from the server side, as an idle timeout or an
    Aurora pause would. The client only finds out when it next uses the connection."""
    pid = db.query("SELECT pg_backend_pid() AS pid")["pid"]
    with psycopg.connect(db.pg_conninfo(), autocommit=True) as other:
        other.execute("SELECT pg_terminate_backend(%s)", (pid,))
    assert not db._conn.closed  # still looks healthy
    return pid


def test_query_survives_a_connection_dropped_by_the_server():
    old_pid = kill_cached_connection()
    assert db.query("SELECT pg_backend_pid() AS pid")["pid"] != old_pid


def test_write_is_applied_exactly_once_when_the_connection_was_dropped():
    kill_cached_connection()
    db.query(
        "INSERT INTO users (email, full_name, password_hash, role) VALUES (%s, %s, %s, %s)",
        ("once@acme.inc", "Once", "hash", "EMPLOYEE"),
        fetch=False,
    )
    assert db.query("SELECT count(*) AS n FROM users")["n"] == 1


def test_dropped_connection_with_the_database_still_down_raises(monkeypatch):
    kill_cached_connection()
    monkeypatch.setenv("POSTGRES_HOST", "127.0.0.1")
    monkeypatch.setenv("POSTGRES_PORT", "1")
    with pytest.raises(psycopg.OperationalError):
        db.query("SELECT 1 AS one")
    assert db._conn is None
    monkeypatch.undo()
    assert db.query("SELECT 1 AS one") == {"one": 1}


def test_statement_level_operational_error_is_not_retried():
    """A cancelled or timed-out statement is an OperationalError on a healthy connection:
    it must be reported, not silently run a second time."""
    db.query("CREATE SEQUENCE attempts", fetch=False)
    try:
        connection = db._conn
        with pytest.raises(psycopg.errors.QueryCanceled):
            db.query(
                "DO $$ BEGIN PERFORM nextval('attempts'); RAISE EXCEPTION 'cancelled' USING ERRCODE = '57014'; END $$",
                fetch=False,
            )
        assert db._conn is connection  # same connection, still usable
        # nextval is never rolled back, so the sequence counts how often the statement ran
        assert db.query("SELECT last_value, is_called FROM attempts") == {"last_value": 1, "is_called": True}
    finally:
        db.query("DROP SEQUENCE attempts", fetch=False)


def test_error_while_connecting_is_reported_as_itself(monkeypatch):
    """A failure before any connection exists must surface as the real error."""
    db._conn.close()

    def refuse(*_args, **_kwargs):
        raise psycopg.ProgrammingError("invalid connection option")

    monkeypatch.setattr(psycopg, "connect", refuse)
    with pytest.raises(psycopg.ProgrammingError, match="invalid connection option"):
        db.query("SELECT 1 AS one")
    monkeypatch.undo()
    assert db.query("SELECT 1 AS one") == {"one": 1}


def test_discarding_a_connection_tolerates_a_failing_close(monkeypatch):
    db.query("SELECT 1 AS one")

    class Stuck:
        closed = False
        broken = True

        def close(self):
            raise psycopg.OperationalError("already gone")

    monkeypatch.setattr(db, "_conn", Stuck())
    db._discard()
    assert db._conn is None
    assert db.query("SELECT 1 AS one") == {"one": 1}


def test_connection_that_cannot_be_rolled_back_is_never_reused():
    """A statement that leaves the connection mid-command must not poison later calls,
    and the caller must see the real error."""
    with pytest.raises(psycopg.ProgrammingError, match="COPY"):
        db.query("COPY users TO STDOUT", fetch=False)
    assert db.query("SELECT 1 AS one") == {"one": 1}


def test_interrupted_write_is_not_committed_by_the_next_query(monkeypatch):
    """An interrupt between execute and commit must discard the transaction, not leave
    it open for an unrelated later statement to commit."""
    connection = db._connection()

    def interrupted():
        raise KeyboardInterrupt

    monkeypatch.setattr(connection, "commit", interrupted, raising=False)
    with pytest.raises(KeyboardInterrupt):
        db.query(
            "INSERT INTO users (email, full_name, password_hash, role) VALUES (%s, %s, %s, %s)",
            ("ghost@acme.inc", "Ghost", "hash", "EMPLOYEE"),
            fetch=False,
        )
    assert db._conn is None
    assert db.query("SELECT count(*) AS n FROM users")["n"] == 0


# ---------------------------------------------------------------------------
# query_all
# ---------------------------------------------------------------------------


def test_query_all_returns_every_row_in_order():
    rows = db.query_all("SELECT n FROM generate_series(1, 3) AS n ORDER BY n DESC")
    assert rows == [{"n": 3}, {"n": 2}, {"n": 1}]


def test_query_all_binds_parameters():
    assert db.query_all("SELECT n FROM generate_series(1, %s) AS n", (2,)) == [{"n": 1}, {"n": 2}]


@pytest.mark.parametrize("sql", ["SELECT 1 AS one WHERE false", "SET LOCAL statement_timeout = 0"])
def test_query_all_is_an_empty_list_when_there_is_nothing_to_return(sql):
    assert db.query_all(sql) == []


# ---------------------------------------------------------------------------
# transaction
# ---------------------------------------------------------------------------

ADD_USER = "INSERT INTO users (email, full_name, password_hash, role) VALUES (%s, 'T', 'hash', 'EMPLOYEE')"


def user_count():
    return db.query("SELECT count(*) AS n FROM users")["n"]


def test_transaction_saves_every_statement_together():
    with db.transaction():
        db.query(ADD_USER, ("one@acme.inc",), fetch=False)
        with psycopg.connect(db.pg_conninfo()) as other:  # not visible to anyone else yet
            assert other.execute("SELECT count(*) FROM users").fetchone()[0] == 0
        assert db.query(ADD_USER + " RETURNING email", ("two@acme.inc",)) == {"email": "two@acme.inc"}
    with psycopg.connect(db.pg_conninfo()) as other:
        assert other.execute("SELECT count(*) FROM users").fetchone()[0] == 2


def test_transaction_saves_nothing_when_a_statement_fails():
    with pytest.raises(psycopg.errors.UniqueViolation):
        with db.transaction():
            db.query(ADD_USER, ("one@acme.inc",), fetch=False)
            db.query(ADD_USER, ("one@acme.inc",), fetch=False)
    assert user_count() == 0


def test_transaction_saves_nothing_when_the_endpoint_raises():
    with pytest.raises(ApiError):
        with db.transaction():
            db.query(ADD_USER, ("one@acme.inc",), fetch=False)
            raise ApiError(409, "conflict", "Changed by someone else")
    assert user_count() == 0


def test_statements_after_a_transaction_commit_on_their_own_again():
    with db.transaction():
        db.query(ADD_USER, ("one@acme.inc",), fetch=False)
    with pytest.raises(RuntimeError):
        with db.transaction():
            raise RuntimeError("endpoint bug")
    db.query(ADD_USER, ("two@acme.inc",), fetch=False)
    with psycopg.connect(db.pg_conninfo()) as other:
        assert other.execute("SELECT count(*) FROM users").fetchone()[0] == 2


def test_a_statement_that_failed_inside_a_transaction_cannot_be_ignored():
    """Catching the error and carrying on must not save half of the block."""
    with pytest.raises(psycopg.errors.InFailedSqlTransaction):
        with db.transaction():
            db.query(ADD_USER, ("one@acme.inc",), fetch=False)
            with pytest.raises(psycopg.errors.UniqueViolation):
                db.query(ADD_USER, ("one@acme.inc",), fetch=False)
            db.query(ADD_USER, ("two@acme.inc",), fetch=False)
    assert user_count() == 0


def test_a_failed_last_statement_that_was_caught_is_still_reported():
    """Otherwise the block would end normally and the endpoint would answer "saved"."""
    with pytest.raises(RuntimeError, match="nothing was saved"):
        with db.transaction():
            db.query(ADD_USER, ("one@acme.inc",), fetch=False)
            with pytest.raises(psycopg.errors.UniqueViolation):
                db.query(ADD_USER, ("one@acme.inc",), fetch=False)
    assert user_count() == 0


def test_connection_lost_inside_a_transaction_and_caught_does_not_save_the_later_half():
    with pytest.raises(psycopg.OperationalError):
        with db.transaction():
            db.query(ADD_USER, ("one@acme.inc",), fetch=False)
            with psycopg.connect(db.pg_conninfo(), autocommit=True) as other:
                other.execute("SELECT pg_terminate_backend(%s)", (db._conn.info.backend_pid,))
            with pytest.raises(psycopg.OperationalError):
                db.query(ADD_USER, ("two@acme.inc",), fetch=False)
            db.query(ADD_USER, ("three@acme.inc",), fetch=False)
    assert db._conn.info.transaction_status == psycopg.pq.TransactionStatus.IDLE
    assert user_count() == 0


def test_transactions_cannot_be_nested():
    with db.transaction():
        db.query(ADD_USER, ("one@acme.inc",), fetch=False)
        with pytest.raises(RuntimeError, match="nested"):
            with db.transaction():
                pass  # pragma: no cover - never entered
        db.query(ADD_USER, ("two@acme.inc",), fetch=False)
        with psycopg.connect(db.pg_conninfo()) as other:  # still one unsaved unit
            assert other.execute("SELECT count(*) FROM users").fetchone()[0] == 0
        assert len(db.query_all("SELECT email FROM users")) == 2  # lists work inside a block too
    assert user_count() == 2  # the outer block was not disturbed


def test_transaction_starts_on_a_live_connection_after_the_server_dropped_it():
    old_pid = kill_cached_connection()
    with db.transaction():
        assert db.query("SELECT pg_backend_pid() AS pid")["pid"] != old_pid
        db.query(ADD_USER, ("one@acme.inc",), fetch=False)
    assert user_count() == 1


def test_connection_lost_inside_a_transaction_is_not_retried():
    """Retrying on a new connection would save the later statements without the earlier ones."""
    with pytest.raises(psycopg.OperationalError):
        with db.transaction():
            db.query(ADD_USER, ("one@acme.inc",), fetch=False)
            with psycopg.connect(db.pg_conninfo(), autocommit=True) as other:
                other.execute("SELECT pg_terminate_backend(%s)", (db._conn.info.backend_pid,))
            db.query(ADD_USER, ("two@acme.inc",), fetch=False)
    assert db._conn is None
    assert user_count() == 0


def test_interrupted_transaction_is_not_committed_by_the_next_query():
    with pytest.raises(KeyboardInterrupt):
        with db.transaction():
            db.query(ADD_USER, ("one@acme.inc",), fetch=False)
            raise KeyboardInterrupt
    assert db._conn is None
    assert user_count() == 0


def test_failed_commit_is_reported_and_saves_nothing(monkeypatch):
    connection = db._connection()

    def refuse():
        raise psycopg.OperationalError("connection lost at commit")

    with pytest.raises(psycopg.OperationalError, match="at commit"):
        with db.transaction():
            db.query(ADD_USER, ("one@acme.inc",), fetch=False)
            monkeypatch.setattr(connection, "commit", refuse, raising=False)
    monkeypatch.undo()
    assert user_count() == 0
