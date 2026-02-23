import hashlib
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from ..db import get_pool

logger = logging.getLogger(__name__)


def content_hash(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


async def insert_memory(
    content: str,
    content_type: str,
    embedding: list[float],
    importance: float = 0.5,
    tags: list[str] | None = None,
    source_type: str = "manual",
    source_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    pool = await get_pool()
    memory_id = str(uuid.uuid4())
    c_hash = content_hash(content)
    now = datetime.now(timezone.utc)
    embedding_str = "[" + ",".join(str(v) for v in embedding) + "]"

    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO memories (
                id, content, content_type, embedding, source_type, source_id,
                importance, tags, metadata, content_hash, created_at, updated_at
            ) VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8, $9::jsonb, $10, $11, $11)
            """,
            uuid.UUID(memory_id),
            content,
            content_type,
            embedding_str,
            source_type,
            source_id,
            importance,
            tags or [],
            __import__("json").dumps(metadata or {}),
            c_hash,
            now,
        )

    return {"id": memory_id, "content_hash": c_hash}


async def vector_search(
    embedding: list[float],
    limit: int = 10,
    content_types: list[str] | None = None,
    tags: list[str] | None = None,
    min_similarity: float = 0.3,
    include_archived: bool = False,
    include_embeddings: bool = False,
) -> list[dict[str, Any]]:
    pool = await get_pool()
    embedding_str = "[" + ",".join(str(v) for v in embedding) + "]"

    conditions = ["1 - (embedding <=> $1::vector) >= $2"]
    params: list[Any] = [embedding_str, min_similarity]
    param_idx = 3

    if not include_archived:
        conditions.append("is_archived = false")

    if content_types:
        conditions.append(f"content_type = ANY(${param_idx})")
        params.append(content_types)
        param_idx += 1

    if tags:
        conditions.append(f"tags @> ${param_idx}")
        params.append(tags)
        param_idx += 1

    where_clause = " AND ".join(conditions)
    params.append(limit)

    # Only select the embedding column when needed (it's large — 384 floats)
    embedding_col = ", embedding::text AS embedding_text" if include_embeddings else ""

    query = f"""
        SELECT
            id, content, content_type, tags, importance, source_type,
            source_id, metadata, access_count, created_at, updated_at,
            1 - (embedding <=> $1::vector) AS cosine_similarity
            {embedding_col}
        FROM memories
        WHERE {where_clause}
        ORDER BY embedding <=> $1::vector ASC
        LIMIT ${param_idx}
    """

    async with pool.acquire() as conn:
        rows = await conn.fetch(query, *params)

    # Update access counts
    if rows:
        ids = [row["id"] for row in rows]
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE memories
                SET access_count = access_count + 1,
                    accessed_at = NOW()
                WHERE id = ANY($1)
                """,
                ids,
            )

    results = []
    for row in rows:
        r = dict(row)
        if include_embeddings and r.get("embedding_text"):
            # Parse the vector text representation "[f1,f2,...]" back to list[float]
            raw = r.pop("embedding_text")
            try:
                r["embedding"] = [float(v) for v in raw.strip("[]").split(",")]
            except (ValueError, AttributeError):
                r["embedding"] = None
        else:
            r.pop("embedding_text", None)
        results.append(r)

    return results


async def get_memory_by_id(memory_id: str) -> dict[str, Any] | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, content, content_type, tags, importance, source_type,
                   source_id, metadata, content_hash, access_count, accessed_at,
                   is_archived, archived_at, created_at, updated_at
            FROM memories WHERE id = $1
            """,
            uuid.UUID(memory_id),
        )
    return dict(row) if row else None


async def list_memories(
    content_type: str | None = None,
    tag: str | None = None,
    limit: int = 20,
    offset: int = 0,
    include_archived: bool = False,
) -> list[dict[str, Any]]:
    pool = await get_pool()
    conditions = []
    params: list[Any] = []
    param_idx = 1

    if not include_archived:
        conditions.append("is_archived = false")

    if content_type:
        conditions.append(f"content_type = ${param_idx}")
        params.append(content_type)
        param_idx += 1

    if tag:
        conditions.append(f"tags @> ARRAY[${param_idx}]::text[]")
        params.append(tag)
        param_idx += 1

    where_clause = " WHERE " + " AND ".join(conditions) if conditions else ""
    params.extend([limit, offset])

    query = f"""
        SELECT id, content, content_type, tags, importance, source_type,
               source_id, metadata, content_hash, access_count, accessed_at,
               is_archived, created_at, updated_at
        FROM memories{where_clause}
        ORDER BY created_at DESC
        LIMIT ${param_idx} OFFSET ${param_idx + 1}
    """

    async with pool.acquire() as conn:
        rows = await conn.fetch(query, *params)

    return [dict(row) for row in rows]


async def soft_delete_memory(memory_id: str) -> bool:
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE memories
            SET is_archived = true, archived_at = NOW()
            WHERE id = $1 AND is_archived = false
            """,
            uuid.UUID(memory_id),
        )
    return result == "UPDATE 1"


async def check_connection() -> bool:
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        return True
    except Exception:
        return False
