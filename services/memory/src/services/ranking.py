import math
from datetime import datetime, timezone
from typing import Any


def temporal_decay(created_at: datetime) -> float:
    """Score decays slowly over time: 1 / (1 + age_days * 0.01)."""
    now = datetime.now(timezone.utc)
    age_days = (now - created_at).total_seconds() / 86400
    return 1.0 / (1.0 + age_days * 0.01)


def access_bonus(access_count: int) -> float:
    """Small bonus for frequently accessed memories."""
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
    + 0.10 * temporal_decay
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
