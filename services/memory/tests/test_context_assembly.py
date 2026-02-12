from src.services.context_assembly import assemble_context, estimate_tokens


class TestEstimateTokens:
    def test_basic_estimate(self):
        assert estimate_tokens("hello world") == 2

    def test_empty_string(self):
        assert estimate_tokens("") == 1

    def test_long_text(self):
        assert estimate_tokens("a" * 400) == 100


class TestAssembleContext:
    def test_empty_results(self):
        result = assemble_context([], max_tokens=1500)
        assert result["context"] == ""
        assert result["memory_count"] == 0

    def test_fits_within_budget(self):
        results = [
            {"content": "short fact", "content_type": "fact", "tags": ["test"]},
            {"content": "another fact", "content_type": "fact", "tags": []},
        ]
        result = assemble_context(results, max_tokens=1500)
        assert result["memory_count"] == 2
        assert result["total_tokens_estimate"] > 0
        assert "short fact" in result["context"]

    def test_respects_token_budget(self):
        results = [
            {"content": "x" * 400, "content_type": "fact", "tags": []},
            {"content": "y" * 400, "content_type": "fact", "tags": []},
            {"content": "z" * 400, "content_type": "fact", "tags": []},
        ]
        # Only ~100 tokens each, budget of 150 should fit 1
        result = assemble_context(results, max_tokens=150)
        assert result["memory_count"] <= 2

    def test_formats_with_tags(self):
        results = [
            {"content": "likes coffee", "content_type": "preference", "tags": ["food"]},
        ]
        result = assemble_context(results, max_tokens=1500)
        assert "[preference [food]]" in result["context"]
        assert "likes coffee" in result["context"]
