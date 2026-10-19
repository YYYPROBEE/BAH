"""知识回答引擎（骨架版 12 步的确定性切片）。

流程：breaker → 地区守卫 → 产品消歧 → ACL 谓词 → 路由 → 检索/取数 → 抽取式生成
→ 字面/数值校验 → 状态机 → 审计。

生成器是**抽取式**的：答案句直接来自证据或 cell，不调 LLM。这样骨架先保证
"引用真实、数值零改写、拒答确定"；LLM 生成器后续替换 `_generate_*` 即可，校验层不变。
"""

from __future__ import annotations

import json
import re
import time
import uuid
from dataclasses import dataclass, field

from .breaker import Breaker
from .config import MAX_EVIDENCE_CHARS
from .contract import (
    AnswerRequest,
    AnswerResponse,
    Candidate,
    Citation,
    Evidence,
    Latency,
    LookupValue,
    Principal,
    QueryRequest,
    QueryResponse,
    VerifyRequest,
    VerifyResponse,
)
from .retrieve import (
    LookupHit,
    evidence_from_rows,
    extract_terms,
    is_lookup_query,
    lookup,
    normalize_text,
    search,
)
from .store import Store
from .verify import extract_markers, verify_answer

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
    "NUMERIC_MISMATCH": "检索到的依据与答案数值不一致，已中止输出。",
    "SPAN_UNRESOLVED": "答案引用无法解析到证据，已中止输出。",
    "MISSING_CITATION": "答案缺少可验证引用，已中止输出。",
    "UNSUPPORTED_CLAIM": "答案未获得证据支持，已中止输出。",
    "BREAKER_LOCKED": "本次会话的检索已暂时锁定，已转人工接管。",
    "KNOWLEDGE_UNAVAILABLE": "知识服务暂不可用，请稍后再试。",
}

LOOKUP_ANSWER_TEMPLATE = "{label}为{value}{unit}[{marker}]。"


def new_trace_id() -> str:
    return f"tr-{uuid.uuid4().hex[:16]}"


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


def _split_sentences(text: str) -> list[str]:
    return [part.strip() for part in re.split(r"[。；;\n]+", text) if part.strip()]


def _pick_sentence(text: str, query: str) -> str:
    terms = extract_terms(query)
    sentences = _split_sentences(text)
    if not sentences:
        return text
    scored = []
    for sentence in sentences:
        score = sum(1 for term in terms if term in sentence)
        scored.append((score, len(sentence), sentence))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return scored[0][2]


def _with_span(evidence: Evidence, sentence: str) -> Evidence:
    start = evidence.text.find(sentence)
    if start < 0:
        return evidence
    return evidence.model_copy(update={"char_start": start, "char_end": start + len(sentence)})


