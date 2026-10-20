"""判决 golden：锁住 `verify_answer` 的**实际**输出，不是期望输出。

为什么需要它：`test_verify.py` 断言"应该是什么"，改判决时最容易发生的事是
「顺手把别的条目也改了」而没人发现。golden 断言"现在是什么"，任何非目标条目的
漂移都会单独暴露出来。

因此两条纪律：
1. golden 永远记录**当前实际值**，包括当前判错的条目。它不表达褒贬，只表达现状。
2. 改 golden 必须是显式动作（`BAH_GOLDEN_UPDATE=1`），且 diff 行数应与目标条数一致。

`entailerCalls` 单独记录：它把"数字 claim 有没有咨询蕴含层"从隐性约定变成
可 diff 的观测量。数字 claim 的该值必须恒为 0。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from verdict_cases import CASES, VerdictCase, assert_unique_ids

from banking_rag.contract import Evidence
from banking_rag.verify import MARKER_RE, extract_numbers, verify_answer

GOLDEN_PATH = Path(__file__).parent / "golden" / "verdicts.json"
UPDATE_ENV = "BAH_GOLDEN_UPDATE"
FORMAT_VERSION = 1


class StubEntailer:
    """返回固定结论的蕴含层替身，并记录被调用次数。

    刻意**不**复刻真实 `Entailer` 的"含数字即返回 None"守卫——替身的作用就是把
    上层有没有真的去问蕴含层这件事暴露出来。若上层依赖下层的守卫来自律，
    换成这个替身就会现形。
    """

    def __init__(self, verdict: bool) -> None:
        self._verdict = verdict
        self.calls = 0

    @property
    def available(self) -> bool:
        return True

    def judge(self, claim: str, evidence_text: str) -> bool:
        self.calls += 1
        return self._verdict


def _project(case: VerdictCase) -> tuple[dict[str, Any], int]:
    evidence: list[Evidence] = list(case.evidence)
    entailer = None if case.entailer_verdict is None else StubEntailer(case.entailer_verdict)
    result = verify_answer(
        case.answer,
        evidence,
        case.cells,
        require_citations=case.require_citations,
        entailer=entailer,  # type: ignore[arg-type]
    )
    projected = {
        "verdict": result.verdict,
        "reasonCode": result.reason_code,
        "claims": [
            {
                "literal": claim.literal,
                "support": claim.support,
                "entailment": claim.entailment,
                "markers": claim.markers,
            }
            for claim in result.claims
        ],
        "numbers": [
            {
                "raw": number.raw,
                "unit": number.unit,
                "match": number.match,
                "source": number.source,
            }
            for number in result.numbers
        ],
    }
    return projected, (0 if entailer is None else entailer.calls)


def _collect() -> tuple[dict[str, Any], dict[str, int]]:
    projected: dict[str, Any] = {}
    calls: dict[str, int] = {}
    for case in CASES:
        body, entailer_calls = _project(case)
        projected[case.case_id] = body
        calls[case.case_id] = entailer_calls
    return projected, calls


def _dump(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def _load() -> dict[str, Any]:
    return json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))


def _mine() -> dict[str, Any]:
    projected, calls = _collect()
    return {
        "formatVersion": FORMAT_VERSION,
        "cases": projected,
        "entailerCalls": calls,
    }


def _summary(payload: dict[str, Any]) -> str:
    """把 golden 压成一行摘要，diff 报告只指认条目，不整片刷屏。"""

    lines: list[str] = []
    for case_id in sorted(payload["cases"]):
        body = payload["cases"][case_id]
        lines.append(
            f"{case_id}: {body['verdict']} / {body['reasonCode']} "
            f"(entailerCalls={payload['entailerCalls'][case_id]})"
        )
    return "\n".join(lines)


def test_case_ids_are_unique() -> None:
    assert_unique_ids()


def test_golden_matches_current_verdicts() -> None:
    assert_unique_ids()
    current = _mine()

    if os.environ.get(UPDATE_ENV) == "1":
        GOLDEN_PATH.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN_PATH.write_text(_dump(current), encoding="utf-8", newline="\n")
        return

    assert GOLDEN_PATH.exists(), (
        f"缺少 golden 基线：{GOLDEN_PATH}。"
        f"首次建立请用 {UPDATE_ENV}=1 生成，不要手写。"
    )

    baseline = _load()
    assert baseline["formatVersion"] == FORMAT_VERSION, (
        "golden 格式版本不符，需显式迁移而不是静默覆盖"
    )

    drifted = sorted(
        case_id
        for case_id in set(baseline["cases"]) | set(current["cases"])
        if baseline["cases"].get(case_id) != current["cases"].get(case_id)
        or baseline["entailerCalls"].get(case_id) != current["entailerCalls"].get(case_id)
    )
    assert drifted == [], (
        "判决 golden 出现漂移（非目标条目必须为 0）：\n"
        + "\n".join(drifted)
        + "\n\n--- 基线 ---\n"
        + _summary(baseline)
        + "\n\n--- 当前 ---\n"
        + _summary(current)
    )


def test_numeric_cases_never_consult_entailer() -> None:
    """数字 claim 不得咨询蕴含层；此断言独立于 golden，防止 golden 被一起刷掉。"""

    assert_unique_ids()
    _, calls = _collect()
    consulted = {
        case.case_id: calls[case.case_id]
        for case in CASES
        if case.entailer_verdict is not None and calls[case.case_id] > 0
    }
    # 必须按 verify.py 的口径判「是否数字 claim」：先剥离 `[K#]` 再提数值。
    # 直接扫描原文会把 `[K1]` 里的 "1" 当成数字，从而把对照项误判为 numeric。
    numeric = {
        case.case_id
        for case in CASES
        if case.entailer_verdict is not None
        and extract_numbers(MARKER_RE.sub("", case.answer))
    }
    offenders = {case_id: count for case_id, count in consulted.items() if case_id in numeric}
    assert offenders == {}, f"数字 claim 咨询了蕴含层：{offenders}"
