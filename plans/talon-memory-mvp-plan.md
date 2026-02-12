# coda Memory System MVP - Technical Plan

**Version:** 1.1  
**Date:** 2026-02-08  
**Target Completion:** 2 weeks  
**Implementation:** Python (Memory Services) + TypeScript (Main Project Integration)

---

## Executive Summary

The coda Memory System provides semantic memory capabilities through two Python microservices (ingestion and retrieval) that integrate with your TypeScript coda-agent architecture via REST APIs and Redis pub/sub. This keeps the ML-heavy embedding work in Python while maintaining clean service boundaries.

**Core Capabilities:**
- Semantic storage and retrieval of conversational memories
- Vector similarity search with temporal relevance
- Token-aware context assembly for LLM prompts
- Event-driven ingestion from Redis
- Multi-user data isolation

**Security:** See separate `coda-memory-security-concerns.md` for comprehensive security guidance.

---

## Architecture Overview

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                  TypeScript coda Project                    │
│  ┌──────────────┐                     ┌──────────────┐      │
│  │ coda-agent   │────────REST────────▶│ Memory Skill │      │
│  │  (main app)  │                     │  (TS client) │      │
│  └──────┬───────┘                     └──────┬───────┘      │
│         │                                     │              │
│         │ Publishes events                    │ HTTP calls   │
│         ▼                                     ▼              │
│  ┌─────────────────────────────────────────────────┐        │
│  │           Redis Pub/Sub Event Bus                │        │
│  └─────────────────┬───────────────────────────────┘        │
└────────────────────┼──────────────────────────────────────────┘
                     │
                     │ Subscribe to events
                     ▼
┌─────────────────────────────────────────────────────────────┐
│               Python Memory Services                         │
│  ┌──────────────────┐              ┌──────────────────┐     │
│  │    Ingestion     │              │    Retrieval     │     │
│  │    Service       │              │     Service      │     │
│  │  (FastAPI)       │              │   (FastAPI)      │     │
│  │                  │              │                  │     │
│  │ - Embedding gen  │              │ - Semantic search│     │
│  │ - Storage        │              │ - Context assembly│    │
│  │ - Event sub      │              │ - Ranking        │     │
│  └────────┬─────────┘              └────────┬─────────┘     │
│           │                                  │               │
│           └──────────────┬───────────────────┘               │
│                          ▼                                   │
│           ┌──────────────────────────┐                       │
│           │  PostgreSQL + pgvector   │                       │
│           │  - Memory storage        │                       │
│           │  - Vector search         │                       │
│           └──────────────────────────┘                       │
└─────────────────────────────────────────────────────────────┘
```

### Language Boundary

**Python Services Handle:**
- Embedding generation (sentence-transformers)
- Vector operations (numpy, pgvector)
- Semantic search and ranking
- Database access

**TypeScript Project Handles:**
- Main application logic
- User interactions
- Conversation management
- HTTP client calls to Python services

**Communication:**
- REST APIs (authenticated with API keys)
- Redis pub/sub (fire-and-forget events)
- No shared code or dependencies

---

## Database Schema

### Core Tables

**memories**
```sql
CREATE TABLE memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Content
    content TEXT NOT NULL,
    content_type VARCHAR(50) NOT NULL,  -- 'conversation', 'fact', 'preference', 'event'
    embedding vector(384),  -- sentence-transformers/all-MiniLM-L6-v2
    
    -- Isolation (CRITICAL for security)
    user_id VARCHAR(255) NOT NULL,
    context_id VARCHAR(255),  -- Optional: workspace/project isolation
    
    -- Metadata
    source_type VARCHAR(50) NOT NULL,
    source_id VARCHAR(255),
    importance FLOAT DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
    confidence FLOAT DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
    tags TEXT[],
    metadata JSONB DEFAULT '{}'::jsonb,
    
    -- Integrity
    content_hash VARCHAR(64),  -- SHA-256 for tamper detection
    
    -- Temporal
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    access_count INTEGER DEFAULT 0,
    
    -- Lifecycle
    is_archived BOOLEAN DEFAULT FALSE,
    archived_at TIMESTAMP WITH TIME ZONE,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP WITH TIME ZONE,
    
    -- Full-text search
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

-- Critical indexes
CREATE INDEX idx_memories_embedding ON memories USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX idx_memories_user_id ON memories (user_id, created_at DESC);
CREATE INDEX idx_memories_user_context ON memories (user_id, context_id);
CREATE INDEX idx_memories_active ON memories (created_at DESC) WHERE NOT is_archived AND NOT is_deleted;

-- Row-level security for multi-user isolation
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON memories
    USING (user_id = current_setting('app.current_user_id', true)::text);
