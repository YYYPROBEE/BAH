"""蕴含层：受限 LLM 二元判定（O2 第二层）。

只在字面层失败时调用，且**数值 claim 不参与**——数值保真必须走字符级/对账，
不允许 LLM 用语义判断"救回"一个被改写的数字。

输入只有 claim 与所引证据正文，不带对话上下文，杜绝上下文污染。
输出三态：True（支持）/ False（不支持）/ None（跳过：未配置或判定失败）。
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field

from .config import ENTAILMENT_ENABLED, ENTAILMENT_MAX_TOKENS
from .envelope import neutralize
from .llm import LLM, LLMError

NUMBER_RE = re.compile(r"\d")
FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)
MAX_EVIDENCE_CHARS = 1800

SYSTEM = """你是引用支持度判定器。只判断【结论】是否被【证据】直接支持，不做常识推理、不做补充。
只输出 JSON：{"support": true} 或 {"support": false}。"""


@dataclass
class Entailer:
    llm: LLM
    enabled: bool = ENTAILMENT_ENABLED
    cache_size: int = 512
    _cache: dict[str, bool | None] = field(default_factory=dict, init=False)
    calls: int = field(default=0, init=False)

    @property
    def available(self) -> bool:
        return self.enabled and self.llm.available

    def judge(self, claim: str, evidence_text: str) -> bool | None:
        if not self.available:
            return None
        if NUMBER_RE.search(claim):
            # 含数字的结论只能由字面层/对账通过，蕴含层不救。
            return None

        # 证据先中和再送判定器：避免证据里的指令影响"支持/不支持"判断。
        safe_evidence = neutralize(evidence_text).text
        key = hashlib.sha256(
            f"{getattr(self.llm, 'name', 'llm')}|{claim}|{safe_evidence[:MAX_EVIDENCE_CHARS]}".encode()
        ).hexdigest()
        if key in self._cache:
            return self._cache[key]

        user = (
            "【证据】\n"
            f"{safe_evidence[:MAX_EVIDENCE_CHARS]}\n\n"
            "【结论】\n"
            f"{claim}\n\n"
            "证据是否直接支持该结论？"
        )
        self.calls += 1
        try:
            reply = self.llm.chat(
                [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}],
                temperature=0.0,
                max_tokens=ENTAILMENT_MAX_TOKENS,
                json_mode=True,
            )
            result = _parse(reply.text)
        except LLMError:
            result = None
        except Exception:  # noqa: BLE001 - 判定器故障不阻断主链路
            result = None

        if len(self._cache) >= self.cache_size:
            self._cache.clear()
        self._cache[key] = result
        return result


def _parse(raw: str) -> bool | None:
    """只接受 JSON（SYSTEM 已要求 JSON）。

    旧实现的子串判断会把"不支持"先命中"支持"而返回 True；这里直接拒绝非 JSON，
    解析失败一律 None（跳过蕴含，不擅自判真）。
    """

    text = FENCE_RE.sub("", raw).strip()
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    value = payload.get("support")
    if isinstance(value, bool):
        return value
    return None
