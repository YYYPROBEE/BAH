"""知识回答引擎：12 步确定性管线（生成可选 LLM，校验层不变）。

流程：breaker → 地区守卫 → 产品消歧 → ACL 谓词 → 路由 → 混合检索/取数
→ 生成（LLM / 模板 / 抽取式降级）→ 字面+蕴含+数值校验 → 状态机 → 审计 → 熔断计数。

纪律：
- 数值只从 cell `value_text` 取（取数型问题不经 LLM）；
- LLM 输出不可信：只当 claim 草稿，终态由代码判定；
- 每个出口（含拒答/消歧/锁定）都写审计，且字段足够证据面板回放。
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field

from .breaker import Breaker
from .contract import (
    AnswerRequest,
    AnswerResponse,
    Candidate,
    Evidence,
    Latency,
    LookupValue,
    Principal,
    QueryRequest,
    QueryResponse,
    VerifyRequest,
    VerifyResponse,
)
from .entailment import Entailer
from .generator import Claim, Generation, Generator, InsufficientEvidence
from .llm import LLM, build_llm
from .retrieve import (
    SearchResult,
    evidence_from_rows,
    is_lookup_query,
    lookup,
    search,
)
from .store import Store, TraceConflict
from .verify import verify_answer

ALIASES: tuple[tuple[str, str], ...] = (
    ("稳盈90天增强版", "W-003"),
    ("稳盈90天b", "W-002"),
    ("稳盈90天", "W-001"),
)

REGION_HINTS: dict[str, str] = {
    "深圳": "CN-SZ",
    "上海": "CN-SH",
    "北京": "CN-BJ",
    "广州": "CN-GZ",
}

REFUSAL_MESSAGES = {
    "SCOPE_EMPTY": "当前权限范围内没有可引用的依据，无法回答该问题。",
    "EMPTY_RETRIEVAL": "知识库中没有找到相关依据，无法回答该问题。",
    "INSUFFICIENT_EVIDENCE": "现有依据不足以回答该问题，已中止输出。",
    "NUMERIC_MISMATCH": "检索到的依据与答案数值不一致，已中止输出。",
    "SPAN_UNRESOLVED": "答案引用无法解析到证据，已中止输出。",
    "MISSING_CITATION": "答案缺少可验证引用，已中止输出。",
    "MISSING_CLAIM_CITATION": "答案存在未绑定引用的结论，已中止输出。",
    "UNSUPPORTED_CLAIM": "答案未获得证据支持，已中止输出。",
    "BREAKER_LOCKED": "本次会话的检索已暂时锁定，已转人工接管。",
    "KNOWLEDGE_UNAVAILABLE": "知识服务暂不可用，请稍后再试。",
}

LOOKUP_ANSWER_TEMPLATE = "{label}为{value}{unit}[{marker}]。"


def new_trace_id() -> str:
    return f"tr-{uuid.uuid4().hex[:16]}"


def trace_for(subject: str, idempotency_key: str | None) -> str:
    """服务端生成 trace；`Idempotency-Key` 只映射成确定性 trace，不信任客户端字段。

    重放同一个 key（同一 subject）会落到同一 trace，审计主键冲突 → 409。
    """

    if not idempotency_key:
        return new_trace_id()
    digest = hashlib.sha256(f"{subject}\x00{idempotency_key}".encode("utf-8")).hexdigest()[:16]
    return f"tr-idem-{digest}"


def _elapsed_ms(started: float) -> int:
    return max(0, int((time.perf_counter() - started) * 1000))


def mentioned_products(query: str) -> list[str]:
    """按最长别名优先匹配产品；返回去重后的 product_id 列表。"""

    lowered = query.lower()
    covered: set[int] = set()
    found: list[str] = []
    for alias, product_id in ALIASES:
        start = 0
        while True:
            index = lowered.find(alias, start)
            if index < 0:
                break
            span = set(range(index, index + len(alias)))
            if not span & covered:
                found.append(product_id)
                covered |= span
            start = index + 1
    return list(dict.fromkeys(found))


def region_mismatch(query: str, region: str) -> bool:
    for name, code in REGION_HINTS.items():
        if name in query and code != region:
            return True
    return False


@dataclass
class Engine:
    store: Store
    breaker: Breaker = field(default_factory=Breaker)
    llm: LLM | None = None
    generator: Generator = field(init=False)
    entailer: Entailer = field(init=False)

    def __post_init__(self) -> None:
        llm = self.llm if self.llm is not None else build_llm()
        self.llm = llm
        self.generator = Generator(llm)
        self.entailer = Entailer(llm)

    # ── 对外：/v1/answer ──────────────────────────────────────────────────
    def answer(
        self,
        request: AnswerRequest,
        principal: Principal,
        session_id: str,
        trace_id: str,
    ) -> AnswerResponse:
        started = time.perf_counter()
        conn = self.store.connect()
        try:
            # 先做幂等闸：重放同一 trace 直接 409，不重复计数熔断。
            if self.store.trace_exists(conn, trace_id):
                raise TraceConflict(trace_id)
            if self.breaker.is_locked(conn, session_id):
                return self._refuse(
                    conn,
                    principal,
                    session_id,
                    request.query,
                    trace_id,
                    "LOCKED",
                    "BREAKER_LOCKED",
                    started,
                    count_breaker=False,
                    breaker_state="LOCKED",
                )
            if region_mismatch(request.query, principal.region):
                return self._refuse(
                    conn,
                    principal,
                    session_id,
                    request.query,
                    trace_id,
                    "RED",
                    "SCOPE_EMPTY",
                    started,
                )

            visible = self.store.visible_chunk_ids(conn, principal)
            products = mentioned_products(request.query)
            if len(products) == 1:
                visible = self._filter_visible_by_product(conn, visible, products[0])
            if not visible:
                return self._refuse(
                    conn,
                    principal,
                    session_id,
                    request.query,
                    trace_id,
                    "RED",
                    "SCOPE_EMPTY",
                    started,
                    visible=visible,
                )

            if len(products) >= 2:
                candidates = self._candidates(conn, principal, products)
                if len(candidates) >= 2:
                    return self._disambiguate(
                        conn,
                        principal,
                        session_id,
                        request.query,
                        trace_id,
                        candidates,
                        visible,
                        started,
                    )

            route = "lookup" if is_lookup_query(request.query) else "hybrid"
            retrieval_started = time.perf_counter()
            evidence: list[Evidence] = []
            values: list[LookupValue] = []
            result = SearchResult(evidence=[], trace={})
            if route == "lookup":
                hits = lookup(self.store, conn, visible, request.query)
                if hits:
                    evidence = self._evidence_for_chunks(conn, [hits[0].chunk_id])
                    values = [
                        LookupValue(
                            label=hit.label,
                            value_text=hit.value_text,
                            unit=hit.unit,
                            cell_ref=f"c-{hit.cell_id}",
                        )
                        for hit in hits
                    ]
                    result = SearchResult(
                        evidence=evidence,
                        trace={
                            "route": "lookup",
                            "cells": [
                                {
                                    "cellId": hit.cell_id,
                                    "chunkId": hit.chunk_id,
                                    "label": hit.label,
                                    "valueText": hit.value_text,
                                    "unit": hit.unit,
                                }
                                for hit in hits
                            ],
                        },
                    )
            if not evidence:
                result = search(self.store, conn, visible, request.query)
                evidence = result.evidence
            retrieval_ms = _elapsed_ms(retrieval_started)

            if not evidence:
                return self._refuse(
                    conn,
                    principal,
                    session_id,
                    request.query,
                    trace_id,
                    "RED",
                    "EMPTY_RETRIEVAL",
                    started,
                    retrieval_ms=retrieval_ms,
                    visible=visible,
                    trace=result.trace,
                )

            generation_started = time.perf_counter()
            if values:
                claim_text = f"{values[0].label}为{values[0].value_text}{values[0].unit}"
                generation = Generation(
                    text=LOOKUP_ANSWER_TEMPLATE.format(
                        label=values[0].label,
                        value=values[0].value_text,
                        unit=values[0].unit,
                        marker="K1",
                    ),
                    claims=[Claim(text=claim_text, markers=["K1"])],
                    generator="template",
                )
            else:
                try:
                    generation = self.generator.generate(
                        request.query,
                        evidence,
                        max_chars=request.answer_options.max_chars,
                    )
                except InsufficientEvidence:
                    return self._refuse(
                        conn,
                        principal,
                        session_id,
                        request.query,
                        trace_id,
                        "RED",
                        "INSUFFICIENT_EVIDENCE",
                        started,
                        retrieval_ms=retrieval_ms,
                        visible=visible,
                        evidence_ids=[item.chunk_id for item in evidence],
                        trace=result.trace,
                    )
            generation_ms = _elapsed_ms(generation_started)

            verify_started = time.perf_counter()
            verified = verify_answer(
                generation.text,
                evidence,
                self._cells_by_marker(conn, evidence),
                require_citations=request.answer_options.require_citations,
                trace_id=trace_id,
                entailer=self.entailer,
            )
            verify_ms = _elapsed_ms(verify_started)

            if verified.verdict == "RED":
                return self._refuse(
                    conn,
                    principal,
                    session_id,
                    request.query,
                    trace_id,
                    "RED",
                    verified.reason_code or "UNSUPPORTED_CLAIM",
                    started,
                    retrieval_ms=retrieval_ms,
                    visible=visible,
                    evidence_ids=[item.chunk_id for item in evidence],
                    trace=result.trace,
                    generator=generation.generator,
                    model=generation.model,
                    tokens=(generation.prompt_tokens, generation.completion_tokens),
                    verified=verified,
                    injection_hits=generation.envelope_hits,
                )

            final_text = generation.text
            if verified.verdict == "AMBER_INFERRED":
                final_text = f"（推断性回答）{final_text}"

            latency = Latency(
                retrieval=retrieval_ms,
                generation=generation_ms,
                verify=verify_ms,
                total=_elapsed_ms(started),
            )
            response = AnswerResponse(
                trace_id=trace_id,
                kind="answer",
                answer=final_text,
                citations=verified.citations,
                evidence=evidence,
                verdict=verified.verdict,
                reason_code=verified.reason_code,
                latency_ms=latency,
            )

            self._record_and_audit(
                conn,
                principal,
                session_id,
                request.query,
                trace_id,
                visible=visible,
                evidence_ids=[item.chunk_id for item in evidence],
                route=route,
                verdict=verified.verdict,
                reason_code=verified.reason_code,
                answer_text=final_text,
                latency_ms=latency.total,
                trace=result.trace,
                generator=generation.generator,
                model=generation.model,
                tokens=(generation.prompt_tokens, generation.completion_tokens),
                verified=verified,
                injection_hits=generation.envelope_hits,
            )
            return response
        finally:
            conn.close()

    # ── 对外：/v1/query（只返回证据/取数） ──────────────────────────────
    def query(
        self,
        request: QueryRequest,
        principal: Principal,
        session_id: str,
        trace_id: str,
    ) -> QueryResponse:
        started = time.perf_counter()
        conn = self.store.connect()
        try:
            if self.breaker.is_locked(conn, session_id):
                return QueryResponse(
                    trace_id=trace_id,
                    kind="refusal",
                    answer=REFUSAL_MESSAGES["BREAKER_LOCKED"],
                    verdict="LOCKED",
                    reason_code="BREAKER_LOCKED",
                    latency_ms=Latency(total=_elapsed_ms(started)),
                )
            if region_mismatch(request.query, principal.region):
                return QueryResponse(
                    trace_id=trace_id,
                    kind="refusal",
                    answer=REFUSAL_MESSAGES["SCOPE_EMPTY"],
                    verdict="RED",
                    reason_code="SCOPE_EMPTY",
                    latency_ms=Latency(total=_elapsed_ms(started)),
                )
            visible = self.store.visible_chunk_ids(conn, principal)
            products = mentioned_products(request.query)
            if len(products) == 1:
                visible = self._filter_visible_by_product(conn, visible, products[0])
            if not visible:
                return QueryResponse(
                    trace_id=trace_id,
                    kind="refusal",
                    answer=REFUSAL_MESSAGES["SCOPE_EMPTY"],
                    verdict="RED",
                    reason_code="SCOPE_EMPTY",
                    latency_ms=Latency(total=_elapsed_ms(started)),
                )
            if len(products) >= 2:
                candidates = self._candidates(conn, principal, products)
                if len(candidates) >= 2:
                    return QueryResponse(
                        trace_id=trace_id,
                        kind="disambiguation",
                        answer="您指的是哪一只产品？",
                        candidates=candidates,
                        verdict="AMBER_DISAMBIGUATION",
                        reason_code="NEED_DISAMBIGUATION",
                        latency_ms=Latency(total=_elapsed_ms(started)),
                    )
            route = "lookup" if is_lookup_query(request.query) else "hybrid"
            evidence: list[Evidence] = []
            values: list[LookupValue] = []
            result = SearchResult(evidence=[], trace={})
            if route == "lookup":
                hits = lookup(self.store, conn, visible, request.query)
                if hits:
                    evidence = self._evidence_for_chunks(conn, [hits[0].chunk_id])
                    values = [
                        LookupValue(
                            label=hit.label,
                            value_text=hit.value_text,
                            unit=hit.unit,
                            cell_ref=f"c-{hit.cell_id}",
                        )
                        for hit in hits
                    ]
                    result = SearchResult(
                        evidence=evidence,
                        trace={
                            "route": "lookup",
                            "cells": [
                                {
                                    "cellId": hit.cell_id,
                                    "chunkId": hit.chunk_id,
                                    "label": hit.label,
                                    "valueText": hit.value_text,
                                    "unit": hit.unit,
                                }
                                for hit in hits
                            ],
                        },
                    )
            if not evidence:
                result = search(self.store, conn, visible, request.query)
                evidence = result.evidence
            if not evidence:
                return QueryResponse(
                    trace_id=trace_id,
                    kind="refusal",
                    answer=REFUSAL_MESSAGES["EMPTY_RETRIEVAL"],
                    visible_count=len(visible),
                    verdict="RED",
                    reason_code="EMPTY_RETRIEVAL",
                    latency_ms=Latency(total=_elapsed_ms(started)),
                )
            kind = "lookup" if values else "evidence"
            return QueryResponse(
                trace_id=trace_id,
                kind=kind,
                route=route,
                visible_count=len(visible),
                evidence=evidence,
                values=values,
                latency_ms=Latency(retrieval=_elapsed_ms(started), total=_elapsed_ms(started)),
            )
        finally:
            conn.close()

    # ── 对外：/v1/verify ─────────────────────────────────────────────────
    def verify(self, request: VerifyRequest, session_id: str) -> VerifyResponse:
        conn = self.store.connect()
        try:
            evidence: list[Evidence] = []
            for trace_id in request.trace_ids:
                # 只允许校验本会话自己的 trace。
                row = conn.execute(
                    "SELECT evidence_ids FROM retrieval_log "
                    "WHERE trace_id = ? AND session_id = ?",
                    (trace_id, session_id),
                ).fetchone()
                if row is None:
                    continue
                ids = json.loads(str(row["evidence_ids"]))
                evidence.extend(
                    evidence_from_rows(
                        [(item, 0.0) for item in self.store.evidence_by_ids(conn, ids)]
                    )
                )
            if not evidence:
                return VerifyResponse(
                    verdict="RED",
                    reason_code="SPAN_UNRESOLVED",
                    latency_ms=Latency(total=0),
                )
            return verify_answer(
                request.answer_text,
                evidence,
                self._cells_by_marker(conn, evidence),
                require_citations=request.options.require_citations,
                trace_id=request.trace_ids[0] if request.trace_ids else None,
                entailer=self.entailer,
            )
        finally:
            conn.close()

    def _cells_by_marker(
        self, conn, evidence: list[Evidence]
    ) -> dict[str, list[str]]:
        """cell 值按 marker 分组（含单位），数值校验不得跨证据取用。"""

        by_chunk: dict[int, list[str]] = {}
        for row in self.store.cells_for(conn, [item.chunk_id for item in evidence]):
            unit = str(row["unit"] or "")
            by_chunk.setdefault(int(row["chunk_id"]), []).append(
                f"{row['value_text']}{unit}"
            )
        return {item.marker: by_chunk.get(item.chunk_id, []) for item in evidence}

    # ── 内部 ─────────────────────────────────────────────────────────────
    def _evidence_for_chunks(self, conn, chunk_ids: list[int]) -> list[Evidence]:
        rows = self.store.evidence_by_ids(conn, chunk_ids)
        return evidence_from_rows([(row, 0.0) for row in rows])

    @staticmethod
    def _filter_visible_by_product(conn, visible: set[int], product_id: str) -> set[int]:
        """用户点名产品时，只保留该产品的文档；general 文档（product_id NULL）不参与。"""

        if not visible:
            return set()
        placeholders = ",".join("?" for _ in visible)
        rows = conn.execute(
            f"SELECT chunk_id FROM chunks WHERE chunk_id IN ({placeholders}) AND product_id = ?",
            [*visible, product_id],
        ).fetchall()
        return {int(row["chunk_id"]) for row in rows}

    def _candidates(self, conn, principal: Principal, product_ids: list[str]) -> list[Candidate]:
        visible = self.store.visible_chunk_ids(conn, principal)
        if not visible:
            return []
        placeholders = ",".join("?" for _ in visible)
        product_placeholders = ",".join("?" for _ in product_ids)
        rows = conn.execute(
            f"""
            SELECT DISTINCT d.product_id, d.title, d.doc_type
            FROM docs d JOIN chunks c ON c.doc_id = d.doc_id
            WHERE c.chunk_id IN ({placeholders})
              AND d.product_id IN ({product_placeholders})
            ORDER BY d.product_id
            """,
            [*visible, *product_ids],
        ).fetchall()
        best: dict[str, tuple[int, str]] = {}
        for row in rows:
            product_id = row["product_id"]
            if product_id is None:
                continue
            score = 2 if row["doc_type"] == "说明书" else 1
            current = best.get(str(product_id))
            if current is None or score > current[0]:
                best[str(product_id)] = (score, str(row["title"]))
        return [
            Candidate(
                product_id=product_id,
                name=title.replace("产品说明书", "").strip(),
            )
            for product_id, (_score, title) in sorted(best.items())
        ]

    def _disambiguate(
        self,
        conn,
        principal: Principal,
        session_id: str,
        query: str,
        trace_id: str,
        candidates: list[Candidate],
        visible: set[int],
        started: float,
    ) -> AnswerResponse:
        answer = "您指的是哪一只产品？"
        response = AnswerResponse(
            trace_id=trace_id,
            kind="disambiguation",
            answer=answer,
            candidates=candidates,
            verdict="AMBER_DISAMBIGUATION",
            reason_code="NEED_DISAMBIGUATION",
            latency_ms=Latency(retrieval=_elapsed_ms(started), total=_elapsed_ms(started)),
        )
        self._record_and_audit(
            conn,
            principal,
            session_id,
            query,
            trace_id,
            visible=visible,
            evidence_ids=[],
            route="alias",
            verdict="AMBER_DISAMBIGUATION",
            reason_code="NEED_DISAMBIGUATION",
            answer_text=answer,
            latency_ms=response.latency_ms.total,
            trace={"candidates": [item.model_dump(by_alias=True) for item in candidates]},
            generator="none",
            model=None,
            tokens=(0, 0),
            verified=None,
        )
        return response

    def _refuse(
        self,
        conn,
        principal: Principal,
        session_id: str,
        query: str,
        trace_id: str,
        verdict: str,
        reason_code: str,
        started: float,
        *,
        retrieval_ms: int = 0,
        visible: set[int] | None = None,
        evidence_ids: list[int] | None = None,
        trace: dict[str, object] | None = None,
        generator: str = "none",
        model: str | None = None,
        tokens: tuple[int, int] = (0, 0),
        verified: VerifyResponse | None = None,
        injection_hits: list[str] | None = None,
        count_breaker: bool = True,
        breaker_state: str | None = None,
    ) -> AnswerResponse:
        message = REFUSAL_MESSAGES.get(reason_code, REFUSAL_MESSAGES["UNSUPPORTED_CLAIM"])
        latency = Latency(
            retrieval=retrieval_ms,
            verify=0,
            total=_elapsed_ms(started),
        )
        response = AnswerResponse(
            trace_id=trace_id,
            kind="refusal",
            answer=message,
            evidence=[],
            citations=verified.citations if verified is not None else [],
            verdict=verdict,  # type: ignore[arg-type]
            reason_code=reason_code,
            latency_ms=latency,
        )
        self._record_and_audit(
            conn,
            principal,
            session_id,
            query,
            trace_id,
            visible=visible or set(),
            evidence_ids=evidence_ids or [],
            route="hybrid",
            verdict=verdict,
            reason_code=reason_code,
            answer_text=message,
            latency_ms=latency.total,
            trace=trace or {},
            generator=generator,
            model=model,
            tokens=tokens,
            verified=verified,
            injection_hits=injection_hits or [],
            count_breaker=count_breaker,
            breaker_state=breaker_state,
        )
        return response

    def _record_and_audit(
        self,
        conn,
        principal: Principal,
        session_id: str,
        query: str,
        trace_id: str,
        *,
        visible: set[int],
        evidence_ids: list[int],
        route: str,
        verdict: str,
        reason_code: str | None,
        answer_text: str,
        latency_ms: int,
        trace: dict[str, object],
        generator: str,
        model: str | None,
        tokens: tuple[int, int],
        verified: VerifyResponse | None,
        injection_hits: list[str] | None = None,
        count_breaker: bool = True,
        breaker_state: str | None = None,
    ) -> None:
        if count_breaker:
            self.breaker.record(
                conn,
                session_id,
                verdict,
                reason_code,
                # 注入命中只信服务端 envelope 的检测结果，不接受请求体。
                injection_hit=bool(injection_hits),
            )
        state = breaker_state or self.breaker.status(conn, session_id)
        now = principal.now.isoformat()
        verify_payload = (
            json.dumps(verified.model_dump(by_alias=True, mode="json"), ensure_ascii=False)
            if verified is not None
            else None
        )
        self.store.log_retrieval(
            conn,
            trace_id=trace_id,
            session_id=session_id,
            query_norm=query,
            predicate_json=json.dumps(principal.model_dump(mode="json"), ensure_ascii=False),
            visible_count=len(visible),
            evidence_ids=evidence_ids,
            route=route,
            verdict=verdict,
            reason_code=reason_code,
            latency_ms=latency_ms,
            created_at=now,
            channels_json=json.dumps(trace, ensure_ascii=False) if trace else None,
            breaker_state=state,
        )
        self.store.log_answer(
            conn,
            trace_id=trace_id,
            session_id=session_id,
            answer_text=answer_text,
            verdict=verdict,
            reason_code=reason_code,
            latency_ms=latency_ms,
            created_at=now,
            verify_json=verify_payload,
            generator=generator,
            model=model,
            tokens_in=tokens[0],
            tokens_out=tokens[1],
        )
