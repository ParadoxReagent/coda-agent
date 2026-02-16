from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator


class IngestRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=10000)
    content_type: str = Field(..., pattern=r"^(conversation|fact|preference|event|note|summary)$")
    tags: list[str] = Field(default_factory=list, max_length=20)
    importance: float = Field(default=0.5, ge=0.0, le=1.0)
    source_type: str = Field(default="manual", max_length=50)
    source_id: str | None = Field(default=None, max_length=255)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("tags", mode="before")
    @classmethod
    def validate_tags(cls, v: list[str]) -> list[str]:
        return [t.strip()[:50] for t in v if t.strip()]


class BatchIngestRequest(BaseModel):
    memories: list[IngestRequest] = Field(..., min_length=1, max_length=50)


class IngestResponse(BaseModel):
    id: str
    content_hash: str
    message: str = "Memory saved"


class BatchIngestResponse(BaseModel):
    results: list[IngestResponse]
    count: int


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=1000)
    content_types: list[str] | None = None
    tags: list[str] | None = None
    limit: int = Field(default=10, ge=1, le=50)
    min_similarity: float = Field(default=0.3, ge=0.0, le=1.0)
    include_archived: bool = False


class MemoryResult(BaseModel):
    id: str
    content: str
    content_type: str
    tags: list[str]
    importance: float
    relevance_score: float
    created_at: datetime
    source_type: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SearchResponse(BaseModel):
    results: list[MemoryResult]
    count: int
    query: str


class ContextRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=1000)
    max_tokens: int = Field(default=1500, ge=100, le=4000)
    content_types: list[str] | None = None


class ContextResponse(BaseModel):
    context: str
    memory_count: int
    total_tokens_estimate: int


class MemoryListRequest(BaseModel):
    content_type: str | None = None
    tag: str | None = None
    limit: int = Field(default=20, ge=1, le=100)
    offset: int = Field(default=0, ge=0)
    include_archived: bool = False


class MemoryDetail(BaseModel):
    id: str
    content: str
    content_type: str
    tags: list[str]
    importance: float
    source_type: str | None
    source_id: str | None
    metadata: dict[str, Any]
    content_hash: str | None
    access_count: int
    accessed_at: datetime | None
    is_archived: bool
    created_at: datetime
    updated_at: datetime


class HealthResponse(BaseModel):
    status: str = "ok"
    model_loaded: bool = False
    database_connected: bool = False
