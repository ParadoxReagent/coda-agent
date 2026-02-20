-- Migration 0004: Add HNSW index on solution_patterns.embedding for fast cosine similarity search
-- Requires pgvector extension (already enabled in migration 0002)

CREATE INDEX IF NOT EXISTS solution_patterns_embedding_idx
ON solution_patterns USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