```

**memory_audit_log** (see security document for full schema)
```sql
CREATE TABLE memory_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    user_id VARCHAR(255) NOT NULL,
    action VARCHAR(100) NOT NULL,
    resource_id VARCHAR(255),
    ip_address INET,
    result VARCHAR(50),
    details JSONB
);
```

**user_quotas**
```sql
CREATE TABLE user_quotas (
    user_id VARCHAR(255) PRIMARY KEY,
    max_memories INT DEFAULT 50000,
    max_daily_ingestions INT DEFAULT 1000,
    current_memory_count INT DEFAULT 0,
    today_ingestion_count INT DEFAULT 0,
    quota_reset_at TIMESTAMP DEFAULT NOW()
);
```

---

## Python Services

### 1. Memory Ingestion Service

**Technology:**
- FastAPI (async REST API)
- asyncpg (PostgreSQL)
- sentence-transformers (embeddings)
- Redis client (pub/sub)

**API Endpoints:**
```
POST /ingest
  - Accepts: content, content_type, source_type, user_id, tags, metadata
  - Returns: memory_id, status
  - Auth: X-API-Key header

GET /memory/{id}
  - Returns: Full memory record
  - Auth: X-API-Key header

GET /health
  - Returns: Service status, model info
```

**Core Workflow:**
1. Receive memory via API or Redis event
2. Validate and sanitize input (see security doc)
3. Extract tags, calculate importance
4. Generate 384-dim embedding (all-MiniLM-L6-v2)
5. Calculate content hash for integrity
6. Store in PostgreSQL with metadata
7. Log to audit table

**Event Subscription:**
- Subscribe to Redis channel: `memory.ingest`
- Process events asynchronously
- No blocking of main app

### 2. Memory Retrieval Service

**Technology:**
- FastAPI (async REST API)
- asyncpg (vector search)
- Same embedding model for queries

**API Endpoints:**
```
POST /search
  - Accepts: query, top_k, filters (content_types, tags, min_importance)
  - Returns: ranked results with relevance scores
  - Auth: X-API-Key header

POST /context
  - Accepts: query, max_tokens, top_k
  - Returns: assembled context string, token count
  - Auth: X-API-Key header

GET /health
  - Returns: Service status
```

**Semantic Search Algorithm:**
```
1. Encode query to embedding vector
2. pgvector similarity search:
   - Use cosine distance (<=> operator)
   - Apply filters (user_id, content_type, tags)
   - Enforce user isolation
3. Calculate combined relevance score:
   - 60% semantic similarity (cosine)
   - 30% importance weight
   - 10% temporal decay (1 / (1 + age_days * decay_factor))
4. Return top K results sorted by relevance
```

**Context Assembly:**
```
1. Retrieve top_k candidates
2. Iterate in relevance order:
   - Estimate tokens (~length/4)
   - Add if within budget
   - Stop when budget exceeded
3. Format as delimited text
4. Return context + metadata
```

---

## TypeScript Integration

### Memory Skill Implementation

**File:** `src/skills/memory-skill.ts`

**Purpose:**
- HTTP client wrapper for Python services
- Pre-conversation context retrieval
- Integrate memory into LLM prompts

**Key Methods:**
```typescript
class MemorySkill {
  // Retrieve context for query
  async getContext(query: string, maxTokens: number): Promise<string>
  
  // Direct search
  async search(query: string, filters?: SearchFilters): Promise<Memory[]>
  
  // Inject memories into conversation
  async enrichContext(userMessage: string, conversationHistory: string): Promise<string>
}
```

**Environment Variables:**
```bash
MEMORY_INGESTION_URL=http://memory-ingestion:8001
MEMORY_RETRIEVAL_URL=http://memory-retrieval:8002
MEMORY_API_KEY=<shared-secret>
```

**Usage Example:**
```typescript
// In conversation handler
const memorySkill = getSkill('memory');
const relevantContext = await memorySkill.getContext(userMessage, 2000);

// Inject into LLM prompt
const enrichedPrompt = `
${conversationHistory}

=== Relevant Context ===
${relevantContext}
========================

User: ${userMessage}
`;
```

### Event Publishing

**From TypeScript to Redis:**
```typescript
import { createClient } from 'redis';

const redis = createClient({ url: process.env.REDIS_URL });

async function publishMemoryEvent(message: string, userId: string) {
  await redis.publish('memory.ingest', JSON.stringify({
    event_type: 'conversation.message',
    content: message,
    user_id: userId,
    metadata: { source: 'discord', timestamp: new Date().toISOString() }
  }));
}
```

---

## Docker Deployment

### docker-compose.yml

```yaml
version: '3.8'

