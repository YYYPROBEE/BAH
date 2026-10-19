"""离线 ingest CLI（唯一写口）。

    python -m banking_rag.ingest --db data/knowledge.sqlite

真实语料接入后，本文件应调用 ingest/parse → chunk → metadata → sentinel → embed；
骨架版直接写 demo_corpus。
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
    print(f"ingested demo corpus: docs={docs} chunks={chunks} corpus_version={version}")


if __name__ == "__main__":
    main()
