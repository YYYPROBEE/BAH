from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from fastapi.testclient import TestClient
from helpers import ask

from banking_rag.llm import LLMReply
from banking_rag.main import create_app
from banking_rag.store import Store


@dataclass
class ScriptedLLM:
    """按顺序返回预设回复；用于验证"生成 → 蕴含"两段 LLM 调用。"""

    replies: list[str]
    available: bool = True
    name: str = "scripted:test"
    calls: int = field(default=0, init=False)

    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.0,
        max_tokens: int = 600,
        json_mode: bool = False,
        **_: Any,
    ) -> LLMReply:
        index = min(self.calls, len(self.replies) - 1)
        self.calls += 1
        return LLMReply(text=self.replies[index], model="scripted", prompt_tokens=20, completion_tokens=10)


def test_llm_generation_produces_green_answer(store: Store) -> None:
    llm = ScriptedLLM(
        ['{"insufficient": false, "claims": [{"text": "赎回到账时间为T+1", "markers": ["K2"]}]}']
    )
    with TestClient(create_app(store, llm=llm)) as client:
        payload = ask(client, "赎回要几天到账？")
        audit = client.get(f"/v1/audit/{payload['traceId']}").json()

    assert payload["kind"] == "answer"
    assert payload["verdict"] == "GREEN"
    assert "T+1" in payload["answer"]
    assert audit["answer"]["generator"] == "llm"
    assert audit["answer"]["model"] == "scripted"
    assert audit["answer"]["tokens_in"] == 20
    assert audit["retrieval"]["channels_json"] is not None


def test_entailment_rescues_paraphrase_as_amber(store: Store) -> None:
    llm = ScriptedLLM(
        [
            '{"insufficient": false, "claims": [{"text": "资金在下一个工作日到账", "markers": ["K2"]}]}',
            '{"support": true}',
        ]
    )
    with TestClient(create_app(store, llm=llm)) as client:
        payload = ask(client, "赎回要几天到账？")
        audit = client.get(f"/v1/audit/{payload['traceId']}").json()

    assert payload["kind"] == "answer"
    assert payload["verdict"] == "AMBER_INFERRED"
    assert payload["answer"].startswith("（推断性回答）")
    verify = __import__("json").loads(audit["answer"]["verify_json"])
    assert verify["claims"][0]["entailment"] == "pass"
    assert verify["claims"][0]["literal"] == "fail"


def test_entailment_failure_is_red(store: Store) -> None:
    llm = ScriptedLLM(
        [
            '{"insufficient": false, "claims": [{"text": "资金实时到账且没有限额", "markers": ["K2"]}]}',
            '{"support": false}',
        ]
    )
    with TestClient(create_app(store, llm=llm)) as client:
        payload = ask(client, "赎回要几天到账？")

    assert payload["kind"] == "refusal"
    assert payload["verdict"] == "RED"
    assert payload["reasonCode"] == "UNSUPPORTED_CLAIM"