services:
  # PostgreSQL with pgvector
  postgres:
    image: ankane/pgvector:latest
    environment:
      POSTGRES_DB: coda
      POSTGRES_USER: coda
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
    ports:
      - "5432:5432"  # Internal only in production
    networks:
      - coda-network

  # Redis for event bus
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    networks:
      - coda-network

  # Python Memory Ingestion
  memory-ingestion:
    build: ./memory-services/ingestion
    environment:
      DB_HOST: postgres
      DB_PASSWORD: ${DB_PASSWORD}
      REDIS_URL: redis://redis:6379
      API_KEY: ${MEMORY_API_KEY}
    ports:
      - "8001:8001"
    depends_on:
      - postgres
      - redis
    networks:
      - coda-network

  # Python Memory Retrieval
  memory-retrieval:
    build: ./memory-services/retrieval
    environment:
      DB_HOST: postgres
      DB_PASSWORD: ${DB_PASSWORD}
      API_KEY: ${MEMORY_API_KEY}
    ports:
      - "8002:8002"
    depends_on:
      - postgres
    networks:
      - coda-network

networks:
  coda-network:
    driver: bridge

volumes:
  postgres_data:
```

### Dockerfile (Python Services)

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Download embedding model at build time
RUN python -c "from sentence_transformers import SentenceTransformer; \
    SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')"

# App code
COPY . .

EXPOSE 8001
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
```

---

## Implementation Plan

### Phase 1: Infrastructure (Days 1-2)

**Database Setup**
- [ ] Deploy PostgreSQL with pgvector extension
- [ ] Run schema migrations (memories, audit_log, user_quotas)
- [ ] Create indexes
- [ ] Enable row-level security policies
- [ ] Configure backups

**Redis Setup**
- [ ] Deploy Redis instance
- [ ] Configure persistence (optional)
- [ ] Test pub/sub channels

**Development Environment**
- [ ] Set up Docker Compose locally
- [ ] Create .env files (encrypted)
- [ ] Test database connectivity

### Phase 2: Python Services (Days 3-6)

**Ingestion Service**
- [ ] FastAPI skeleton
- [ ] Pydantic models (validation)
- [ ] Embedding service (sentence-transformers)
- [ ] Content extractors (tags, importance)
- [ ] PostgreSQL storage layer
- [ ] API endpoints (/ingest, /memory/{id}, /health)
- [ ] Redis event subscriber
- [ ] Unit tests

**Retrieval Service**
- [ ] FastAPI skeleton
- [ ] Vector search implementation
- [ ] Relevance ranking (semantic + temporal + importance)
- [ ] Context assembly (token-aware)
- [ ] API endpoints (/search, /context, /health)
- [ ] Unit tests

**Security Hardening**
- [ ] API key authentication
- [ ] Input validation & sanitization
- [ ] Rate limiting (slowapi)
- [ ] Audit logging
- [ ] See security document for checklist

### Phase 3: TypeScript Integration (Days 7-9)

**Memory Skill**
- [ ] HTTP client for Python services
- [ ] TypeScript interfaces matching Python models
- [ ] Context retrieval method
- [ ] Search method
- [ ] Error handling & retries
- [ ] Register with coda-agent skill system

**Event Publishing**
- [ ] Redis client in TypeScript
- [ ] Publish conversation events
- [ ] Event structure validation
- [ ] Integration tests

**End-to-End Testing**
- [ ] Conversation → Redis → Ingestion → Storage
- [ ] Query → Retrieval → Context → LLM
- [ ] User isolation verification
- [ ] Performance testing

### Phase 4: Deployment & Monitoring (Days 10-12)

**Production Deployment**
- [ ] Docker images built
- [ ] Environment variables configured (secrets manager)
- [ ] Deploy to production infrastructure
- [ ] Configure reverse proxy (TLS termination)
- [ ] Network security (firewall rules)

**Monitoring**
- [ ] Prometheus metrics
- [ ] Grafana dashboards (latency, throughput, errors)
- [ ] Log aggregation (structured JSON logs)
- [ ] Alerts (Slack integration for critical events)

**Documentation**
- [ ] API documentation (OpenAPI/Swagger)
- [ ] Deployment runbook
- [ ] Troubleshooting guide
- [ ] Security playbook

### Phase 5: Validation (Days 13-14)

**Functional Testing**
- [ ] All API endpoints working
- [ ] Semantic search returning relevant results
- [ ] Context assembly within token budgets
- [ ] Multi-user isolation verified

**Performance Testing**
- [ ] Load test ingestion (target: <500ms p95)
- [ ] Load test search (target: <200ms p95)
- [ ] Concurrent users (target: 50+)
- [ ] Database performance acceptable

**Security Audit**
- [ ] Run through security checklist
- [ ] Penetration testing (optional)
- [ ] Dependency vulnerability scan
- [ ] Review audit logs

**Go-Live Checklist**
- [ ] Backups configured and tested
- [ ] Monitoring and alerts active
- [ ] API keys rotated and secured
- [ ] Documentation complete
- [ ] Incident response plan ready

---

