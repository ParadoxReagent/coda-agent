import logging

from fastapi import APIRouter, HTTPException

from ..models import MemoryDetail
from ..services.serialization import normalize_metadata
from ..services.storage import get_memory_by_id, list_memories, soft_delete_memory

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/memories")
async def list_memories_endpoint(
    content_type: str | None = None,
    tag: str | None = None,
    limit: int = 20,
    offset: int = 0,
    include_archived: bool = False,
) -> dict:
    rows = await list_memories(
        content_type=content_type,
        tag=tag,
        limit=min(limit, 100),
        offset=offset,
        include_archived=include_archived,
    )

    results = [
        MemoryDetail(
            id=str(r["id"]),
            content=r["content"],
            content_type=r["content_type"],
            tags=r.get("tags", []),
            importance=float(r.get("importance", 0.5)),
            source_type=r.get("source_type"),
            source_id=r.get("source_id"),
            metadata=normalize_metadata(r.get("metadata")),
            content_hash=r.get("content_hash"),
            access_count=int(r.get("access_count", 0)),
            accessed_at=r.get("accessed_at"),
            is_archived=bool(r.get("is_archived", False)),
            created_at=r["created_at"],
            updated_at=r["updated_at"],
        )
        for r in rows
    ]

    return {"results": results, "count": len(results)}


@router.get("/memories/{memory_id}", response_model=MemoryDetail)
async def get_memory(memory_id: str) -> MemoryDetail:
    row = await get_memory_by_id(memory_id)
    if not row:
        raise HTTPException(status_code=404, detail="Memory not found")

    return MemoryDetail(
        id=str(row["id"]),
        content=row["content"],
        content_type=row["content_type"],
        tags=row.get("tags", []),
        importance=float(row.get("importance", 0.5)),
        source_type=row.get("source_type"),
        source_id=row.get("source_id"),
        metadata=normalize_metadata(row.get("metadata")),
        content_hash=row.get("content_hash"),
        access_count=int(row.get("access_count", 0)),
        accessed_at=row.get("accessed_at"),
        is_archived=bool(row.get("is_archived", False)),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


@router.delete("/memories/{memory_id}")
async def delete_memory(memory_id: str) -> dict:
    deleted = await soft_delete_memory(memory_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Memory not found or already archived")
    logger.info("Memory soft-deleted: %s", memory_id)
    return {"success": True, "message": f"Memory {memory_id} archived"}
