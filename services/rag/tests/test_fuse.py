from __future__ import annotations

from banking_rag.fuse import ChannelHit, rrf_fuse


def hits(*rows: tuple[int, int, float]) -> list[ChannelHit]:
    return [ChannelHit(chunk_id=chunk, rank=rank, score=score) for chunk, rank, score in rows]


def test_agreement_across_channels_wins() -> None:
    channels = {
        "fts5": hits((1, 1, -2.0), (2, 2, -1.0), (3, 3, -0.5)),
        "vector": hits((3, 1, 0.1), (1, 2, 0.2), (2, 3, 0.3)),
    }
    tiers = {1: 1, 2: 1, 3: 1}
    fused = rrf_fuse(channels, tiers, k=60, top_k=3)
    # 1 在 FTS 第 1、向量第 2；3 在向量第 1、FTS 第 3 → 1 略高。
    assert fused[0].chunk_id == 1
    assert fused[0].ranks == {"fts5": 1, "vector": 2}


def test_tier_weight_breaks_equal_rank() -> None:
    channels = {"fts5": hits((1, 1, 0.0), (2, 2, 0.0))}
    fused = rrf_fuse(channels, {1: 5, 2: 1}, k=60, top_k=2)
    # 名次更差的 tier1 文档因权威先验反超 tier5。
    assert fused[0].chunk_id == 2
    assert fused[0].tier_weight > fused[1].tier_weight


def test_tier9_is_excluded() -> None:
    channels = {"fts5": hits((9, 1, 0.0), (1, 2, 0.0))}
    fused = rrf_fuse(channels, {9: 9, 1: 1}, k=60, top_k=2)
    assert [item.chunk_id for item in fused] == [1]


def test_tie_break_is_deterministic() -> None:
    channels = {"fts5": hits((7, 1, 0.0), (3, 1, 0.0))}
    fused = rrf_fuse(channels, {7: 3, 3: 3}, k=60, top_k=2)
    assert [item.chunk_id for item in fused] == [3, 7]


def test_empty_channels() -> None:
    assert rrf_fuse({"fts5": [], "vector": []}, {}, k=60, top_k=8) == []
