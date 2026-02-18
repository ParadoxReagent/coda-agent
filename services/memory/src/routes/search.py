import logging

from fastapi import APIRouter

from ..models import (
    ContextRequest,
    ContextResponse,
    MemoryResult,
    SearchRequest,
    SearchResponse,
)
from ..services.context_assembly import assemble_context
from ..services.embedding import generate_embedding
from ..services.ranking import rank_results
from ..services.serialization import normalize_metadata
from ..services.storage import vector_search

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/search", response_model=SearchResponse)
async def search(req: SearchRequest) -> SearchResponse:
    embedding = generate_embedding(req.query)
    raw_results = await vector_search(
        embedding=embedding,
        limit=req.limit,
        content_types=req.content_types,
        tags=req.tags,
        min_similarity=req.min_similarity,
        include_archived=req.include_archived,
    )

    ranked = rank_results(raw_results)

    results = [
        MemoryResult(
            id=str(r["id"]),
            content=r["content"],
            content_type=r["content_type"],
            tags=r.get("tags", []),
            importance=float(r.get("importance", 0.5)),
            relevance_score=r["relevance_score"],
            created_at=r["created_at"],
            source_type=r.get("source_type"),
            metadata=normalize_metadata(r.get("metadata")),
        )
        for r in ranked
    ]

    return SearchResponse(results=results, count=len(results), query=req.query)


@router.post("/context", response_model=ContextResponse)
async def context(req: ContextRequest) -> ContextResponse:
    embedding = generate_embedding(req.query)
    raw_results = await vector_search(
        embedding=embedding,
        limit=20,
        content_types=req.content_types,
        min_similarity=0.3,
    )

    ranked = rank_results(raw_results)
    assembled = assemble_context(ranked, max_tokens=req.max_tokens)

    return ContextResponse(
        context=assembled["context"],
        memory_count=assembled["memory_count"],
        total_tokens_estimate=assembled["total_tokens_estimate"],
    )
