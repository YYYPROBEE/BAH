from __future__ import annotations

from dataclasses import dataclass, field

from banking_rag.entailment import Entailer
from banking_rag.llm import LLMReply


@dataclass
class FakeLLM:
    reply: str
    available: bool = True
    name: str = "fake:model"
    calls: int = field(default=0, init=False)

    def chat(self, messages, **kwargs):
        self.calls += 1
        return LLMReply(text=self.reply, model="fake")


def test_entailment_true() -> None:
    llm = FakeLLM('{"support": true}')
    assert Entailer(llm).judge("赎回需要满足持有期", "持有不满7天赎回费率1.50%") is True


def test_entailment_false() -> None:
    llm = FakeLLM('{"support": false}')
    assert Entailer(llm).judge("所有产品都保本", "理财非存款，存在本金损失风险") is False


def test_numeric_claim_is_not_rescued() -> None:
    llm = FakeLLM('{"support": true}')
    assert Entailer(llm).judge("赎回费率是1.5%", "赎回费率1.50%") is None
    assert llm.calls == 0


def test_cache_hits_avoid_second_call() -> None:
    llm = FakeLLM('{"support": true}')
    entailer = Entailer(llm)
    assert entailer.judge("需要持有期", "持有期规则") is True
    assert entailer.judge("需要持有期", "持有期规则") is True
    assert llm.calls == 1


def test_disabled_returns_none() -> None:
    llm = FakeLLM('{"support": true}')
    assert Entailer(llm, enabled=False).judge("需要持有期", "持有期规则") is None
    assert llm.calls == 0