## Success Metrics

### MVP Completion Criteria

✅ **Functional**
- Store memories with embeddings
- Semantic search returns relevant results
- Context assembly respects token budgets
- Multi-user data isolation enforced
- Event-driven ingestion working
- TypeScript integration functional

✅ **Performance**
- Ingestion: <500ms p95 latency
- Search: <200ms p95 latency
- Support 10,000+ memories per user
- Handle 50+ concurrent requests

✅ **Security** (see security document for full checklist)
- API key authentication
- Input validation & sanitization
- Rate limiting
- Audit logging
- User data isolation
- No exposed database ports

---

## Post-MVP Roadmap (Future Versions)

### V1 Enhancements (Weeks 3-6)
- Memory consolidation (nightly deduplication)
- Graph relationships between memories
- Advanced relevance ranking (ML-based)
- Memory analytics dashboard
- Bulk operations (import/export)

### V2 Features (Months 2-3)
- Multi-modal memories (images, documents)
- Hierarchical memory organization
- Memory templates and schemas
- Collaborative memories (shared contexts)
- Advanced search (filters, facets, date ranges)

### V3 Advanced (Months 4+)
- Memory agent (proactive suggestions)
- Automatic memory extraction from conversations
- Memory summaries and digests
- Cross-user knowledge graph (privacy-preserving)
- Dedicated vector database (Qdrant) migration

---

## Troubleshooting Guide

### Common Issues

**Slow Embedding Generation**
- Symptom: Ingestion >2s
- Solution: Use GPU acceleration or batch requests
- Check: Model cached locally, not downloading each time

**Irrelevant Search Results**
- Symptom: Low relevance scores (<0.3)
- Solution: Adjust time decay factor, add filters
- Check: Embeddings generated correctly, vector index exists

**High Memory Usage**
- Symptom: Python service OOM
- Solution: Reduce connection pool size, implement pagination
- Check: No memory leaks in long-running processes

**Database Connection Errors**
- Symptom: "Too many connections"
- Solution: Review pool settings (max_size), check for leaks
- Check: Connections properly closed, no hanging transactions

### Debug Checklist

1. Check service health endpoints
2. Review recent audit logs
3. Verify API keys are valid
4. Check network connectivity
5. Review database indexes (EXPLAIN ANALYZE)
6. Monitor resource usage (CPU, memory, disk)
7. Check Redis connectivity
8. Review error logs (structured JSON)

---

## Appendices

### A. Environment Variables

```bash
# Database
DB_HOST=postgres
DB_PORT=5432
DB_NAME=coda
DB_USER=coda
DB_PASSWORD=<from-secrets-manager>

# Redis
REDIS_URL=redis://redis:6379

# Security
MEMORY_API_KEY=<from-secrets-manager>

# Services
MEMORY_INGESTION_URL=http://memory-ingestion:8001
MEMORY_RETRIEVAL_URL=http://memory-retrieval:8002

# Embedding
EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2
```

### B. API Quick Reference

**Ingestion**
```bash
curl -X POST http://localhost:8001/ingest \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Example memory",
    "content_type": "conversation",
    "source_type": "discord",
    "user_id": "user_123"
  }'
```

**Search**
```bash
curl -X POST http://localhost:8002/search \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "docker containers",
    "top_k": 5,
    "user_id": "user_123"
  }'
```

**Context**
```bash
curl -X POST http://localhost:8002/context \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "infrastructure automation",
    "max_tokens": 2000,
    "user_id": "user_123"
  }'
```

### C. Database Maintenance

```sql
-- Daily vacuum
VACUUM ANALYZE memories;

-- Rebuild vector index (monthly)
REINDEX INDEX idx_memories_embedding;

-- Archive old memories (automated job)
UPDATE memories
SET is_archived = true, archived_at = NOW()
WHERE created_at < NOW() - INTERVAL '1 year'
  AND access_count < 5
  AND NOT is_archived;

-- Check database size
SELECT
    pg_size_pretty(pg_total_relation_size('memories')) as table_size,
    count(*) as total_memories,
    count(*) FILTER (WHERE NOT is_archived) as active_memories
FROM memories;
```

---

## Next Steps

1. **Review this plan** - Confirm approach aligns with your needs
2. **Review security document** - Understand security requirements
3. **Set up development environment** - Docker Compose locally
4. **Begin Phase 1** - Database and Redis setup
5. **Implement Python services** - Ingestion first, then retrieval
6. **Integrate with TypeScript** - Memory skill implementation
7. **Test thoroughly** - Unit, integration, security, performance
8. **Deploy to production** - With monitoring and alerts
9. **Iterate** - Collect feedback, plan V1 enhancements

**Questions?** This plan provides a clear path forward while keeping Python and TypeScript cleanly separated. The security document covers all major concerns for implementation and future updates.
