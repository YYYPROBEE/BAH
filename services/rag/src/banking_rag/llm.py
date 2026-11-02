"""LLM 客户端（DeepSeek，OpenAI 兼容 wire）。

与仓库 `packages/llm/src/deepseek` 保持同一套环境变量约定：
- `DEEPSEEK_API_KEY`（必需；缺失时退化为 NullLLM，生成走抽取式）
- `DEEPSEEK_BASE_URL`（默认 `https://api.deepseek.com`）
- `BAH_RAG_LLM_MODEL`（默认 `deepseek-chat`）

纪律：
- 只做一次调用，不自动重试（避免重复审计与延迟毛刺）；重试归调用方。
- 不记录 key；审计只记 model 与 token 用量。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Protocol

from .config import (
    DEFAULT_LLM_BASE_URL,
    DEFAULT_LLM_MODEL,
    LLM_API_KEY_ENV,
    LLM_BASE_URL_ENV,
    LLM_MODEL_ENV,
    LLM_TIMEOUT_SECONDS,
)


class LLMError(RuntimeError):
    """LLM 不可用/调用失败；上层据此降级为抽取式生成。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class LLMReply:
    text: str
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0


class LLM(Protocol):
    @property
    def available(self) -> bool: ...

    @property
    def name(self) -> str: ...

    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.0,
        max_tokens: int = 600,
        json_mode: bool = False,
    ) -> LLMReply: ...


@dataclass
class NullLLM:
    """没有凭证/显式关闭时的空实现：永不发网络请求。"""

    reason: str = "LLM_DISABLED"
    calls: int = field(default=0, init=False)

    @property
    def available(self) -> bool:
        return False

    @property
    def name(self) -> str:
        return "extractive"

    def chat(self, messages: list[dict[str, str]], **_: Any) -> LLMReply:
        self.calls += 1
        raise LLMError(self.reason, "LLM 未配置，使用抽取式生成")


@dataclass
class DeepSeekClient:
    api_key: str
    base_url: str = DEFAULT_LLM_BASE_URL
    model: str = DEFAULT_LLM_MODEL
    timeout: float = LLM_TIMEOUT_SECONDS
    calls: int = field(default=0, init=False)

    @classmethod
    def from_env(cls) -> DeepSeekClient | NullLLM:
        api_key = os.environ.get(LLM_API_KEY_ENV) or os.environ.get("BAH_RAG_LLM_API_KEY", "")
        if not api_key:
            return NullLLM(reason="LLM_NO_CREDENTIAL")
        return cls(
            api_key=api_key,
            base_url=os.environ.get(LLM_BASE_URL_ENV, DEFAULT_LLM_BASE_URL).rstrip("/"),
            model=os.environ.get(LLM_MODEL_ENV, DEFAULT_LLM_MODEL),
            timeout=float(os.environ.get("BAH_RAG_LLM_TIMEOUT", str(LLM_TIMEOUT_SECONDS))),
        )

    @property
    def available(self) -> bool:
        return True

    @property
    def name(self) -> str:
        return f"deepseek:{self.model}"

    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.0,
        max_tokens: int = 600,
        json_mode: bool = False,
    ) -> LLMReply:
        import httpx

        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}

        self.calls += 1
        try:
            with httpx.Client(timeout=self.timeout) as client:
                response = client.post(
                    f"{self.base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=body,
                )
        except httpx.TimeoutException as exc:
            raise LLMError("LLM_TIMEOUT", f"LLM 超时（{self.timeout}s）") from exc
        except httpx.HTTPError as exc:
            raise LLMError("LLM_UNAVAILABLE", f"LLM 网络错误：{exc}") from exc

        if response.status_code == 400 and json_mode:
            # 个别兼容端点不支持 response_format；去掉后重试一次（仅格式协商）。
            body.pop("response_format", None)
            try:
                with httpx.Client(timeout=self.timeout) as client:
                    response = client.post(
                        f"{self.base_url}/chat/completions",
                        headers={
                            "Authorization": f"Bearer {self.api_key}",
                            "Content-Type": "application/json",
                        },
                        json=body,
                    )
            except httpx.HTTPError as exc:
                raise LLMError("LLM_UNAVAILABLE", f"LLM 网络错误：{exc}") from exc

        if response.status_code != 200:
            detail = response.text[:300]
            raise LLMError("LLM_HTTP_ERROR", f"LLM 返回 {response.status_code}：{detail}")

        try:
            payload = response.json()
            content = payload["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise LLMError("LLM_BAD_RESPONSE", "LLM 响应结构不可解析") from exc

        usage = payload.get("usage") or {}
        return LLMReply(
            text=str(content or "").strip(),
            model=str(payload.get("model") or self.model),
            prompt_tokens=int(usage.get("prompt_tokens") or 0),
            completion_tokens=int(usage.get("completion_tokens") or 0),
        )


def build_llm() -> LLM:
    return DeepSeekClient.from_env()
