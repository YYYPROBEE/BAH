"""离线 ingest CLI（唯一写口）。

    python -m banking_rag.ingest --db data/knowledge.sqlite

现状：直接写 demo_corpus（每篇一个 chunk），并生成 sqlite-vec 向量。

TODO(真实语料，已与需求方确认"以后干")：
    ingest/parse.py  → PDF(pdfplumber)/DOCX(python-docx)/XLSX(openpyxl) 三路解析
    ingest/chunk.py  → 结构感知分块（条款/章节边界；表格整体不切）
    ingest/metadata.py → 15 字段元数据 + ACL 四维校验
    ingest/sentinel.py → O7-v2 三维哨兵（来源×指令×数值锚点）
接入顺序与验收锚点见设计稿 §6.3；本文件只保留离线写口，不开 HTTP 写口。
"""

from __future__ import annotations

import argparse
from pathlib import Path

from .config import DEFAULT_DB
from .store import Store


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    args = parser.parse_args()
    store = Store(args.db)
    version = store.ingest_demo()
    conn = store.connect()
    try:
        docs, chunks = store.counts(conn)
    finally:
        conn.close()
    print(
        f"ingested demo corpus: docs={docs} chunks={chunks} "
        f"corpus_version={version} embedding={'on' if store.embedding_on else 'off'} "
        f"embed_version={store.embed_version}"
    )


if __name__ == "__main__":
    main()
