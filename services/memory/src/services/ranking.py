import math
from datetime import datetime, timezone
from typing import Any


# 30-day half-life: λ = ln(2) / 30
_DECAY_LAMBDA = math.log(2) / 30.0


def temporal_decay(created_at: datetime) -> float:
    """
    Exponential temporal decay with a 30-day half-life.
    score = exp(-λ * age_days), λ = ln(2) / 30
    A memory created today scores 1.0; one 30 days old scores 0.5.
    """
    now = datetime.now(timezone.utc)
    age_days = max(0.0, (now - created_at).total_seconds() / 86400)
    return math.exp(-_DECAY_LAMBDA * age_days)


def access_bonus(access_count: int) -> float:
    """Small bonus for frequently accessed memories (capped at 0.1)."""
    return min(0.1, access_count * 0.01)


def combined_relevance(
    cosine_similarity: float,
    importance: float,
    created_at: datetime,
    access_count: int,
) -> float:
    """
    Combined relevance score:
      0.60 * cosine_similarity
    + 0.25 * importance
    + 0.10 * temporal_decay (exponential, 30-day half-life)
    + 0.05 * access_bonus
    """
    score = (
        0.60 * cosine_similarity
        + 0.25 * importance
        + 0.10 * temporal_decay(created_at)
        + 0.05 * access_bonus(access_count)
    )
    return round(min(1.0, max(0.0, score)), 4)


def rank_results(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Score and sort search results by combined relevance."""
    for r in results:
        r["relevance_score"] = combined_relevance(
            cosine_similarity=float(r.get("cosine_similarity", 0)),
            importance=float(r.get("importance", 0.5)),
            created_at=r["created_at"],
            access_count=int(r.get("access_count", 0)),
        )
    results.sort(key=lambda r: r["relevance_score"], reverse=True)
    return results


def mmr_rerank(
    results: list[dict[str, Any]],
    top_n: int,
    lambda_mmr: float = 0.7,
) -> list[dict[str, Any]]:
    """
    Maximal Marginal Relevance re-ranking for diversity.

    At each step, select the candidate that maximises:
        lambda_mmr * relevance_score - (1 - lambda_mmr) * max_sim_to_selected

    where max_sim_to_selected is the highest cosine similarity between the
    candidate and any already-selected memory.

    ``lambda_mmr=1.0`` is pure relevance (no diversity); ``0.0`` is pure
    diversity. The plan spec uses 0.7 (relevance-weighted).

    Requires each result dict to contain:
    - ``relevance_score`` (computed by rank_results)
    - ``embedding`` (list[float] | None) — skipped if absent
    """
    if not results:
        return []

    candidates = [r for r in results if r.get("embedding") is not None]
    no_embed = [r for r in results if r.get("embedding") is None]

    if not candidates:
        return results[:top_n]

    selected: list[dict[str, Any]] = []
    selected_embeddings: list[list[float]] = []

    while len(selected) < top_n and candidates:
        best_score = float("-inf")
        best_idx = 0

        for i, candidate in enumerate(candidates):
            relevance = candidate["relevance_score"]
            emb = candidate["embedding"]

            if selected_embeddings:
                max_sim = max(
                    _cosine_similarity(emb, s_emb) for s_emb in selected_embeddings
                )
            else:
                max_sim = 0.0

            mmr_score = lambda_mmr * relevance - (1 - lambda_mmr) * max_sim

            if mmr_score > best_score:
                best_score = mmr_score
                best_idx = i

        chosen = candidates.pop(best_idx)
        selected.append(chosen)
        selected_embeddings.append(chosen["embedding"])

    # Append any results that lacked embeddings at the end (shouldn't happen normally)
    remaining_slots = top_n - len(selected)
    if remaining_slots > 0:
        selected.extend(no_embed[:remaining_slots])

    return selected


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two equal-length vectors."""
    if len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)
