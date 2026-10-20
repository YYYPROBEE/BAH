"""RRF 融合（Reciprocal Rank Fusion）+ tier 权威先验。

设计稿 §6.4 step 5：以 tier 权重替代独立 rerank。融合是纯函数，便于确定性单测。

    score(chunk) = Σ_channel 1 / (k + rank_channel)   × tier_weight

- 只对"进入某通道候选列表"的 chunk 计分；两通道都未命中的不参与；
- tier 权重只放大/缩小融合分，不改变"先谓词后打分"的可见集边界；
- 排序 tie-break：final 降序 → tier 升序 → chunk_id 升序（确定性）。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .config import RRF_K, TIER_WEIGHTS, TOP_K


@dataclass(frozen=True)
class ChannelHit:
    chunk_id: int
    rank: int
    score: float


@dataclass(frozen=True)
class FusedHit:
    chunk_id: int
    score: float
    tier: int
    tier_weight: float
    ranks: dict[str, int] = field(default_factory=dict)
    raw_scores: dict[str, float] = field(default_factory=dict)

    def as_dict(self) -> dict[str, object]:
        return {
            "chunkId": self.chunk_id,
            "score": round(self.score, 6),
            "tier": self.tier,
            "tierWeight": self.tier_weight,
            "ranks": self.ranks,
            "rawScores": {key: round(value, 6) for key, value in self.raw_scores.items()},
        }


def tier_weight(tier: int) -> float:
    return TIER_WEIGHTS.get(tier, 1.0)


def rrf_fuse(
    channels: dict[str, list[ChannelHit]],
    tiers: dict[int, int],
    *,
    k: int = RRF_K,
    top_k: int = TOP_K,
) -> list[FusedHit]:
    """channels: 通道名 → 已按相关度排序的命中；tiers: chunk_id → tier。"""

    fused: dict[int, dict[str, object]] = {}
    for name, hits in channels.items():
        for hit in hits:
            if hit.chunk_id not in tiers:
                continue
            entry = fused.setdefault(
                hit.chunk_id,
                {"score": 0.0, "ranks": {}, "raw": {}},
            )
            entry["score"] = float(entry["score"]) + 1.0 / (k + hit.rank)
            ranks = entry["ranks"]
            raw = entry["raw"]
            assert isinstance(ranks, dict) and isinstance(raw, dict)
            ranks[name] = hit.rank
            raw[name] = hit.score

    result: list[FusedHit] = []
    for chunk_id, entry in fused.items():
        tier = tiers[chunk_id]
        weight = tier_weight(tier)
        if weight <= 0:
            continue
        ranks = entry["ranks"]
        raw = entry["raw"]
        assert isinstance(ranks, dict) and isinstance(raw, dict)
        result.append(
            FusedHit(
                chunk_id=chunk_id,
                score=float(entry["score"]) * weight,
                tier=tier,
                tier_weight=weight,
                ranks=dict(ranks),
                raw_scores=dict(raw),
            )
        )

    result.sort(key=lambda item: (-item.score, item.tier, item.chunk_id))
    return result[:top_k]


def as_channel_hits(rows: list[tuple[int, float]]) -> list[ChannelHit]:
    """把 (chunk_id, score) 列表转成带名次的 ChannelHit；名次从 1 开始。"""

    return [
        ChannelHit(chunk_id=chunk_id, rank=index, score=score)
        for index, (chunk_id, score) in enumerate(rows, start=1)
    ]
