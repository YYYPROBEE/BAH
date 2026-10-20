"""FastAPI 装配与路由（sidecar 唯一进程入口）。

HTTP 面只读：/v1/answer、/v1/query、/v1/verify（内部/调试）、/v1/audit/*、/healthz。
ingest 走离线 CLI（banking_rag.ingest），不开 HTTP 写口。
证据面板（React 构建产物）挂在 /panel；未构建时不影响 API。
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from .contract import (
    AnswerRequest,
    AnswerResponse,
    HealthResponse,
    QueryRequest,
    QueryResponse,
    VerifyRequest,
    VerifyResponse,
)
from .engine import Engine
from .llm import LLM
from .store import Store

TOKEN_ENV = "BAH_KNOWLEDGE_TOKEN"
PANEL_DIST = Path(__file__).resolve().parents[2] / "web" / "evidence_panel" / "dist"


def _require_token(authorization: str | None = Header(default=None)) -> None:
    expected = os.environ.get(TOKEN_ENV)
    if not expected:
        return
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail={"code": "UNAUTHORIZED"})


def create_app(
    store: Store | None = None,
    engine: Engine | None = None,
    *,
    llm: LLM | None = None,
) -> FastAPI:
    actual_store = store or Store()
    actual_engine = engine or Engine(actual_store, llm=llm)
    app = FastAPI(
        title="BAH knowledge sidecar",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.get("/healthz", response_model=HealthResponse)
    def health() -> HealthResponse:
        conn = actual_store.connect()
        try:
            return HealthResponse(**actual_store.health(conn))
        finally:
            conn.close()

    @app.post(
        "/v1/answer",
        response_model=AnswerResponse,
        dependencies=[Depends(_require_token)],
    )
    def answer(request: AnswerRequest) -> AnswerResponse:
        return actual_engine.answer(request)

    @app.post(
        "/v1/query",
        response_model=QueryResponse,
        dependencies=[Depends(_require_token)],
    )
    def query(request: QueryRequest) -> QueryResponse:
        return actual_engine.query(request)

    @app.post(
        "/v1/verify",
        response_model=VerifyResponse,
        dependencies=[Depends(_require_token)],
    )
    def verify(request: VerifyRequest) -> VerifyResponse:
        return actual_engine.verify(request)

    @app.get("/v1/audit/recent", dependencies=[Depends(_require_token)])
    def recent_audits(limit: int = 20) -> list[dict[str, Any]]:
        conn = actual_store.connect()
        try:
            return actual_store.recent_audits(conn, min(max(limit, 1), 100))
        finally:
            conn.close()

    @app.get("/v1/audit/{trace_id}", dependencies=[Depends(_require_token)])
    def audit(trace_id: str) -> dict[str, Any]:
        conn = actual_store.connect()
        try:
            result = actual_store.audit(conn, trace_id)
        finally:
            conn.close()
        if result is None:
            raise HTTPException(status_code=404, detail={"code": "TRACE_NOT_FOUND"})
        return result

    @app.get("/v1/breaker/{session_id}", dependencies=[Depends(_require_token)])
    def breaker_state(session_id: str) -> dict[str, Any]:
        conn = actual_store.connect()
        try:
            state = actual_engine.breaker.state(conn, session_id)
            events = actual_store.breaker_events(conn, session_id)
        finally:
            conn.close()
        return {
            "sessionId": state.session_id,
            "consecutiveRed": state.consecutive_red,
            "injectionHits": state.injection_hits,
            "lockedUntil": state.locked_until,
            "locked": state.locked and state.locked_until > time.time(),
            "lastReason": state.last_reason,
            "events": events,
        }

    @app.get("/", include_in_schema=False)
    def index() -> RedirectResponse:
        return RedirectResponse(url="/panel/")

    if PANEL_DIST.exists():
        app.mount("/panel", StaticFiles(directory=PANEL_DIST, html=True), name="panel")

    return app


def __getattr__(name: str) -> Any:
    """只在 uvicorn 访问 `banking_rag.main:app` 时建库；测试导入工厂不产生副作用。"""

    if name == "app":
        return create_app()
    raise AttributeError(name)
