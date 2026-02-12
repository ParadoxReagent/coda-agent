from datetime import datetime, timezone, timedelta

from src.services.ranking import (
    temporal_decay,
    access_bonus,
    combined_relevance,
    rank_results,
)


class TestTemporalDecay:
    def test_recent_memory_high_score(self):
        now = datetime.now(timezone.utc)
        score = temporal_decay(now)
        assert score > 0.99

    def test_old_memory_decays(self):
        old = datetime.now(timezone.utc) - timedelta(days=100)
        score = temporal_decay(old)
        assert score < 0.6

    def test_very_old_memory(self):
        old = datetime.now(timezone.utc) - timedelta(days=365)
        score = temporal_decay(old)
        assert score < 0.3


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


import pytest  # noqa: E402 — needed for approx
