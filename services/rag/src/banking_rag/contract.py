"""knowledge.v1 的 Pydantic 契约。

约定：
- JSON 字段一律 camelCase（`alias_generator=to_camel`），Python 内部 snake_case；
- `extra="forbid"`：多一个字段就是契约错误，不做静默忽略；
- 数值一律用字符串 `valueText`，不用 JSON number（避免 0.1+0.2 与精度口径）；
- `now` 用 ISO datetime，服务端只取日期做时效比较。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class ApiModel(BaseModel):
    """所有契约模型的基类：camelCase + 严格字段。"""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class Principal(ApiModel):
    role: str
    audience: str
    channel: str
    region: str
    product_id: str | None = None
    now: datetime


class AnswerOptions(ApiModel):
    style: Literal["concise", "detailed"] = "concise"
    max_chars: int = Field(default=600, ge=80, le=2000)
    require_citations: bool = True


class AnswerRequest(ApiModel):
    schema_version: str = "knowledge.v1"
    trace_id: str | None = None
    session_id: str
    query: str = Field(min_length=1, max_length=512)
    principal: Principal
    answer_options: AnswerOptions = Field(default_factory=AnswerOptions)
    # 由上游 sentry 透传的注入特征命中（RAG 不重复建检测器；缺省 false 保持兼容）。
    injection_hit: bool = False


class QueryRequest(ApiModel):
    schema_version: str = "knowledge.v1"
    trace_id: str | None = None
    session_id: str
    query: str = Field(min_length=1, max_length=512)
    principal: Principal
    limits: dict[str, int] = Field(default_factory=lambda: {"topK": 8, "maxEvidenceChars": 6000})


class VerifyOptions(ApiModel):
    require_citations: bool = True


class VerifyRequest(ApiModel):
    schema_version: str = "knowledge.v1"
    session_id: str
    trace_ids: list[str] = Field(min_length=1)
    answer_text: str = Field(min_length=1, max_length=4000)
    options: VerifyOptions = Field(default_factory=VerifyOptions)


class Evidence(ApiModel):
    marker: str
    chunk_id: int
    doc_id: str
    title: str
    clause_no: str | None = None
    tier: int = 5
    char_start: int = 0
    char_end: int = 0
    text: str


class Citation(ApiModel):
    marker: str
    doc_id: str
    title: str
    clause_no: str | None = None
    char_start: int = 0
    char_end: int = 0


class Candidate(ApiModel):
    product_id: str
    name: str


class LookupValue(ApiModel):
    label: str
    value_text: str
    unit: str
    cell_ref: str
    formula: str | None = None


class Latency(ApiModel):
    retrieval: int = 0
    generation: int = 0
    verify: int = 0
    total: int = 0


class AnswerResponse(ApiModel):
    schema_version: str = "knowledge.v1"
    trace_id: str
    kind: Literal["answer", "refusal", "disambiguation"]
    answer: str
    citations: list[Citation] = Field(default_factory=list)
    evidence: list[Evidence] = Field(default_factory=list)
    verdict: Literal["GREEN", "AMBER_INFERRED", "AMBER_DISAMBIGUATION", "RED", "LOCKED"]
    reason_code: str | None = None
    candidates: list[Candidate] = Field(default_factory=list)
    latency_ms: Latency = Field(default_factory=Latency)


class QueryResponse(ApiModel):
    schema_version: str = "knowledge.v1"
    trace_id: str
    kind: Literal["evidence", "lookup", "disambiguation", "refusal"]
    route: Literal["hybrid", "lookup"] = "hybrid"
    visible_count: int = 0
    answer: str = ""
    evidence: list[Evidence] = Field(default_factory=list)
    values: list[LookupValue] = Field(default_factory=list)
    candidates: list[Candidate] = Field(default_factory=list)
    verdict: Literal["GREEN", "AMBER_INFERRED", "AMBER_DISAMBIGUATION", "RED", "LOCKED"] = "GREEN"
    reason_code: str | None = None
    latency_ms: Latency = Field(default_factory=Latency)


class VerifyClaim(ApiModel):
    index: int
    text: str
    markers: list[str] = Field(default_factory=list)
    literal: Literal["pass", "fail"]
    support: Literal["pass", "fail"]
    entailment: Literal["pass", "fail", "skipped"] = "skipped"


class VerifyNumber(ApiModel):
    raw: str
    value_text: str
    unit: str
    source: str
    match: bool


class VerifyResponse(ApiModel):
    schema_version: str = "knowledge.v1"
    trace_id: str | None = None
    verdict: Literal["GREEN", "AMBER_INFERRED", "AMBER_DISAMBIGUATION", "RED", "LOCKED"]
    reason_code: str | None = None
    claims: list[VerifyClaim] = Field(default_factory=list)
    numbers: list[VerifyNumber] = Field(default_factory=list)
    citations: list[Citation] = Field(default_factory=list)
    latency_ms: Latency = Field(default_factory=Latency)


class HealthResponse(ApiModel):
    status: Literal["ok", "degraded"]
    schema_version: str = "knowledge.v1"
    corpus_version: int
    embed_version: str
    docs: int
    chunks: int
    embedding: Literal["on", "off"] = "off"


class ErrorResponse(ApiModel):
    code: str
    message: str
    detail: dict[str, str] | None = None
