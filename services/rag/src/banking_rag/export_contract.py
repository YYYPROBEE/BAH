"""导出 knowledge.v1 的 JSON Schema（契约门禁与 TS 侧校验共用）。

用法：
    python -m banking_rag.export_contract --out contract/knowledge.v1.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from .contract import (
    AnswerRequest,
    AnswerResponse,
    HealthResponse,
    QueryRequest,
    QueryResponse,
    VerifyRequest,
    VerifyResponse,
)

MODELS = {
    "AnswerRequest": AnswerRequest,
    "AnswerResponse": AnswerResponse,
    "QueryRequest": QueryRequest,
    "QueryResponse": QueryResponse,
    "VerifyRequest": VerifyRequest,
    "VerifyResponse": VerifyResponse,
    "HealthResponse": HealthResponse,
}


def build_schema() -> dict[str, Any]:
    return {
        "$id": "https://bah.local/contract/knowledge.v1.json",
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "knowledge.v1",
        "definitions": {
            name: model.model_json_schema(by_alias=True) for name, model in MODELS.items()
        },
    }


def write_schema(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(build_schema(), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=Path("contract/knowledge.v1.json"))
    args = parser.parse_args()
    write_schema(args.out)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
