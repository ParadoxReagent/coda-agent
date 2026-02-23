import math
import pytest
from datetime import datetime, timezone, timedelta

from src.services.ranking import (
    temporal_decay,
    access_bonus,
    combined_relevance,
    rank_results,
    mmr_rerank,
)


class TestTemporalDecay:
    def test_recent_memory_high_score(self):
        now = datetime.now(timezone.utc)
        score = temporal_decay(now)
        assert score > 0.99

    def test_30_day_half_life(self):
        """30 days old should score approximately 0.5."""
        thirty_days_ago = datetime.now(timezone.utc) - timedelta(days=30)
        score = temporal_decay(thirty_days_ago)
        assert pytest.approx(score, abs=0.01) == 0.5

    def test_old_memory_decays(self):
        old = datetime.now(timezone.utc) - timedelta(days=100)
        score = temporal_decay(old)
        assert score < 0.6

    def test_very_old_memory(self):
        old = datetime.now(timezone.utc) - timedelta(days=365)
        score = temporal_decay(old)
        assert score < 0.3

    def test_monotonically_decreasing(self):
        now = datetime.now(timezone.utc)
        scores = [temporal_decay(now - timedelta(days=d)) for d in [0, 10, 30, 60, 120]]
        assert all(scores[i] > scores[i + 1] for i in range(len(scores) - 1))


class TestAccessBonus:
    def test_zero_access(self):
        assert access_bonus(0) == 0.0

    def test_capped_at_0_1(self):
        assert access_bonus(100) == 0.1

    def test_moderate_access(self):
        assert access_bonus(5) == pytest.approx(0.05)


class TestCombinedRelevance:
    def test_high_similarity_high_score(self):
        score = combined_relevance(
            cosine_similarity=0.95,
            importance=0.8,
            created_at=datetime.now(timezone.utc),
            access_count=5,
        )
        assert score > 0.7

    def test_low_similarity_low_score(self):
        score = combined_relevance(
            cosine_similarity=0.2,
            importance=0.3,
            created_at=datetime.now(timezone.utc) - timedelta(days=100),
            access_count=0,
        )
        assert score < 0.3

    def test_score_clamped(self):
        score = combined_relevance(
            cosine_similarity=1.0,
            importance=1.0,
            created_at=datetime.now(timezone.utc),
            access_count=100,
        )
        assert score <= 1.0


class TestRankResults:
    def test_sorts_by_relevance(self):
        now = datetime.now(timezone.utc)
        results = [
            {"cosine_similarity": 0.5, "importance": 0.3, "created_at": now, "access_count": 0},
            {"cosine_similarity": 0.9, "importance": 0.8, "created_at": now, "access_count": 5},
        ]
        ranked = rank_results(results)
        assert ranked[0]["relevance_score"] > ranked[1]["relevance_score"]


def _make_embedding(value: float, dim: int = 4) -> list[float]:
    """Create a unit-ish embedding pointing in a specific direction."""
    base = [value] + [0.0] * (dim - 1)
    mag = math.sqrt(sum(x * x for x in base))
    return [x / mag for x in base]


def _make_result(
    relevance: float,
    embedding: list[float] | None,
    content: str = "test",
) -> dict:
    return {
        "relevance_score": relevance,
        "embedding": embedding,
        "content": content,
        "created_at": datetime.now(timezone.utc),
        "importance": 0.5,
        "cosine_similarity": relevance,
        "access_count": 0,
    }


class TestMmrRerank:
    def test_empty_input_returns_empty(self):
        assert mmr_rerank([], top_n=5) == []

    def test_returns_top_n(self):
        results = [
            _make_result(0.9, _make_embedding(1.0)),
            _make_result(0.8, _make_embedding(0.9)),
            _make_result(0.7, _make_embedding(0.8)),
            _make_result(0.6, _make_embedding(0.7)),
        ]
        selected = mmr_rerank(results, top_n=2)
        assert len(selected) == 2

    def test_selects_diverse_results(self):
        """With lambda=0, pure diversity: should avoid selecting near-identical embeddings."""
        # Two nearly identical embeddings (should only pick one)
        dup_emb = [1.0, 0.0, 0.0, 0.0]
        # One very different embedding
        diff_emb = [0.0, 1.0, 0.0, 0.0]

        results = [
            _make_result(0.9, dup_emb, "dup-a"),
            _make_result(0.85, dup_emb, "dup-b"),  # nearly same direction
            _make_result(0.7, diff_emb, "diverse"),
        ]
        # With lambda=0 (pure diversity), after picking dup-a, diverse should beat dup-b
        selected = mmr_rerank(results, top_n=2, lambda_mmr=0.0)
        contents = [r["content"] for r in selected]
        assert "dup-a" in contents
        assert "diverse" in contents

    def test_no_embeddings_falls_back_to_top_n(self):
        """If no results have embeddings, return first top_n results unchanged."""
        results = [
            _make_result(0.9, None, "a"),
            _make_result(0.8, None, "b"),
            _make_result(0.7, None, "c"),
        ]
        selected = mmr_rerank(results, top_n=2)
        assert len(selected) == 2

    def test_lambda_1_is_pure_relevance(self):
        """With lambda=1, MMR degenerates to sorting by relevance."""
        emb_a = [1.0, 0.0, 0.0]
        emb_b = [0.0, 1.0, 0.0]
        results = [
            _make_result(0.6, emb_a, "low-relevance"),
            _make_result(0.9, emb_b, "high-relevance"),
        ]
        selected = mmr_rerank(results, top_n=1, lambda_mmr=1.0)
        assert selected[0]["content"] == "high-relevance"
