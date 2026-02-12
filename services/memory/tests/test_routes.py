"""Route tests — basic request validation only (no DB/model dependency)."""
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
