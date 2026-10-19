"""SQLite 存储层：docs / chunks / cells / audit。

骨架版只做两件事：
1. 把 ACL 四维 + product_id + 时效窗落到列上，供 predicate 先过滤；
2. 提供 FTS5（trigram）检索与 cell 取数的最小查询面。

向量通道（sqlite-vec）留到 RAG 内核批；本文件不假装有向量。
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .config import DEFAULT_DB, MAX_TIER
from .demo_corpus import DEMO_DOCS

SCHEMA = """
CREATE TABLE IF NOT EXISTS docs (
  doc_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  tier INTEGER NOT NULL,
  source TEXT NOT NULL,
  product_id TEXT,
  region TEXT,
  audience TEXT,
  role_required TEXT,
  channel TEXT,
  valid_from TEXT,
  valid_to TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL REFERENCES docs(doc_id),
  seq INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  clause_no TEXT,
  role_required TEXT,
  audience TEXT,
  channel TEXT,
  region TEXT,
  product_id TEXT,
  contains_table INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cells (
  cell_id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id INTEGER NOT NULL REFERENCES chunks(chunk_id),
  sheet TEXT,
  row_key TEXT,
  col_key TEXT,
  header_text TEXT,
  value_text TEXT NOT NULL,
  num_value REAL,
  unit TEXT
);

CREATE TABLE IF NOT EXISTS retrieval_log (
  trace_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  query_norm TEXT NOT NULL,
  predicate_json TEXT NOT NULL,
  visible_count INTEGER NOT NULL,
  evidence_ids TEXT NOT NULL,
  route TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason_code TEXT,
  latency_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS answer_log (
  trace_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  answer_text TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason_code TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS corpus_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_scope
  ON chunks(role_required, audience, channel, region, product_id, doc_id);
CREATE INDEX IF NOT EXISTS idx_docs_valid
  ON docs(status, valid_from, valid_to, tier);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  chunk_id UNINDEXED,
  doc_id UNINDEXED,
  tokenize='trigram'
);
"""


@dataclass(frozen=True)
class ChunkRow:
    chunk_id: int
    doc_id: str
    text: str
    title: str
    tier: int
    clause_no: str | None
    product_id: str | None


class Store:
    """一个 SQLite 文件一个 Store；请求内短连接，WAL 由连接本身保证。"""

    def __init__(self, db_path: str | Path = DEFAULT_DB) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = self.connect()
        try:
            conn.executescript(SCHEMA)
            if self._is_empty(conn):
                self.ingest_demo(conn)
        finally:
            conn.close()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    @staticmethod
    def _is_empty(conn: sqlite3.Connection) -> bool:
        row = conn.execute("SELECT COUNT(*) AS n FROM docs").fetchone()
        return int(row["n"] if row is not None else 0) == 0

    def ingest_demo(self, conn: sqlite3.Connection | None = None) -> int:
        """重置并写入演示语料；返回 corpus_version。"""

        own = conn is None
        connection = conn or self.connect()
        try:
            connection.execute("DELETE FROM chunks_fts")
            connection.execute("DELETE FROM cells")
            connection.execute("DELETE FROM chunks")
            connection.execute("DELETE FROM docs")
            for doc in DEMO_DOCS:
                connection.execute(
                    """
                    INSERT INTO docs (
                      doc_id, title, doc_type, tier, source, product_id, region,
                      audience, role_required, channel, valid_from, valid_to, status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        doc["doc_id"],
                        doc["title"],
                        doc["doc_type"],
                        doc["tier"],
                        doc["source"],
                        doc["product_id"],
                        doc["region"],
                        doc["audience"],
                        doc["role_required"],
                        doc["channel"],
                        doc["valid_from"],
                        doc["valid_to"],
                        doc["status"],
                    ),
                )
                cursor = connection.execute(
                    """
                    INSERT INTO chunks (
                      doc_id, seq, text, clause_no, role_required, audience,
                      channel, region, product_id, contains_table
                    ) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        doc["doc_id"],
                        doc["text"],
                        doc["clause_no"],
                        doc["role_required"],
                        doc["audience"],
                        doc["channel"],
                        doc["region"],
                        doc["product_id"],
                        1 if doc.get("cells") else 0,
                    ),
                )
                chunk_id = int(cursor.lastrowid)
                connection.execute(
                    "INSERT INTO chunks_fts (text, chunk_id, doc_id) VALUES (?, ?, ?)",
                    (doc["text"], chunk_id, doc["doc_id"]),
                )
                for cell in doc.get("cells", []):
                    connection.execute(
                        """
                        INSERT INTO cells (
                          chunk_id, sheet, row_key, col_key, header_text,
                          value_text, num_value, unit
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            chunk_id,
                            cell.get("sheet"),
                            cell.get("row_key"),
                            cell.get("col_key"),
                            cell.get("header_text"),
                            cell["value_text"],
                            cell.get("num_value"),
                            cell.get("unit", ""),
                        ),
                    )
            version = self._bump_version(connection)
            connection.commit()
            return version
        finally:
            if own:
                connection.close()

    @staticmethod
    def _bump_version(conn: sqlite3.Connection) -> int:
        row = conn.execute("SELECT value FROM corpus_meta WHERE key='corpus_version'").fetchone()
        current = int(row["value"]) if row is not None else 0
        version = current + 1
        conn.execute(
            "INSERT INTO corpus_meta(key, value) VALUES('corpus_version', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(version),),
        )
        return version

    def corpus_version(self, conn: sqlite3.Connection | None = None) -> int:
        own = conn is None
        connection = conn or self.connect()
        try:
            row = connection.execute(
                "SELECT value FROM corpus_meta WHERE key='corpus_version'"
            ).fetchone()
            return int(row["value"]) if row is not None else 0
        finally:
            if own:
                connection.close()

    def counts(self, conn: sqlite3.Connection) -> tuple[int, int]:
        docs = conn.execute("SELECT COUNT(*) AS n FROM docs").fetchone()
        chunks = conn.execute("SELECT COUNT(*) AS n FROM chunks").fetchone()
        return int(docs["n"]), int(chunks["n"])

    def visible_chunk_ids(self, conn: sqlite3.Connection, principal: Any) -> set[int]:
        """两段式谓词的第一段：先物化可见集，再约束检索通道。"""

        if not all(
            [
                principal.role,
                principal.audience,
                principal.channel,
                principal.region,
                principal.now,
            ]
        ):
            return set()
        day = principal.now.date().isoformat()
        rows = conn.execute(
            """
            SELECT c.chunk_id
            FROM chunks c
            JOIN docs d ON d.doc_id = c.doc_id
            WHERE (c.role_required IS NULL OR c.role_required = ?)
              AND (c.audience IS NULL OR c.audience = ?)
              AND (c.channel IS NULL OR c.channel = 'all' OR c.channel = ?)
              AND (c.region IS NULL OR c.region = 'ALL' OR c.region = ?)
              AND (d.tier <= ?)
              AND d.status = 'active'
              AND (d.valid_from IS NULL OR d.valid_from <= ?)
              AND (d.valid_to IS NULL OR d.valid_to >= ?)
            """,
            (
                principal.role,
                principal.audience,
                principal.channel,
                principal.region,
                MAX_TIER,
                day,
                day,
            ),
        ).fetchall()
        return {int(row["chunk_id"]) for row in rows}

    def search_chunks(
        self,
        conn: sqlite3.Connection,
        visible_ids: Iterable[int],
        terms: list[str],
        top_k: int,
    ) -> list[tuple[ChunkRow, float]]:
        """FTS5 优先，失败回退 LIKE；返回 (chunk, score)，score 越小越相关。"""

        ids = list(visible_ids)
        if not ids or not terms:
            return []
        placeholders = ",".join("?" for _ in ids)
        query = " OR ".join(terms)
        try:
            rows = conn.execute(
                f"""
                SELECT f.chunk_id AS chunk_id, bm25(chunks_fts) AS score
                FROM chunks_fts f
                WHERE chunks_fts MATCH ?
                  AND f.chunk_id IN ({placeholders})
                ORDER BY score ASC
                LIMIT ?
                """,
                [query, *ids, top_k],
            ).fetchall()
        except sqlite3.OperationalError:
            rows = []
        if not rows:
            like = " OR ".join("c.text LIKE ?" for _ in terms)
            rows = conn.execute(
                f"""
                SELECT c.chunk_id AS chunk_id, 0.0 AS score
                FROM chunks c
                WHERE ({like}) AND c.chunk_id IN ({placeholders})
                LIMIT ?
                """,
                [*(f"%{term}%" for term in terms), *ids, top_k],
            ).fetchall()
        return [self._chunk(conn, int(row["chunk_id"]), float(row["score"])) for row in rows]

    def _chunk(self, conn: sqlite3.Connection, chunk_id: int, score: float) -> tuple[ChunkRow, float]:
        row = conn.execute(
            """
            SELECT c.chunk_id, c.doc_id, c.text, c.clause_no, c.product_id,
                   d.title, d.tier
            FROM chunks c JOIN docs d ON d.doc_id = c.doc_id
            WHERE c.chunk_id = ?
            """,
            (chunk_id,),
        ).fetchone()
        if row is None:
            raise KeyError(f"chunk {chunk_id} 不存在")
        return (
            ChunkRow(
                chunk_id=int(row["chunk_id"]),
                doc_id=str(row["doc_id"]),
                text=str(row["text"]),
                title=str(row["title"]),
                tier=int(row["tier"]),
                clause_no=row["clause_no"],
                product_id=row["product_id"],
            ),
            score,
        )

    def cells_for(self, conn: sqlite3.Connection, visible_ids: Iterable[int]) -> list[sqlite3.Row]:
        ids = list(visible_ids)
        if not ids:
            return []
        placeholders = ",".join("?" for _ in ids)
        return conn.execute(
            f"SELECT * FROM cells WHERE chunk_id IN ({placeholders})",
            ids,
        ).fetchall()

    def evidence_by_ids(self, conn: sqlite3.Connection, chunk_ids: Iterable[int]) -> list[ChunkRow]:
        result: list[ChunkRow] = []
        for chunk_id in chunk_ids:
            try:
                result.append(self._chunk(conn, int(chunk_id), 0.0)[0])
            except KeyError:
                continue
        return result

    def log_retrieval(
        self,
        conn: sqlite3.Connection,
        *,
        trace_id: str,
        session_id: str,
        query_norm: str,
        predicate_json: str,
        visible_count: int,
        evidence_ids: list[int],
        route: str,
        verdict: str,
        reason_code: str | None,
        latency_ms: int,
        created_at: str,
    ) -> None:
        conn.execute(
            """
            INSERT INTO retrieval_log (
              trace_id, session_id, query_norm, predicate_json, visible_count,
              evidence_ids, route, verdict, reason_code, latency_ms, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(trace_id) DO UPDATE SET
              visible_count=excluded.visible_count,
              evidence_ids=excluded.evidence_ids,
              route=excluded.route,
              verdict=excluded.verdict,
              reason_code=excluded.reason_code,
              latency_ms=excluded.latency_ms
            """,
            (
                trace_id,
                session_id,
                query_norm,
                predicate_json,
                visible_count,
                json.dumps(evidence_ids),
                route,
                verdict,
                reason_code,
                latency_ms,
                created_at,
            ),
        )
        conn.commit()

    def log_answer(
        self,
        conn: sqlite3.Connection,
        *,
        trace_id: str,
        session_id: str,
        answer_text: str,
        verdict: str,
        reason_code: str | None,
        latency_ms: int,
        created_at: str,
    ) -> None:
        conn.execute(
            """
            INSERT INTO answer_log (
              trace_id, session_id, answer_text, verdict, reason_code, latency_ms, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(trace_id) DO UPDATE SET
              answer_text=excluded.answer_text,
              verdict=excluded.verdict,
              reason_code=excluded.reason_code,
              latency_ms=excluded.latency_ms
            """,
            (trace_id, session_id, answer_text, verdict, reason_code, latency_ms, created_at),
        )
        conn.commit()

    def audit(self, conn: sqlite3.Connection, trace_id: str) -> dict[str, Any] | None:
        retrieval = conn.execute(
            "SELECT * FROM retrieval_log WHERE trace_id = ?", (trace_id,)
        ).fetchone()
        answer = conn.execute(
            "SELECT * FROM answer_log WHERE trace_id = ?", (trace_id,)
        ).fetchone()
        if retrieval is None and answer is None:
            return None
        return {
            "traceId": trace_id,
            "retrieval": dict(retrieval) if retrieval is not None else None,
            "answer": dict(answer) if answer is not None else None,
        }

    def health(self, conn: sqlite3.Connection) -> dict[str, Any]:
        docs, chunks = self.counts(conn)
        return {
            "status": "ok" if chunks > 0 else "degraded",
            "schemaVersion": "knowledge.v1",
            "corpusVersion": self.corpus_version(conn),
            "embedVersion": "fts5-trigram-only",
            "docs": docs,
            "chunks": chunks,
            "embedding": "off",
        }
