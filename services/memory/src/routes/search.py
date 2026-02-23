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
from ..services.ranking import mmr_rerank, rank_results
from ..services.serialization import normalize_metadata
from ..services.storage import vector_search

logger = logging.getLogger(__name__)

router = APIRouter()

# Number of candidates to retrieve before MMR re-ranking
_MMR_CANDIDATE_POOL = 20
# MMR lambda: 0.7 = relevance-weighted (per roadmap spec)
_MMR_LAMBDA = 0.7


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

    # Step 1: Retrieve a larger candidate pool with embeddings for MMR
    raw_results = await vector_search(
        embedding=embedding,
        limit=_MMR_CANDIDATE_POOL,
        content_types=req.content_types,
        min_similarity=0.3,
        include_embeddings=True,
    )

    # Step 2: Score by combined relevance (cosine + importance + temporal + access)
    ranked = rank_results(raw_results)

    # Step 3: MMR re-rank for diversity — removes near-duplicate memories
    # Estimate how many results will fit in the token budget (rough upper bound)
    diverse = mmr_rerank(ranked, top_n=_MMR_CANDIDATE_POOL, lambda_mmr=_MMR_LAMBDA)

    # Step 4: Pack into token budget
    assembled = assemble_context(diverse, max_tokens=req.max_tokens)

    return ContextResponse(
        context=assembled["context"],
        memory_count=assembled["memory_count"],
        total_tokens_estimate=assembled["total_tokens_estimate"],
    )
