from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from banking_rag.contract import Evidence
from banking_rag.generator import (
    GenerationError,
    Generator,
    InsufficientEvidence,
    extractive_generate,
    parse_claims,
    render_claims,
)
from banking_rag.llm import LLMReply

EVIDENCE = [
    Evidence(
        marker="K1",
        chunk_id=1,
        doc_id="FEE-2025-v3",
        title="稳盈系列费率表（2025版）",
        clause_no="费率表",
        tier=1,
        char_start=0,
        char_end=60,
        text="持有不满7天赎回费率1.50%。持有满7天不满30天赎回费率0.50%。持有满30天免赎回费。",
    )
]


@dataclass
class FakeLLM:
    reply: str
    available: bool = True
    name: str = "fake:model"
    calls: int = field(default=0, init=False)

    def chat(self, messages, **kwargs):
        self.calls += 1
        return LLMReply(text=self.reply, model="fake", prompt_tokens=12, completion_tokens=6)


def test_parse_claims_tolerates_fences_and_inline_markers() -> None:
    raw = """```json
    {"insufficient": false, "claims": [
      {"text": "赎回费率为1.50%", "markers": ["K1"]},
      {"text": "持有满30天免赎回费[K2]", "markers": []}
    ]}
    ```"""
    insufficient, claims = parse_claims(raw, {"K1", "K2"})
    assert insufficient is False
    assert claims[0].markers == ["K1"]
    assert claims[1].markers == ["K2"]


def test_parse_claims_drops_unknown_markers() -> None:
    raw = '{"insufficient": false, "claims": [{"text": "瞎编", "markers": ["K9"]}]}'
    with pytest.raises(GenerationError):
        parse_claims(raw, {"K1"})


def test_render_claims_binds_markers_per_sentence() -> None:
    _, claims = parse_claims(
        '{"insufficient": false, "claims": [{"text": "A", "markers": ["K1"]}, '
        '{"text": "B", "markers": ["K1", "K2"]}]}',
        {"K1", "K2"},
    )
    text = render_claims(claims)
    assert text == "A[K1]。B[K1][K2]。"
    assert text.count("[K1]") == 2


def test_generate_uses_llm_claims() -> None:
    llm = FakeLLM(
        reply='{"insufficient": false, "claims": [{"text": "持有不满7天赎回费率为1.50%", "markers": ["K1"]}]}'
    )
    result = Generator(llm).generate("不满7天赎回费率是多少", EVIDENCE)
    assert result.generator == "llm"
    assert result.text == "持有不满7天赎回费率为1.50%[K1]。"
    assert result.prompt_tokens == 12


def test_generate_falls_back_on_bad_json() -> None:
    llm = FakeLLM(reply="我觉得费率大概是一点五")
    result = Generator(llm).generate("不满7天赎回费率是多少", EVIDENCE)
    assert result.generator == "extractive-fallback"
    assert "[K1]" in result.text
    assert "1.50" in result.text


def test_generate_raises_when_llm_says_insufficient() -> None:
    llm = FakeLLM(reply='{"insufficient": true, "claims": []}')
    with pytest.raises(InsufficientEvidence):
        Generator(llm).generate("不满7天赎回费率是多少", EVIDENCE)


def test_null_llm_goes_extractive() -> None:
    from banking_rag.llm import NullLLM

    result = Generator(NullLLM()).generate("不满7天赎回费率是多少", EVIDENCE)
    assert result.generator == "extractive"
    assert "[K1]" in result.text


def test_extractive_picks_best_sentence() -> None:
    result = extractive_generate("持有满30天赎回费率", EVIDENCE)
    assert "免赎回费" in result.text
