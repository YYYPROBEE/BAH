from __future__ import annotations

import sqlite3
from pathlib import Path

from banking_rag.breaker import Breaker
from banking_rag.store import SCHEMA


def make_conn(db: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def test_three_red_locks_and_persists_across_connections(tmp_path: Path) -> None:
    db = tmp_path / "breaker.sqlite"
    conn = make_conn(db)
    breaker = Breaker(clock=lambda: 1000.0)
    event = None
    for _ in range(3):
        event = breaker.record(conn, "s-1", "RED", "SCOPE_EMPTY")
    assert event is not None and event.event == "LOCKED"
    conn.close()

    conn2 = make_conn(db)
    assert Breaker(clock=lambda: 1001.0).is_locked(conn2, "s-1") is True
    state = Breaker(clock=lambda: 1001.0).state(conn2, "s-1")
    assert state.consecutive_red == 3
    assert state.last_reason == "SCOPE_EMPTY"
    conn2.close()


def test_green_resets_consecutive_red_but_not_lock(tmp_path: Path) -> None:
    conn = make_conn(tmp_path / "breaker.sqlite")
    breaker = Breaker(clock=lambda: 1000.0)
    breaker.record(conn, "s-1", "RED", "EMPTY_RETRIEVAL")
    breaker.record(conn, "s-1", "RED", "EMPTY_RETRIEVAL")
    breaker.record(conn, "s-1", "GREEN")
    assert breaker.state(conn, "s-1").consecutive_red == 0
    assert breaker.is_locked(conn, "s-1") is False


def test_lock_expires_and_is_audited(tmp_path: Path) -> None:
    now = [1000.0]
    conn = make_conn(tmp_path / "breaker.sqlite")
    breaker = Breaker(clock=lambda: now[0], lock_seconds=10)
    for _ in range(3):
        breaker.record(conn, "s-1", "RED", "SCOPE_EMPTY")
    assert breaker.is_locked(conn, "s-1") is True

    now[0] = 1020.0
    assert breaker.is_locked(conn, "s-1") is False
    events = [row["event"] for row in conn.execute("SELECT event FROM breaker_log")]
    assert "LOCKED" in events and "UNLOCK_EXPIRED" in events


def test_manual_reset_is_the_only_unlock_path(tmp_path: Path) -> None:
    conn = make_conn(tmp_path / "breaker.sqlite")
    breaker = Breaker(clock=lambda: 1000.0)
    for _ in range(3):
        breaker.record(conn, "s-1", "RED", "SCOPE_EMPTY")
    assert breaker.is_locked(conn, "s-1") is True

    assert breaker.reset(conn, "s-1", actor="console") is True
    assert breaker.is_locked(conn, "s-1") is False
    events = [row["event"] for row in conn.execute("SELECT event FROM breaker_log")]
    assert "RESET" in events


def test_injection_hits_lock_within_window(tmp_path: Path) -> None:
    conn = make_conn(tmp_path / "breaker.sqlite")
    breaker = Breaker(clock=lambda: 1000.0)
    first = breaker.record(conn, "s-2", "GREEN", None, injection_hit=True)
    second = breaker.record(conn, "s-2", "GREEN", None, injection_hit=True)
    assert first is None
    assert second is not None and second.event == "LOCKED"


def test_retries_inside_lock_do_not_extend_it(tmp_path: Path) -> None:
    conn = make_conn(tmp_path / "breaker.sqlite")
    breaker = Breaker(clock=lambda: 1000.0, lock_seconds=10)
    for _ in range(3):
        breaker.record(conn, "s-1", "RED", "SCOPE_EMPTY")
    locked_until = breaker.state(conn, "s-1").locked_until
    for _ in range(5):
        breaker.record(conn, "s-1", "RED", "SCOPE_EMPTY")
    assert breaker.state(conn, "s-1").locked_until == locked_until
