"""本地嵌入（E7：bge-small-zh-v1.5，ONNX / fastembed，不出网）。

- 模型缓存在 `services/rag/models/`（gitignore；离线包随包携带）；
- 懒加载：import 本模块不触发下载，首次 embed 才建会话；
- 版本指纹 `EMBED_VERSION` 写入 chunks.embed_version，供 O15 启动校验；
- 向量统一 L2 归一化，sqlite-vec 用 cosine distance。
"""

from __future__ import annotations

import math
import threading
from collections.abc import Iterable

from .config import (
    EMBED_BATCH,
    EMBED_CACHE_DIR,
    EMBED_MODEL,
    EMBED_VERSION,
    embedding_enabled,
)


def _normalize(vector: Iterable[float]) -> list[float]:
    values = [float(item) for item in vector]
    norm = math.sqrt(sum(item * item for item in values))
    if norm == 0:
        return values
    return [item / norm for item in values]


class Embedder:
    """fastembed 的薄封装；不可用时 `available=False`，调用方退化为 FTS5 单通道。"""

    def __init__(self, model_name: str = EMBED_MODEL, cache_dir: str | None = None) -> None:
        self.model_name = model_name
        self.cache_dir = str(cache_dir or EMBED_CACHE_DIR)
        self._model = None
        self._error: str | None = None
        self._lock = threading.Lock()
        self._cache: dict[str, list[float]] = {}

    @property
    def version(self) -> str:
        return f"fastembed:{self.model_name}"

    @property
    def available(self) -> bool:
        if not embedding_enabled():
            return False
        self._ensure()
        return self._model is not None

    @property
    def error(self) -> str | None:
        return self._error

    def _ensure(self) -> None:
        if self._model is not None or self._error is not None:
            return
        with self._lock:
            if self._model is not None or self._error is not None:
                return
            try:
                from pathlib import Path

                from fastembed import TextEmbedding

                kwargs: dict[str, object] = {
                    "model_name": self.model_name,
                    "cache_dir": self.cache_dir,
                }
                # 离线包路径：snapshot_download 的 local_dir 布局，优先于 HF 缓存。
                local = Path(self.cache_dir) / self.model_name.split("/")[-1]
                if (local / "model_optimized.onnx").exists():
                    kwargs["specific_model_path"] = str(local)
                self._model = TextEmbedding(**kwargs)
            except Exception as exc:  # noqa: BLE001 - 依赖缺失/模型下载失败都要降级
                self._error = f"{type(exc).__name__}: {exc}"

    def _embed(self, texts: list[str], *, query: bool) -> list[list[float]]:
        self._ensure()
        if self._model is None:
            raise RuntimeError(self._error or "embedding unavailable")
        unique = [text for text in dict.fromkeys(texts) if text not in self._cache]
        if unique:
            if query and hasattr(self._model, "query_embed"):
                produced = list(self._model.query_embed(unique, batch_size=EMBED_BATCH))
            elif not query and hasattr(self._model, "passage_embed"):
                produced = list(self._model.passage_embed(unique, batch_size=EMBED_BATCH))
            else:
                produced = list(self._model.embed(unique, batch_size=EMBED_BATCH))
            for text, vector in zip(unique, produced):
                self._cache[text] = _normalize(vector)
        return [self._cache[text] for text in texts]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return self._embed(texts, query=False)

    def embed_query(self, text: str) -> list[float]:
        return self._embed([text], query=True)[0]


_EMBEDDER: Embedder | None = None
_EMBEDDER_LOCK = threading.Lock()


def get_embedder() -> Embedder:
    global _EMBEDDER
    if _EMBEDDER is None:
        with _EMBEDDER_LOCK:
            if _EMBEDDER is None:
                _EMBEDDER = Embedder()
    return _EMBEDDER


def reset_embedder() -> None:
    """测试用：清空单例（切换模型/关闭开关后重新加载）。"""

    global _EMBEDDER
    _EMBEDDER = None


__all__ = ["EMBED_VERSION", "Embedder", "get_embedder", "reset_embedder"]
