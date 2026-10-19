"""检索级熔断（R12 骨架版）。

会话级、内存态：连续 N 次 RED → 锁定 M 分钟。重启即清空（骨架取舍）；
持久化版本应落 SQLite 并在启动时恢复，见设计稿 §5.1.6 AT-23。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable

from .config import BREAKER_LOCK_SECONDS, BREAKER_THRESHOLD


@dataclass
class _State:
    consecutive_red: int = 0
    locked_until: float = 0.0
    last_reason: str | None = None


@dataclass
class Breaker:
    threshold: int = BREAKER_THRESHOLD
    lock_seconds: int = BREAKER_LOCK_SECONDS
    clock: Callable[[], float] = time.time
    states: dict[str, _State] = field(default_factory=dict)

    def is_locked(self, session_id: str) -> bool:
        state = self.states.get(session_id)
        if state is None:
            return False
        if state.locked_until <= self.clock():
            if state.locked_until > 0:
                self.states[session_id] = _State()
            return False
        return True

    def record(self, session_id: str, verdict: str, reason_code: str | None = None) -> bool:
        """记录一次终态；返回本次是否触发锁定。"""

        state = self.states.setdefault(session_id, _State())
        if verdict == "RED":
            state.consecutive_red += 1
            state.last_reason = reason_code
            if state.consecutive_red >= self.threshold:
                state.locked_until = self.clock() + self.lock_seconds
                return True
        elif verdict in {"GREEN", "AMBER_INFERRED", "AMBER_DISAMBIGUATION"}:
            state.consecutive_red = 0
        return False

    def reset(self, session_id: str) -> None:
        self.states.pop(session_id, None)
