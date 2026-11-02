"""离线管理 CLI（唯一写口）：熔断复位、向量重建、状态查看。

    python -m banking_rag.admin reset-breaker --session s-1 --actor console
    python -m banking_rag.admin show-breaker --session s-1
    python -m banking_rag.admin rebuild-embeddings

纪律：复位是解锁的唯一路径，actor 必须留痕；重建向量会先清空再回填，期间不要对外服务。
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

from .breaker import Breaker
from .config import DEFAULT_DB
from .store import Store, load_sqlite_vec


def _reset(db: Path, session: str, actor: str) -> int:
    store = Store(db, backfill=False)
    conn = store.connect()
    try:
        changed = Breaker().reset(conn, session, actor=actor)
        state = Breaker().state(conn, session)
    finally:
        conn.close()
    print(
        json.dumps(
            {
                "session": session,
                "reset": changed,
                "consecutiveRed": state.consecutive_red,
                "lockedUntil": state.locked_until,
                "actor": actor,
            },
            ensure_ascii=False,
        )
    )
    return 0


def _show(db: Path, session: str) -> int:
    store = Store(db, backfill=False)
    conn = store.connect()
    try:
        state = Breaker().state(conn, session)
        events = store.breaker_events(conn, session)
    finally:
        conn.close()
    print(
        json.dumps(
            {
                "session": state.session_id,
                "consecutiveRed": state.consecutive_red,
                "injectionHits": state.injection_hits,
                "lockedUntil": state.locked_until,
                "lastReason": state.last_reason,
                "events": events,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def _rebuild(db: Path) -> int:
    """清空向量列与 vec0 表，再按当前嵌入版本全量回填。"""

    conn = sqlite3.connect(db)
    try:
        load_sqlite_vec(conn)
        conn.execute("UPDATE chunks SET embedding = NULL, embed_version = NULL")
        try:
            conn.execute("DELETE FROM vec_chunks")
        except sqlite3.OperationalError:
            pass
        conn.commit()
    finally:
        conn.close()

    store = Store(db)
    conn = store.connect()
    try:
        docs, chunks = store.counts(conn)
        version = store.corpus_version(conn)
    finally:
        conn.close()
    print(
        json.dumps(
            {
                "rebuilt": True,
                "docs": docs,
                "chunks": chunks,
                "embedVersion": store.embed_version,
                "embedding": "on" if store.embedding_on else "off",
                "corpusVersion": version,
            },
            ensure_ascii=False,
        )
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="banking_rag.admin")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    sub = parser.add_subparsers(dest="command", required=True)

    reset = sub.add_parser("reset-breaker", help="人工复位会话熔断")
    reset.add_argument("--session", required=True)
    reset.add_argument("--actor", default="console")

    show = sub.add_parser("show-breaker", help="查看会话熔断状态")
    show.add_argument("--session", required=True)

    sub.add_parser("rebuild-embeddings", help="按当前模型全量重建向量")

    args = parser.parse_args()
    if args.command == "reset-breaker":
        return _reset(args.db, args.session, args.actor)
    if args.command == "show-breaker":
        return _show(args.db, args.session)
    return _rebuild(args.db)


if __name__ == "__main__":
    raise SystemExit(main())