@dataclass
class Engine:
    store: Store
    breaker: Breaker = field(default_factory=Breaker)

    # ── 对外：/v1/answer ──────────────────────────────────────────────────
    def answer(self, request: AnswerRequest) -> AnswerResponse:
        started = time.perf_counter()
        trace_id = request.trace_id or new_trace_id()
        principal = request.principal
        conn = self.store.connect()
        try:
            if self.breaker.is_locked(request.session_id):
                return self._refuse(
                    conn, request, trace_id, "LOCKED", "BREAKER_LOCKED", started, 0, []
                )
            if region_mismatch(request.query, principal.region):
                return self._refuse(
                    conn, request, trace_id, "RED", "SCOPE_EMPTY", started, 0, []
                )

            visible = self.store.visible_chunk_ids(conn, principal)
            products = mentioned_products(request.query)
            if len(products) == 1:
                visible = self._filter_visible_by_product(conn, visible, products[0])
            if not visible:
                return self._refuse(
                    conn, request, trace_id, "RED", "SCOPE_EMPTY", started, 0, []
                )

            if len(products) >= 2:
                candidates = self._candidates(conn, principal, products)
                if len(candidates) >= 2:
                    response = AnswerResponse(
                        trace_id=trace_id,
                        kind="disambiguation",
                        answer="您指的是哪一只产品？",
                        candidates=candidates,
                        verdict="AMBER_DISAMBIGUATION",
                        reason_code="NEED_DISAMBIGUATION",
                        latency_ms=Latency(
                            retrieval=_elapsed_ms(started),
                            total=_elapsed_ms(started),
                        ),
                    )
                    self._audit(
                        conn, request, trace_id, visible, [], "disambiguation",
                        "AMBER_DISAMBIGUATION", "NEED_DISAMBIGUATION", response.answer,
                        _elapsed_ms(started),
                    )
                    return response

            route = "lookup" if is_lookup_query(request.query) else "hybrid"
            retrieval_started = time.perf_counter()
            evidence: list[Evidence] = []
            values: list[LookupValue] = []
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
            if not evidence:
                evidence = search(self.store, conn, visible, request.query)
            retrieval_ms = _elapsed_ms(retrieval_started)

            if not evidence:
                return self._refuse(
                    conn, request, trace_id, "RED", "EMPTY_RETRIEVAL", started, retrieval_ms, []
                )

            generation_started = time.perf_counter()
            if values:
                answer_text = self._generate_lookup(values[0], "K1")
            else:
                sentence = _pick_sentence(evidence[0].text, request.query)
                evidence[0] = _with_span(evidence[0], sentence)
                answer_text = f"{sentence}[K1]。"
            generation_ms = _elapsed_ms(generation_started)

            verify_started = time.perf_counter()
            cell_values = [str(row["value_text"]) for row in self.store.cells_for(conn, [e.chunk_id for e in evidence])]
            verified = verify_answer(answer_text, evidence, cell_values, trace_id=trace_id)
            verify_ms = _elapsed_ms(verify_started)

            if verified.verdict == "RED":
                return self._refuse(
                    conn, request, trace_id, "RED", verified.reason_code or "UNSUPPORTED_CLAIM",
                    started, retrieval_ms, [e.chunk_id for e in evidence], verified,
                )

            final_text = answer_text
            if verified.verdict == "AMBER_INFERRED":
                final_text = f"（推断性回答）{answer_text}"

            response = AnswerResponse(
                trace_id=trace_id,
                kind="answer",
                answer=final_text,
                citations=verified.citations,
                evidence=evidence,
                verdict=verified.verdict,
                reason_code=verified.reason_code,
                latency_ms=Latency(
                    retrieval=retrieval_ms,
                    generation=generation_ms,
                    verify=verify_ms,
                    total=_elapsed_ms(started),
                ),
            )
            self._audit(
                conn, request, trace_id, visible, [e.chunk_id for e in evidence], route,
                verified.verdict, verified.reason_code, final_text, _elapsed_ms(started),
            )
            self.breaker.record(request.session_id, verified.verdict, verified.reason_code)
            return response
        finally:
            conn.close()

    # ── 对外：/v1/query（只返回证据/取数） ──────────────────────────────
    def query(self, request: QueryRequest) -> QueryResponse:
        started = time.perf_counter()
        trace_id = request.trace_id or new_trace_id()
        principal = request.principal
        conn = self.store.connect()
        try:
            if self.breaker.is_locked(request.session_id):
                return QueryResponse(
                    trace_id=trace_id, kind="refusal", answer=REFUSAL_MESSAGES["BREAKER_LOCKED"],
                    verdict="LOCKED", reason_code="BREAKER_LOCKED",
                    latency_ms=Latency(total=_elapsed_ms(started)),
                )
            if region_mismatch(request.query, principal.region):
                return QueryResponse(
                    trace_id=trace_id, kind="refusal", answer=REFUSAL_MESSAGES["SCOPE_EMPTY"],
                    verdict="RED", reason_code="SCOPE_EMPTY",
                    latency_ms=Latency(total=_elapsed_ms(started)),
                )
            visible = self.store.visible_chunk_ids(conn, principal)
            products = mentioned_products(request.query)
            if len(products) == 1:
                visible = self._filter_visible_by_product(conn, visible, products[0])
            if not visible:
                return QueryResponse(
                    trace_id=trace_id, kind="refusal", answer=REFUSAL_MESSAGES["SCOPE_EMPTY"],
                    verdict="RED", reason_code="SCOPE_EMPTY",
                    latency_ms=Latency(total=_elapsed_ms(started)),
                )
            if len(products) >= 2:
                candidates = self._candidates(conn, principal, products)
                if len(candidates) >= 2:
                    return QueryResponse(
                        trace_id=trace_id, kind="disambiguation",
                        answer="您指的是哪一只产品？", candidates=candidates,
                        verdict="AMBER_DISAMBIGUATION", reason_code="NEED_DISAMBIGUATION",
                        latency_ms=Latency(total=_elapsed_ms(started)),
                    )
            route = "lookup" if is_lookup_query(request.query) else "hybrid"
            evidence: list[Evidence] = []
            values: list[LookupValue] = []
            if route == "lookup":
                hits = lookup(self.store, conn, visible, request.query)
                if hits:
                    evidence = self._evidence_for_chunks(conn, [hits[0].chunk_id])
                    values = [
                        LookupValue(
                            label=hit.label, value_text=hit.value_text,
                            unit=hit.unit, cell_ref=f"c-{hit.cell_id}",
                        )
                        for hit in hits
                    ]
            if not evidence:
                evidence = search(self.store, conn, visible, request.query)
            if not evidence:
                return QueryResponse(
                    trace_id=trace_id, kind="refusal", answer=REFUSAL_MESSAGES["EMPTY_RETRIEVAL"],
                    visible_count=len(visible), verdict="RED", reason_code="EMPTY_RETRIEVAL",
                    latency_ms=Latency(total=_elapsed_ms(started)),
                )
            kind = "lookup" if values else "evidence"
            return QueryResponse(
                trace_id=trace_id, kind=kind, route=route, visible_count=len(visible),
                evidence=evidence, values=values,
                latency_ms=Latency(retrieval=_elapsed_ms(started), total=_elapsed_ms(started)),
            )
        finally:
            conn.close()

    # ── 对外：/v1/verify ─────────────────────────────────────────────────
    def verify(self, request: VerifyRequest) -> VerifyResponse:
        conn = self.store.connect()
        try:
            evidence: list[Evidence] = []
            for trace_id in request.trace_ids:
                row = conn.execute(
                    "SELECT evidence_ids FROM retrieval_log WHERE trace_id = ?", (trace_id,)
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
                    verdict="RED", reason_code="SPAN_UNRESOLVED",
                    latency_ms=Latency(total=0),
                )
            cell_values = [
                str(cell["value_text"])
                for cell in self.store.cells_for(conn, [item.chunk_id for item in evidence])
            ]
            return verify_answer(
                request.answer_text, evidence, cell_values,
                require_citations=request.options.require_citations,
                trace_id=request.trace_ids[0] if request.trace_ids else None,
            )
        finally:
            conn.close()

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

    @staticmethod
    def _generate_lookup(hit: LookupValue, marker: str) -> str:
        return LOOKUP_ANSWER_TEMPLATE.format(
            label=hit.label, value=hit.value_text, unit=hit.unit, marker=marker
        )

    def _refuse(
        self,
        conn,
        request: AnswerRequest,
        trace_id: str,
        verdict: str,
        reason_code: str,
        started: float,
        retrieval_ms: int,
        evidence_ids: list[int],
        verified: VerifyResponse | None = None,
    ) -> AnswerResponse:
        message = REFUSAL_MESSAGES.get(reason_code, REFUSAL_MESSAGES["UNSUPPORTED_CLAIM"])
        response = AnswerResponse(
            trace_id=trace_id,
            kind="refusal",
            answer=message,
            evidence=[],
            citations=verified.citations if verified is not None else [],
            verdict=verdict,  # type: ignore[arg-type]
            reason_code=reason_code,
            latency_ms=Latency(
                retrieval=retrieval_ms,
                verify=0,
                total=_elapsed_ms(started),
            ),
        )
        self._audit(
            conn, request, trace_id, set(), evidence_ids, "hybrid",
            verdict, reason_code, message, _elapsed_ms(started),
        )
        self.breaker.record(request.session_id, verdict, reason_code)
        return response

    def _audit(
        self,
        conn,
        request: AnswerRequest,
        trace_id: str,
        visible: set[int],
        evidence_ids: list[int],
        route: str,
        verdict: str,
        reason_code: str | None,
        answer_text: str,
        latency_ms: int,
    ) -> None:
        now = request.principal.now.isoformat()
        self.store.log_retrieval(
            conn,
            trace_id=trace_id,
            session_id=request.session_id,
            query_norm=request.query,
            predicate_json=json.dumps(request.principal.model_dump(mode="json"), ensure_ascii=False),
            visible_count=len(visible),
            evidence_ids=evidence_ids,
            route=route,
            verdict=verdict,
            reason_code=reason_code,
            latency_ms=latency_ms,
            created_at=now,
        )
        self.store.log_answer(
            conn,
            trace_id=trace_id,
            session_id=request.session_id,
            answer_text=answer_text,
            verdict=verdict,
            reason_code=reason_code,
            latency_ms=latency_ms,
            created_at=now,
        )
