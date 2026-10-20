"""SQLite 存储层：docs / chunks / cells / 向量 / 审计 / 熔断。

职责：
1. 把 ACL 四维 + product_id + 时效窗落到列上，供 predicate 先过滤；
2. 维护 FTS5（trigram）与 sqlite-vec（vec0）双通道，两通道共享同一 visible_ids；
3. 提供 cell 取数、审计写入/读取、熔断状态表；
4. 启动时做 schema 迁移、向量回填、嵌入版本校验（O15）。
"""

from __future__ import annotations

import json
import sqlite3
import struct
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import (
    DEFAULT_DB,
    EMBED_DIM,
    EMBED_VERSION,
    MAX_TIER,
    VECTOR_MAX_DISTANCE,
    embedding_enabled,
)
from .demo_corpus import DEMO_DOCS
from .embed import Embedder, get_embedder

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
  contains_table INTEGER NOT NULL DEFAULT 0,
  embed_version TEXT,
  embedding BLOB
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
  created_at TEXT NOT NULL,
  channels_json TEXT,
  breaker_state TEXT,
  cache_hit INTEGER NOT NULL DEFAULT 0
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
  created_at TEXT NOT NULL,
  verify_json TEXT,
  generator TEXT,
  model TEXT
);

CREATE TABLE IF NOT EXISTS corpus_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS breaker_state (
  session_id TEXT PRIMARY KEY,
  consecutive_red INTEGER NOT NULL DEFAULT 0,
  injection_hits INTEGER NOT NULL DEFAULT 0,
  injection_window_start REAL NOT NULL DEFAULT 0,
  locked_until REAL NOT NULL DEFAULT 0,
  last_reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS breaker_log (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event TEXT NOT NULL,
  reason TEXT,
  actor TEXT,
  locked_until REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_scope
  ON chunks(role_required, audience, channel, region, product_id, doc_id);
CREATE INDEX IF NOT EXISTS idx_docs_valid
  ON docs(status, valid_from, valid_to, tier);
CREATE INDEX IF NOT EXISTS idx_breaker_log_session
  ON breaker_log(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_retrieval_created
  ON retrieval_log(created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  chunk_id UNINDEXED,
  doc_id UNINDEXED,
  tokenize='trigram'
);
"""

# 现有库的增量列（表名/列名为常量，不拼用户输入）。
MIGRATIONS: tuple[tuple[str, str, str], ...] = (
    ("chunks", "embed_version", "TEXT"),
    ("chunks", "embedding", "BLOB"),
    ("retrieval_log", "channels_json", "TEXT"),
    ("retrieval_log", "breaker_state", "TEXT"),
    ("retrieval_log", "cache_hit", "INTEGER NOT NULL DEFAULT 0"),
    ("answer_log", "verify_json", "TEXT"),
    ("answer_log", "generator", "TEXT"),
    ("answer_log", "model", "TEXT"),
)


def serialize_vector(vector: Iterable[float]) -> bytes:
    values = list(vector)
    return struct.pack(f"<{len(values)}f", *values)


@dataclass(frozen=True)
class ChunkRow:
    chunk_id: int
    doc_id: str
    text: str
    title: str
    tier: int
    clause_no: str | None
    product_id: str | None


class EmbedVersionMismatch(RuntimeError):
    """库里同时存在多个嵌入版本（O15 指纹闸）。"""


class Store:
    """一个 SQLite 文件一个 Store；请求内短连接，WAL 由连接本身保证。"""

    def __init__(
        self,
        db_path: str | Path = DEFAULT_DB,
        *,
        embedder: Embedder | None = None,
        backfill: bool = True,
    ) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.embedder = embedder or get_embedder()
        self.embedding_on = False
        self.embed_version = EMBED_VERSION if embedding_enabled() else "off"
        self._vec_loaded = False
        self._knn_in_supported: bool | None = None

        conn = self.connect()
        try:
            conn.executescript(SCHEMA)
            self._migrate(conn)
            self._ensure_vector_table(conn)
            if self._is_empty(conn):
                self.ingest_demo(conn)
            elif backfill:
                self.backfill_embeddings(conn)
            self._check_embed_versions(conn)
            self.embedding_on = self._vector_count(conn) > 0
        finally:
            conn.close()

    # ── 连接与迁移 ────────────────────────────────────────────────────────
    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA synchronous=NORMAL")
        self._vec_loaded = load_sqlite_vec(conn)
        return conn

    @staticmethod
    def _is_empty(conn: sqlite3.Connection) -> bool:
        row = conn.execute("SELECT COUNT(*) AS n FROM docs").fetchone()
        return int(row["n"] if row is not None else 0) == 0

    @staticmethod
    def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
        return {str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})")}

    def _migrate(self, conn: sqlite3.Connection) -> None:
        for table, column, ddl in MIGRATIONS:
            if column not in self._columns(conn, table):
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
        conn.commit()

    def _ensure_vector_table(self, conn: sqlite3.Connection) -> bool:
        if not self._vec_loaded:
            return False
        try:
            conn.execute(
                f"""
                CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
                  chunk_id INTEGER PRIMARY KEY,
                  embedding float[{EMBED_DIM}] distance_metric=cosine
                )
                """
            )
            conn.commit()
            return True
        except sqlite3.OperationalError:
            return False

    def _check_embed_versions(self, conn: sqlite3.Connection) -> None:
        rows = conn.execute(
            "SELECT DISTINCT embed_version FROM chunks WHERE embed_version IS NOT NULL"
        ).fetchall()
        versions = {str(row["embed_version"]) for row in rows}
        if len(versions) > 1:
            raise EmbedVersionMismatch(
                f"索引中存在多个嵌入版本：{sorted(versions)}；请重建索引（--rebuild-embeddings）"
            )

    # ── 入库 ──────────────────────────────────────────────────────────────
    def ingest_demo(self, conn: sqlite3.Connection | None = None) -> int:
        """重置并写入演示语料；返回 corpus_version。"""

        own = conn is None
        connection = conn or self.connect()
        try:
            connection.execute("DELETE FROM chunks_fts")
            connection.execute("DELETE FROM cells")
            connection.execute("DELETE FROM chunks")
            connection.execute("DELETE FROM docs")
            # 语料重建后旧 trace 的 evidence_ids 已无意义；审计随语料版本一起重置。
            connection.execute("DELETE FROM retrieval_log")
            connection.execute("DELETE FROM answer_log")
            if self._vec_loaded:
                try:
                    connection.execute("DELETE FROM vec_chunks")
                except sqlite3.OperationalError:
                    pass

            vectors = self._embed_texts([str(doc["text"]) for doc in DEMO_DOCS])
            for doc, vector in zip(DEMO_DOCS, vectors):
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
                      channel, region, product_id, contains_table, embed_version, embedding
                    ) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                        self.embed_version if vector is not None else None,
                        serialize_vector(vector) if vector is not None else None,
                    ),
                )
                chunk_id = int(cursor.lastrowid)
                connection.execute(
                    "INSERT INTO chunks_fts (text, chunk_id, doc_id) VALUES (?, ?, ?)",
                    (doc["text"], chunk_id, doc["doc_id"]),
                )
                if vector is not None:
                    self._upsert_vector(connection, chunk_id, vector)
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

    def backfill_embeddings(self, conn: sqlite3.Connection | None = None) -> int:
        """为缺失/过期向量的 chunk 补齐嵌入；返回补齐条数。"""

        own = conn is None
        connection = conn or self.connect()
        try:
            rows = connection.execute(
                """
                SELECT chunk_id, text FROM chunks
                WHERE embedding IS NULL OR embed_version IS NULL OR embed_version != ?
                """,
                (self.embed_version,),
            ).fetchall()
            if not rows:
                return 0
            vectors = self._embed_texts([str(row["text"]) for row in rows])
            updated = 0
            for row, vector in zip(rows, vectors):
                if vector is None:
                    continue
                connection.execute(
                    "UPDATE chunks SET embed_version = ?, embedding = ? WHERE chunk_id = ?",
                    (self.embed_version, serialize_vector(vector), int(row["chunk_id"])),
                )
                self._upsert_vector(connection, int(row["chunk_id"]), vector)
                updated += 1
            connection.commit()
            return updated
        finally:
            if own:
                connection.close()

    def _embed_texts(self, texts: list[str]) -> list[list[float] | None]:
        if not embedding_enabled() or not texts:
            return [None for _ in texts]
        try:
            return list(self.embedder.embed_documents(texts))
        except Exception:  # noqa: BLE001 - 模型不可用即降级，不阻断入库
            self.embed_version = "off"
            return [None for _ in texts]

    def _upsert_vector(self, conn: sqlite3.Connection, chunk_id: int, vector: list[float]) -> None:
        if not self._vec_loaded:
            return
        try:
            conn.execute("DELETE FROM vec_chunks WHERE chunk_id = ?", (chunk_id,))
            conn.execute(
                "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
                (chunk_id, serialize_vector(vector)),
            )
        except sqlite3.OperationalError:
            pass

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

    def _vector_count(self, conn: sqlite3.Connection) -> int:
        if not self._vec_loaded:
            return 0
        try:
            row = conn.execute("SELECT COUNT(*) AS n FROM vec_chunks").fetchone()
            return int(row["n"]) if row is not None else 0
        except sqlite3.OperationalError:
            return 0

    # ── 可见集（O1 两段式第一段） ─────────────────────────────────────────
    def visible_chunk_ids(self, conn: sqlite3.Connection, principal: Any) -> set[int]:
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

    # ── 双通道检索 ────────────────────────────────────────────────────────
    def fts_ranked(
        self,
        conn: sqlite3.Connection,
        visible_ids: Iterable[int],
        terms: list[str],
        limit: int,
    ) -> list[tuple[int, float]]:
        """FTS5 通道；返回 (chunk_id, bm25)，bm25 越小越相关。"""

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
                [query, *ids, limit],
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
                [*(f"%{term}%" for term in terms), *ids, limit],
            ).fetchall()
        return [(int(row["chunk_id"]), float(row["score"])) for row in rows]

    def vector_ranked(
        self,
        conn: sqlite3.Connection,
        visible_ids: Iterable[int],
        query_vector: list[float],
        limit: int,
    ) -> list[tuple[int, float]]:
        """sqlite-vec 通道；返回 (chunk_id, cosine distance)，越小越相关。

        两段式约束：先物化 visible_ids，再让 KNN 只在该集合内打分。
        vec0 的 `rowid IN` 过滤在部分版本不可用，此时回退到标量距离函数
        （仍是 sqlite-vec 实现，且 ACL 语义不变）。
        """

        ids = list(visible_ids)
        if not ids or not query_vector or not self._vec_loaded:
            return []
        blob = serialize_vector(query_vector)
        placeholders = ",".join("?" for _ in ids)

        if self._knn_in_supported is not False:
            try:
                rows = conn.execute(
                    f"""
                    SELECT chunk_id, distance
                    FROM vec_chunks
                    WHERE embedding MATCH ? AND k = ?
                      AND chunk_id IN ({placeholders})
                    ORDER BY distance ASC
                    LIMIT ?
                    """,
                    [blob, min(len(ids), max(limit * 3, limit)), *ids, limit],
                ).fetchall()
                self._knn_in_supported = True
                return [
                    (int(row["chunk_id"]), float(row["distance"]))
                    for row in rows
                    if float(row["distance"]) <= VECTOR_MAX_DISTANCE
                ][:limit]
            except sqlite3.OperationalError:
                self._knn_in_supported = False

        try:
            rows = conn.execute(
                f"""
                SELECT chunk_id, vec_distance_cosine(embedding, ?) AS distance
                FROM chunks
                WHERE embedding IS NOT NULL AND chunk_id IN ({placeholders})
                ORDER BY distance ASC
                LIMIT ?
                """,
                [blob, *ids, limit],
            ).fetchall()
        except sqlite3.OperationalError:
            return []
        return [
            (int(row["chunk_id"]), float(row["distance"]))
            for row in rows
            if float(row["distance"]) <= VECTOR_MAX_DISTANCE
        ][:limit]

    def chunks_by_ids(self, conn: sqlite3.Connection, ids: Iterable[int]) -> dict[int, ChunkRow]:
        result: dict[int, ChunkRow] = {}
        for chunk_id in ids:
            try:
                result[int(chunk_id)] = self._chunk(conn, int(chunk_id), 0.0)[0]
            except KeyError:
                continue
        return result

    def evidence_by_ids(self, conn: sqlite3.Connection, chunk_ids: Iterable[int]) -> list[ChunkRow]:
        result: list[ChunkRow] = []
        for chunk_id in chunk_ids:
            try:
                result.append(self._chunk(conn, int(chunk_id), 0.0)[0])
            except KeyError:
                continue
        return result

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

    # ── 审计 ──────────────────────────────────────────────────────────────
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
        channels_json: str | None = None,
        breaker_state: str = "CLOSED",
        cache_hit: int = 0,
    ) -> None:
        conn.execute(
            """
            INSERT INTO retrieval_log (
              trace_id, session_id, query_norm, predicate_json, visible_count,
              evidence_ids, route, verdict, reason_code, latency_ms, created_at,
              channels_json, breaker_state, cache_hit
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(trace_id) DO UPDATE SET
              visible_count=excluded.visible_count,
              evidence_ids=excluded.evidence_ids,
              route=excluded.route,
              verdict=excluded.verdict,
              reason_code=excluded.reason_code,
              latency_ms=excluded.latency_ms,
              channels_json=excluded.channels_json,
              breaker_state=excluded.breaker_state,
              cache_hit=excluded.cache_hit
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
                channels_json,
                breaker_state,
                cache_hit,
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
        verify_json: str | None = None,
        generator: str = "extractive",
        model: str | None = None,
        tokens_in: int = 0,
        tokens_out: int = 0,
    ) -> None:
        conn.execute(
            """
            INSERT INTO answer_log (
              trace_id, session_id, answer_text, verdict, reason_code,
              tokens_in, tokens_out, latency_ms, created_at,
              verify_json, generator, model
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(trace_id) DO UPDATE SET
              answer_text=excluded.answer_text,
              verdict=excluded.verdict,
              reason_code=excluded.reason_code,
              tokens_in=excluded.tokens_in,
              tokens_out=excluded.tokens_out,
              latency_ms=excluded.latency_ms,
              verify_json=excluded.verify_json,
              generator=excluded.generator,
              model=excluded.model
            """,
            (
                trace_id,
                session_id,
                answer_text,
                verdict,
                reason_code,
                tokens_in,
                tokens_out,
                latency_ms,
                created_at,
                verify_json,
                generator,
                model,
            ),
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
        session_id = str(retrieval["session_id"]) if retrieval is not None else ""
        breaker = conn.execute(
            "SELECT * FROM breaker_state WHERE session_id = ?", (session_id,)
        ).fetchone()
        evidence: list[dict[str, Any]] = []
        if retrieval is not None:
            try:
                ids = json.loads(str(retrieval["evidence_ids"]))
            except (ValueError, TypeError):
                ids = []
            for row in self.evidence_by_ids(conn, ids):
                evidence.append(
                    {
                        "chunkId": row.chunk_id,
                        "docId": row.doc_id,
                        "title": row.title,
                        "clauseNo": row.clause_no,
                        "tier": row.tier,
                        "text": row.text,
                    }
                )
        events = self.breaker_events(conn, session_id, limit=10) if session_id else []
        return {
            "traceId": trace_id,
            "retrieval": dict(retrieval) if retrieval is not None else None,
            "answer": dict(answer) if answer is not None else None,
            "breaker": dict(breaker) if breaker is not None else None,
            "breakerEvents": events,
            "evidence": evidence,
        }

    def recent_audits(self, conn: sqlite3.Connection, limit: int = 20) -> list[dict[str, Any]]:
        rows = conn.execute(
            """
            SELECT r.trace_id, r.session_id, r.query_norm, r.visible_count,
                   r.route, r.verdict, r.reason_code, r.latency_ms, r.created_at,
                   a.generator, a.model
            FROM retrieval_log r
            LEFT JOIN answer_log a ON a.trace_id = r.trace_id
            ORDER BY r.rowid DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [dict(row) for row in rows]

    def breaker_events(self, conn: sqlite3.Connection, session_id: str, limit: int = 20) -> list[dict[str, Any]]:
        rows = conn.execute(
            """
            SELECT * FROM breaker_log WHERE session_id = ?
            ORDER BY log_id DESC LIMIT ?
            """,
            (session_id, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    # ── 健康检查 ──────────────────────────────────────────────────────────
    def health(self, conn: sqlite3.Connection) -> dict[str, Any]:
        docs, chunks = self.counts(conn)
        return {
            "status": "ok" if chunks > 0 else "degraded",
            "schemaVersion": "knowledge.v1",
            "corpusVersion": self.corpus_version(conn),
            "embedVersion": self.embed_version if self.embedding_on else "off",
            "docs": docs,
            "chunks": chunks,
            "embedding": "on" if self.embedding_on else "off",
        }


def load_sqlite_vec(conn: sqlite3.Connection) -> bool:
    """每个连接都要加载扩展（SQLite 扩展是连接级的）。"""

    try:
        import sqlite_vec

        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
        return True
    except Exception:  # noqa: BLE001 - 扩展缺失/平台不支持时降级为 FTS5 单通道
        return False
