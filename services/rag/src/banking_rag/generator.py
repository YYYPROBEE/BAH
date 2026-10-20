"""答案生成器：LLM（DeepSeek）为主，抽取式为降级路径。

契约（与 O2/O4 对齐）：
- LLM 只输出 claim + 引用标记，不直接决定终态；
- 答案文本由本模块确定性渲染（`.。` 分句 + `[K#]` 后缀），供字面校验逐句切分；
- 取数型问题永远走确定性模板，数值不经过 LLM（O3/O4 的硬约束）；
- LLM 不可用/输出不可解析 → 抽取式兜底，审计记 `extractive-fallback`。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from .contract import Evidence
from .envelope import build_envelope
from .llm import LLM, LLMError
from .retrieve import extract_terms

MARKER_RE = re.compile(r"\[(K\d+)\]")
SENTENCE_SPLIT = re.compile(r"[。；;\n]+")
FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


class InsufficientEvidence(RuntimeError):
    """LLM 判定证据不足（映射为 RED / INSUFFICIENT_EVIDENCE）。"""


class GenerationError(RuntimeError):
    """LLM 输出不可用（触发抽取式降级）。"""


@dataclass(frozen=True)
class Claim:
    text: str
    markers: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Generation:
    text: str
    claims: list[Claim]
    generator: str
    model: str | None = None
    prompt_tokens: int = 0
    completion_tokens: int = 0
    raw: str = ""
    envelope_hits: list[str] = field(default_factory=list)


def _strip_fences(raw: str) -> str:
    return FENCE_RE.sub("", raw).strip()


def parse_claims(raw: str, allowed: set[str]) -> tuple[bool, list[Claim]]:
    """解析 LLM 的 JSON 输出；返回 (insufficient, claims)。

    - 容忍 ```json 围栏与前后噪声；
    - 未知 marker 丢弃；丢弃后无 marker 的 claim 也丢弃；
    - 结构不合法 → GenerationError（由调用方降级）。
    """

    text = _strip_fences(raw)
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise GenerationError("LLM 输出不是 JSON 对象")
    try:
        payload = json.loads(text[start : end + 1])
    except json.JSONDecodeError as exc:
        raise GenerationError(f"LLM JSON 解析失败：{exc}") from exc

    if payload.get("insufficient") is True:
        return True, []

    raw_claims = payload.get("claims")
    if not isinstance(raw_claims, list) or not raw_claims:
        raise GenerationError("LLM 输出缺少 claims")

    claims: list[Claim] = []
    for item in raw_claims:
        if not isinstance(item, dict):
            continue
        body = str(item.get("text") or "").strip()
        body = MARKER_RE.sub("", body).strip()
        inline = MARKER_RE.findall(str(item.get("text") or ""))
        declared = item.get("markers") if isinstance(item.get("markers"), list) else []
        markers = [str(marker) for marker in [*declared, *inline] if str(marker) in allowed]
        markers = list(dict.fromkeys(markers))
        if not body or not markers:
            continue
        claims.append(Claim(text=body, markers=markers))
    if not claims:
        raise GenerationError("LLM 输出没有可用的 claim/marker")
    return False, claims


def render_claims(claims: list[Claim], *, max_chars: int = 600) -> str:
    """确定性渲染：`claim[K1][K2]。`，超长时按 claim 截断。"""

    parts: list[str] = []
    used = 0
    for claim in claims:
        body = claim.text.strip().rstrip("。；;，, ")
        markers = "".join(f"[{marker}]" for marker in claim.markers)
        piece = f"{body}{markers}。"
        if parts and used + len(piece) > max_chars:
            break
        parts.append(piece)
        used += len(piece)
    return "".join(parts)


def _split_sentences(text: str) -> list[str]:
    return [part.strip() for part in SENTENCE_SPLIT.split(text) if part.strip()]


def pick_sentence(text: str, query: str) -> str:
    """抽取式兜底：按领域词命中数挑一句。"""

    terms = extract_terms(query)
    sentences = _split_sentences(text)
    if not sentences:
        return text
    scored = []
    for sentence in sentences:
        # 长词（更具体的短语）权重更高：避免通用词"费率"压过"持有满30天"。
        score = sum(len(term) ** 2 for term in terms if term in sentence)
        scored.append((score, len(sentence), sentence))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return scored[0][2]


def extractive_generate(
    query: str,
    evidence: list[Evidence],
    *,
    reason: str = "extractive",
    max_chars: int = 600,
) -> Generation:
    if not evidence:
        raise InsufficientEvidence("没有可用证据")
    sentence = pick_sentence(evidence[0].text, query)
    claims = [Claim(text=sentence, markers=[evidence[0].marker])]
    return Generation(
        text=render_claims(claims, max_chars=max_chars),
        claims=claims,
        generator=reason,
        raw="",
    )


class Generator:
    def __init__(self, llm: LLM, *, max_chars: int = 600) -> None:
        self.llm = llm
        self.max_chars = max_chars

    def generate(self, query: str, evidence: list[Evidence], *, max_chars: int | None = None) -> Generation:
        limit = max_chars or self.max_chars
        if not evidence:
            raise InsufficientEvidence("没有可用证据")
        if not self.llm.available:
            return extractive_generate(query, evidence, reason="extractive", max_chars=limit)

        envelope = build_envelope(query, evidence, max_chars=limit)
        try:
            reply = self.llm.chat(
                envelope.messages,
                temperature=0.0,
                max_tokens=600,
                json_mode=True,
            )
        except LLMError as exc:
            fallback = extractive_generate(query, evidence, reason="extractive-fallback", max_chars=limit)
            return Generation(
                text=fallback.text,
                claims=fallback.claims,
                generator="extractive-fallback",
                model=getattr(self.llm, "name", None),
                raw=f"{exc.code}: {exc.message}",
                envelope_hits=envelope.hits,
            )

        try:
            insufficient, claims = parse_claims(reply.text, set(envelope.markers))
        except GenerationError as exc:
            fallback = extractive_generate(query, evidence, reason="extractive-fallback", max_chars=limit)
            return Generation(
                text=fallback.text,
                claims=fallback.claims,
                generator="extractive-fallback",
                model=reply.model,
                raw=str(exc),
                envelope_hits=envelope.hits,
            )

        if insufficient:
            raise InsufficientEvidence("LLM 判定证据不足")

        return Generation(
            text=render_claims(claims, max_chars=limit),
            claims=claims,
            generator="llm",
            model=reply.model,
            prompt_tokens=reply.prompt_tokens,
            completion_tokens=reply.completion_tokens,
            raw=reply.text[:2000],
            envelope_hits=envelope.hits,
        )
