import logging

from fastapi import APIRouter

from ..models import (
    BatchIngestRequest,
    BatchIngestResponse,
    IngestRequest,
    IngestResponse,
)
from ..services.embedding import generate_embedding, generate_embeddings_batch
from ..services.storage import insert_memory

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/ingest", response_model=IngestResponse)
async def ingest(req: IngestRequest) -> IngestResponse:
    embedding = generate_embedding(req.content)
    result = await insert_memory(
        content=req.content,
        content_type=req.content_type,
        embedding=embedding,
        importance=req.importance,
        tags=req.tags,
        source_type=req.source_type,
        source_id=req.source_id,
        metadata=req.metadata,
    )
    logger.info("Memory ingested: %s (type=%s)", result["id"], req.content_type)
    return IngestResponse(
        id=result["id"],
        content_hash=result["content_hash"],
    )


@router.post("/ingest/batch", response_model=BatchIngestResponse)
async def ingest_batch(req: BatchIngestRequest) -> BatchIngestResponse:
    texts = [m.content for m in req.memories]
    embeddings = generate_embeddings_batch(texts)

    results: list[IngestResponse] = []
    for mem, emb in zip(req.memories, embeddings):
        result = await insert_memory(
            content=mem.content,
            content_type=mem.content_type,
            embedding=emb,
            importance=mem.importance,
            tags=mem.tags,
            source_type=mem.source_type,
            source_id=mem.source_id,
            metadata=mem.metadata,
        )
        results.append(IngestResponse(
            id=result["id"],
            content_hash=result["content_hash"],
        ))

    logger.info("Batch ingested %d memories", len(results))
    return BatchIngestResponse(results=results, count=len(results))
