"""FastAPI 装配与路由（sidecar 唯一进程入口）。

HTTP 面只读：/v1/answer、/v1/query、/v1/verify（内部/调试）、/v1/audit/{traceId}、/healthz。
ingest 走离线 CLI（banking_rag.ingest），不开 HTTP 写口。
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException

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
from .store import Store

TOKEN_ENV = "BAH_KNOWLEDGE_TOKEN"


def _require_token(authorization: str | None = Header(default=None)) -> None:
    expected = os.environ.get(TOKEN_ENV)
    if not expected:
        return
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail={"code": "UNAUTHORIZED"})


def create_app(store: Store | None = None, engine: Engine | None = None) -> FastAPI:
    actual_store = store or Store()
    actual_engine = engine or Engine(actual_store)
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

    return app


def __getattr__(name: str) -> Any:
    """只在 uvicorn 访问 `banking_rag.main:app` 时建库；测试导入工厂不产生副作用。"""

    if name == "app":
        return create_app()
    raise AttributeError(name)
