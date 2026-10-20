"""FastAPI 装配与路由（sidecar 唯一进程入口）。

HTTP 面只读：/v1/answer、/v1/query、/v1/verify（内部/调试）、/v1/audit/*、/healthz。
ingest 走离线 CLI（banking_rag.ingest），不开 HTTP 写口。
证据面板（React 构建产物）挂在 /panel；未构建时不影响 API。

鉴权：/healthz 匿名；其余 /v1/* 一律要求 Bearer token。身份/session/now/trace
全部由认证上下文派生，请求体里没有可自证的字段。
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from .auth import AuthContext, AuthError, Authenticator
from .contract import (
    AnswerRequest,
    AnswerResponse,
    HealthResponse,
    QueryRequest,
    QueryResponse,
    VerifyRequest,
    VerifyResponse,
)
from .engine import Engine, trace_for
from .llm import LLM
from .store import Store, TraceConflict

PANEL_DIST = Path(__file__).resolve().parents[2] / "web" / "evidence_panel" / "dist"


def create_app(
    store: Store | None = None,
    engine: Engine | None = None,
    *,
    llm: LLM | None = None,
    authenticator: Authenticator | None = None,
) -> FastAPI:
    actual_store = store or Store()
    actual_engine = engine or Engine(actual_store, llm=llm)
    # 缺配置时在这里 fail-loud，而不是静默放行匿名请求。
    actual_authenticator = authenticator or Authenticator.from_env()
    app = FastAPI(
        title="BAH knowledge sidecar",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    def require_auth(authorization: str | None = Header(default=None)) -> AuthContext:
        try:
            return actual_authenticator.authenticate(authorization)
        except AuthError as exc:
            raise HTTPException(
                status_code=401,
                detail={"code": exc.code, "message": exc.message},
            ) from exc

    @app.get("/healthz", response_model=HealthResponse)
    def health() -> HealthResponse:
        conn = actual_store.connect()
        try:
            return HealthResponse(**actual_store.health(conn))
        finally:
            conn.close()

    @app.post("/v1/answer", response_model=AnswerResponse)
    def answer(
        request: AnswerRequest,
        auth: AuthContext = Depends(require_auth),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> AnswerResponse:
        trace_id = trace_for(auth.subject, idempotency_key)
        try:
            return actual_engine.answer(
                request, auth.principal, auth.session_id, trace_id
            )
        except TraceConflict as exc:
            raise HTTPException(
                status_code=409,
                detail={"code": "TRACE_CONFLICT", "traceId": exc.trace_id},
            ) from exc

    @app.post("/v1/query", response_model=QueryResponse)
    def query(
        request: QueryRequest,
        auth: AuthContext = Depends(require_auth),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> QueryResponse:
        trace_id = trace_for(auth.subject, idempotency_key)
        return actual_engine.query(request, auth.principal, auth.session_id, trace_id)

    @app.post("/v1/verify", response_model=VerifyResponse)
    def verify(
        request: VerifyRequest,
        auth: AuthContext = Depends(require_auth),
    ) -> VerifyResponse:
        return actual_engine.verify(request, auth.session_id)

    @app.get("/v1/audit/recent")
    def recent_audits(
        limit: int = 20,
        auth: AuthContext = Depends(require_auth),
    ) -> list[dict[str, Any]]:
        conn = actual_store.connect()
        try:
            return actual_store.recent_audits(
                conn, auth.session_id, min(max(limit, 1), 100)
            )
        finally:
            conn.close()

    @app.get("/v1/audit/{trace_id}")
    def audit(
        trace_id: str,
        auth: AuthContext = Depends(require_auth),
    ) -> dict[str, Any]:
        conn = actual_store.connect()
        try:
            result = actual_store.audit(conn, trace_id, session_id=auth.session_id)
        finally:
            conn.close()
        if result is None:
            # 跨会话 trace 与不存在一律 404，不泄露他人 trace 是否存在。
            raise HTTPException(status_code=404, detail={"code": "TRACE_NOT_FOUND"})
        return result

    @app.get("/v1/breaker/{session_id}")
    def breaker_state(
        session_id: str,
        auth: AuthContext = Depends(require_auth),
    ) -> dict[str, Any]:
        if session_id != auth.session_id:
            raise HTTPException(status_code=404, detail={"code": "SESSION_NOT_FOUND"})
        conn = actual_store.connect()
        try:
            state = actual_engine.breaker.state(conn, auth.session_id)
            events = actual_store.breaker_events(conn, auth.session_id)
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
