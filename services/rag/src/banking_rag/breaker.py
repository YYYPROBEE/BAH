"""检索级熔断（R12）：会话级、SQLite 持久化。

规则（设计稿 §6.4）：
- 连续 3 次 RED → 锁定 15 分钟；
- 10 分钟内 2 次注入特征命中 → 同样锁定；
- 锁定期内该会话的检索一律 LOCKED，转人工接管；
- 只能由人工控制台复位，复位动作写 breaker_log。

持久化的意义：进程重启/崩溃不再清空锁定状态（骨架版的已知缺口）。
`injection_hit` 由上游 sentry 判定后透传（RAG 不重复建检测器，单一属主原则）。
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass

from .config import (
    BREAKER_LOCK_SECONDS,
    BREAKER_THRESHOLD,
    INJECTION_THRESHOLD,
    INJECTION_WINDOW_SECONDS,
)


@dataclass(frozen=True)
class BreakerState:
    session_id: str
    consecutive_red: int
    injection_hits: int
    injection_window_start: float
    locked_until: float
    last_reason: str | None

    @property
    def locked(self) -> bool:
        return self.locked_until > 0


@dataclass(frozen=True)
class BreakerEvent:
    event: str
    session_id: str
    reason: str | None
    locked_until: float


@dataclass
class Breaker:
    threshold: int = BREAKER_THRESHOLD
    lock_seconds: int = BREAKER_LOCK_SECONDS
    injection_threshold: int = INJECTION_THRESHOLD
    injection_window_seconds: int = INJECTION_WINDOW_SECONDS
    clock: Callable[[], float] = time.time

    # ── 读 ────────────────────────────────────────────────────────────────
    def state(self, conn, session_id: str) -> BreakerState:
        row = conn.execute(
            """
            SELECT session_id, consecutive_red, injection_hits,
                   injection_window_start, locked_until, last_reason
            FROM breaker_state WHERE session_id = ?
            """,
            (session_id,),
        ).fetchone()
        if row is None:
            return BreakerState(session_id, 0, 0, 0.0, 0.0, None)
        return BreakerState(
            session_id=str(row["session_id"]),
            consecutive_red=int(row["consecutive_red"]),
            injection_hits=int(row["injection_hits"]),
            injection_window_start=float(row["injection_window_start"]),
            locked_until=float(row["locked_until"]),
            last_reason=row["last_reason"],
        )

    def is_locked(self, conn, session_id: str) -> bool:
        state = self.state(conn, session_id)
        if state.locked_until <= 0:
            return False
        if state.locked_until > self.clock():
            return True
        # 自然到期：清零并留痕（审计可回放"何时解锁"）。
        self._write(
            conn,
            session_id,
            consecutive_red=0,
            injection_hits=0,
            injection_window_start=0.0,
            locked_until=0.0,
            last_reason=state.last_reason,
        )
        self._log(conn, session_id, "UNLOCK_EXPIRED", state.last_reason, "system", 0.0)
        return False

    def status(self, conn, session_id: str) -> str:
        return "LOCKED" if self.is_locked(conn, session_id) else "CLOSED"

    # ── 写 ────────────────────────────────────────────────────────────────
    def record(
        self,
        conn,
        session_id: str,
        verdict: str,
        reason_code: str | None = None,
        *,
        injection_hit: bool = False,
    ) -> BreakerEvent | None:
        """记录一次终态；返回本次触发的锁定事件（未触发则 None）。"""

        now = self.clock()
        state = self.state(conn, session_id)

        if state.locked_until > now:
            # 锁定期内不再累计，避免重试延长锁定（AT-22：施压/重试无效）。
            return None

        consecutive = state.consecutive_red
        if verdict == "RED":
            consecutive += 1
        elif verdict in {"GREEN", "AMBER_INFERRED", "AMBER_DISAMBIGUATION"}:
            consecutive = 0

        hits = state.injection_hits
        window_start = state.injection_window_start
        if injection_hit:
            if window_start <= 0 or now - window_start > self.injection_window_seconds:
                window_start = now
                hits = 1
            else:
                hits += 1

        locked_until = 0.0
        event: BreakerEvent | None = None
        if consecutive >= self.threshold or hits >= self.injection_threshold:
            locked_until = now + self.lock_seconds
            event = BreakerEvent("LOCKED", session_id, reason_code, locked_until)

        self._write(
            conn,
            session_id,
            consecutive_red=consecutive,
            injection_hits=hits,
            injection_window_start=window_start,
            locked_until=locked_until,
            last_reason=reason_code if reason_code else state.last_reason,
        )
        if event is not None:
            self._log(conn, session_id, "LOCKED", reason_code, "breaker", locked_until)
        return event

    def reset(self, conn, session_id: str, actor: str = "console") -> bool:
        """人工复位（唯一解锁路径）；返回是否确实解除了一次锁定。"""

        state = self.state(conn, session_id)
        if state.locked_until <= 0 and state.consecutive_red == 0 and state.injection_hits == 0:
            return False
        self._write(
            conn,
            session_id,
            consecutive_red=0,
            injection_hits=0,
            injection_window_start=0.0,
            locked_until=0.0,
            last_reason=None,
        )
        self._log(conn, session_id, "RESET", state.last_reason, actor, 0.0)
        return True

    # ── 内部 ──────────────────────────────────────────────────────────────
    @staticmethod
    def _write(
        conn,
        session_id: str,
        *,
        consecutive_red: int,
        injection_hits: int,
        injection_window_start: float,
        locked_until: float,
        last_reason: str | None,
    ) -> None:
        conn.execute(
            """
            INSERT INTO breaker_state (
              session_id, consecutive_red, injection_hits, injection_window_start,
              locked_until, last_reason, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              consecutive_red=excluded.consecutive_red,
              injection_hits=excluded.injection_hits,
              injection_window_start=excluded.injection_window_start,
              locked_until=excluded.locked_until,
              last_reason=excluded.last_reason,
              updated_at=excluded.updated_at
            """,
            (
                session_id,
                consecutive_red,
                injection_hits,
                injection_window_start,
                locked_until,
                last_reason,
                time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            ),
        )
        conn.commit()

    @staticmethod
    def _log(
        conn,
        session_id: str,
        event: str,
        reason: str | None,
        actor: str,
        locked_until: float,
    ) -> None:
        conn.execute(
            """
            INSERT INTO breaker_log (
              session_id, event, reason, actor, locked_until, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                event,
                reason,
                actor,
                locked_until,
                time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            ),
        )
        conn.commit()
