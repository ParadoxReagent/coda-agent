"""Route tests — basic request validation only (no DB/model dependency)."""
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

# Patch heavy dependencies before importing the app
with patch("src.services.embedding.load_model"), \
     patch("src.db.init_pool", new_callable=AsyncMock), \
     patch("src.db.close_pool", new_callable=AsyncMock):
    from src.main import app

client = TestClient(app)


class TestHealthEndpoint:
    @patch("src.routes.health.check_connection", new_callable=AsyncMock, return_value=False)
    @patch("src.routes.health.get_model", side_effect=RuntimeError("not loaded"))
    def test_health_returns_degraded_when_not_ready(self, mock_model, mock_db):
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "degraded"


class TestIngestValidation:
    @patch("src.routes.ingest.generate_embedding", return_value=[0.1] * 384)
    @patch("src.routes.ingest.insert_memory", new_callable=AsyncMock, return_value={"id": "abc", "content_hash": "def"})
    def test_ingest_valid_request(self, mock_insert, mock_embed):
        resp = client.post("/ingest", json={
            "content": "test memory",
            "content_type": "fact",
        })
        assert resp.status_code == 200
        assert resp.json()["id"] == "abc"

    def test_ingest_missing_content(self):
        resp = client.post("/ingest", json={
            "content_type": "fact",
        })
        assert resp.status_code == 422

    def test_ingest_invalid_content_type(self):
        resp = client.post("/ingest", json={
            "content": "test",
            "content_type": "invalid",
        })
        assert resp.status_code == 422


class TestSearchValidation:
    def test_search_missing_query(self):
        resp = client.post("/search", json={})
        assert resp.status_code == 422


class TestMetadataNormalization:
    @staticmethod
    def _memory_row(metadata):
        now = datetime.now(timezone.utc)
        return {
            "id": "c6a65e7a-33e8-48c1-b5e8-e9e06f876983",
            "content": "Stored memory",
            "content_type": "fact",
            "tags": ["test"],
            "importance": 0.7,
            "source_type": "manual",
            "source_id": None,
            "metadata": metadata,
            "content_hash": "abc123",
            "access_count": 0,
            "accessed_at": None,
            "is_archived": False,
            "created_at": now,
            "updated_at": now,
        }

    @patch("src.routes.manage.list_memories", new_callable=AsyncMock)
    def test_list_memories_tolerates_non_mapping_metadata(self, mock_list):
        mock_list.return_value = [self._memory_row("legacy-string-value")]
        resp = client.get("/memories")
        assert resp.status_code == 200
        assert resp.json()["results"][0]["metadata"] == {}

    @patch("src.routes.manage.get_memory_by_id", new_callable=AsyncMock)
    def test_get_memory_parses_json_object_metadata_string(self, mock_get):
        mock_get.return_value = self._memory_row('{"source":"import","version":1}')
        resp = client.get("/memories/c6a65e7a-33e8-48c1-b5e8-e9e06f876983")
        assert resp.status_code == 200
        assert resp.json()["metadata"] == {"source": "import", "version": 1}

    @patch("src.routes.search.rank_results")
    @patch("src.routes.search.vector_search", new_callable=AsyncMock, return_value=[])
    @patch("src.routes.search.generate_embedding", return_value=[0.1] * 384)
    def test_search_tolerates_array_metadata(self, _mock_embed, _mock_search, mock_rank):
        now = datetime.now(timezone.utc)
        mock_rank.return_value = [
            {
                "id": "d6289782-074a-4220-93ea-4c5fcf853421",
                "content": "Result",
                "content_type": "fact",
                "tags": [],
                "importance": 0.5,
                "relevance_score": 0.9,
                "created_at": now,
                "source_type": "manual",
                "metadata": ["bad", "shape"],
            }
        ]

        resp = client.post("/search", json={"query": "test"})
        assert resp.status_code == 200
        assert resp.json()["results"][0]["metadata"] == {}
