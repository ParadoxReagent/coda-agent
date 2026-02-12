# coda Memory System - Security Concerns & Mitigations

**Version:** 1.0  
**Date:** 2026-02-08  
**Classification:** Internal Security Reference  
**Purpose:** Comprehensive security guidance for memory system implementation and future updates

---

## Table of Contents

1. [Authentication & Authorization](#authentication--authorization)
2. [Data Isolation & Multi-Tenancy](#data-isolation--multi-tenancy)
3. [Input Validation & Injection Prevention](#input-validation--injection-prevention)
4. [Embedding Security & Poisoning Attacks](#embedding-security--poisoning-attacks)
5. [Rate Limiting & DoS Prevention](#rate-limiting--dos-prevention)
6. [Secrets Management](#secrets-management)
7. [Audit Logging & Monitoring](#audit-logging--monitoring)
8. [Data Privacy & Compliance](#data-privacy--compliance)
9. [Network Security](#network-security)
10. [Backup Security](#backup-security)
11. [Log Sanitization](#log-sanitization)
12. [Webhook Security](#webhook-security)
13. [Data Integrity](#data-integrity)
14. [Timing Attacks](#timing-attacks)
15. [Memory Lifecycle Security](#memory-lifecycle-security)
16. [API Security](#api-security)
17. [Database Security](#database-security)
18. [Container Security](#container-security)
19. [Incident Response](#incident-response)
20. [Security Testing](#security-testing)

---

## 1. Authentication & Authorization

### Concerns

**API Key Authentication**
- Risk: API keys stolen or leaked in logs/code
- Risk: Shared API keys across services make revocation difficult
- Risk: No granular permissions (all-or-nothing access)

**Session Management**
- Risk: Long-lived sessions vulnerable to hijacking
- Risk: No session invalidation on logout

### Mitigations

**API Key Best Practices**
```python
# Generate cryptographically secure keys
import secrets
api_key = secrets.token_urlsafe(32)  # 256-bit entropy

# Store hashed versions in database
import hashlib
key_hash = hashlib.sha256(api_key.encode()).hexdigest()

# Implement key rotation
class APIKeyManager:
    async def rotate_key(self, old_key: str) -> str:
        """Rotate API key with grace period"""
        new_key = secrets.token_urlsafe(32)
        # Store both keys temporarily for transition
        await store_key(new_key, expires=datetime.now() + timedelta(days=90))
        await mark_key_deprecated(old_key, grace_period_days=7)
        return new_key
```

**Key Scoping**
- Separate keys per service/environment
- Include service identifier in key structure
- Example: `coda_ingest_prod_<random>` vs `coda_retrieval_dev_<random>`

**Permission Levels (Future Enhancement)**
```python
# Implement role-based access control
API_KEY_PERMISSIONS = {
    "memory.ingest": ["write"],
    "memory.search": ["read"],
    "memory.admin": ["read", "write", "delete"]
}
```

**Key Storage**
- Never commit keys to git
- Use environment variables or secret manager
- Encrypt at rest in database
- Separate key storage from application database

---

## 2. Data Isolation & Multi-Tenancy

### Concerns

**Cross-User Data Leakage**
- Risk: User A sees User B's memories
- Risk: Queries accidentally return data from wrong user
- Risk: Bulk operations affect multiple users

**Context Bleeding**
- Risk: Shared embeddings leak semantic information
- Risk: Similar queries retrieving cross-user results

### Mitigations

**Database Schema Updates**
```sql
-- Add user_id to all memory tables
ALTER TABLE memories ADD COLUMN user_id VARCHAR(255) NOT NULL;
ALTER TABLE memories ADD COLUMN context_id VARCHAR(255);  -- Optional: project/workspace isolation

-- Enforce at database level
ALTER TABLE memories ADD CONSTRAINT check_user_id 
    CHECK (user_id IS NOT NULL AND user_id != '');

-- Create index for user filtering
CREATE INDEX idx_memories_user_id ON memories (user_id);
CREATE INDEX idx_memories_user_context ON memories (user_id, context_id);
```

**Row-Level Security (PostgreSQL)**
```sql
-- Enable RLS
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

-- Policy: Users only see their own data
CREATE POLICY user_isolation ON memories
    FOR ALL
    USING (user_id = current_setting('app.current_user_id', true)::text)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::text);

-- Set user context in application
-- Python:
await pool.query("SET app.current_user_id = $1", [authenticated_user_id])

-- TypeScript:
await pool.query("SET app.current_user_id = $1", [authenticatedUserId])
```

**Application-Level Enforcement**
```python
# ALWAYS filter by user_id in queries
async def search_memories(user_id: str, query_embedding: List[float]):
    results = await pool.fetch(
        """
        SELECT * FROM memories
        WHERE user_id = $1 
          AND NOT is_archived
        ORDER BY embedding <=> $2::vector
        LIMIT 10
        """,
        user_id,  # REQUIRED
        query_embedding
    )
    return results

# Validation decorator
def require_user_id(func):
    @wraps(func)
    async def wrapper(*args, user_id: str = None, **kwargs):
        if not user_id:
            raise SecurityError("user_id is required for all memory operations")
        return await func(*args, user_id=user_id, **kwargs)
    return wrapper
```

**Testing Isolation**
```python
# Integration test to verify no cross-user leakage
async def test_user_isolation():
    # Create memories for two users
    await create_memory(user_id="user_a", content="Secret A")
    await create_memory(user_id="user_b", content="Secret B")
    
    # Verify user_a cannot see user_b's data
    results_a = await search_memories(user_id="user_a", query="Secret")
    assert all(r['user_id'] == "user_a" for r in results_a)
    assert "Secret B" not in str(results_a)
```

---

## 3. Input Validation & Injection Prevention

### Concerns

**SQL Injection**
- Risk: User input in raw SQL queries
- Risk: Parameterized queries bypassed

**NoSQL Injection (JSONB fields)**
- Risk: Malicious JSON in metadata fields
- Risk: JSONB operators vulnerable to injection

**Command Injection**
- Risk: User input in system calls
- Risk: File path traversal

### Mitigations

**Input Validation Schema**
```python
from pydantic import BaseModel, Field, validator
import re

class MemoryInput(BaseModel):
    content: str = Field(..., min_length=1, max_length=10000)
    user_id: str = Field(..., regex=r'^[a-zA-Z0-9_-]{1,255}$')
    tags: List[str] = Field(default_factory=list, max_items=20)
    
    @validator('content')
    def sanitize_content(cls, v):
        # Remove control characters
        v = re.sub(r'[\x00-\x1F\x7F-\x9F]', '', v)
        
        # Check for SQL injection patterns (defense in depth)
        dangerous_patterns = [
            r";\s*DROP\s+TABLE",
            r";\s*DELETE\s+FROM",
            r";\s*UPDATE\s+.*\s+SET",
            r"--\s*$",
            r"/\*.*\*/"
        ]
        for pattern in dangerous_patterns:
            if re.search(pattern, v, re.IGNORECASE):
                raise ValueError("Content contains potentially dangerous patterns")
        
        return v.strip()
    
    @validator('tags', each_item=True)
    def validate_tag(cls, v):
        if len(v) > 50:
            raise ValueError("Tag too long")
        if not re.match(r'^[a-zA-Z0-9_-]+$', v):
            raise ValueError("Tags can only contain alphanumeric, dash, underscore")
        return v
```

**Always Use Parameterized Queries**
```python
# GOOD - Parameterized
await pool.execute(
    "INSERT INTO memories (content, user_id) VALUES ($1, $2)",
    content, user_id
)

# BAD - String concatenation (NEVER DO THIS)
query = f"INSERT INTO memories (content) VALUES ('{content}')"  # VULNERABLE
await pool.execute(query)
```

**JSONB Safety**
```python
# Validate metadata before storing
import json

def validate_metadata(metadata: dict) -> dict:
    """Ensure metadata is safe for JSONB storage"""
    
    # Limit depth to prevent deeply nested attacks
    def check_depth(obj, max_depth=5, current_depth=0):
        if current_depth > max_depth:
            raise ValueError("Metadata too deeply nested")
        if isinstance(obj, dict):
            for value in obj.values():
                check_depth(value, max_depth, current_depth + 1)
        elif isinstance(obj, list):
            for item in obj:
                check_depth(item, max_depth, current_depth + 1)
    
    check_depth(metadata)
    
    # Limit size
    metadata_str = json.dumps(metadata)
    if len(metadata_str) > 50000:  # 50KB limit
        raise ValueError("Metadata too large")
    
    return metadata
```

**File Path Sanitization**
```python
import os
from pathlib import Path

def safe_path(user_input: str, base_dir: str) -> Path:
    """Prevent path traversal attacks"""
    
    # Resolve to absolute path
    base = Path(base_dir).resolve()
    target = (base / user_input).resolve()
    
    # Ensure target is under base directory
    if not str(target).startswith(str(base)):
        raise SecurityError("Path traversal attempt detected")
    
    return target
```

---

## 4. Embedding Security & Poisoning Attacks

### Concerns

**Adversarial Input**
- Risk: Crafted inputs that produce unusual embeddings
- Risk: Inputs designed to match unrelated content
- Risk: Flooding system with similar embeddings

**Model Manipulation**
- Risk: Inputs that exploit model weaknesses
- Risk: Unicode/homoglyph attacks
- Risk: Excessive repetition causing embedding drift

### Mitigations

**Input Sanitization for Embeddings**
```python
def sanitize_for_embedding(text: str) -> str:
    """Prepare text for safe embedding generation"""
    
    # Remove control characters
    text = re.sub(r'[\x00-\x1F\x7F-\x9F]', '', text)
    
    # Normalize unicode
    import unicodedata
    text = unicodedata.normalize('NFKC', text)
    
    # Remove excessive repetition
    # "aaaaaaaaaaaaaaaa" -> "aaa"
    text = re.sub(r'(.)\1{20,}', r'\1\1\1', text)
    
    # Limit excessive whitespace
    text = re.sub(r'\s{10,}', ' ', text)
    
    # Truncate to reasonable length
    text = text[:5000]
    
    return text.strip()
```

**Embedding Anomaly Detection**
```python
import numpy as np

class EmbeddingValidator:
    """Detect anomalous embeddings"""
    
    def __init__(self):
        self.normal_magnitude_range = (0.5, 2.0)
        self.max_zero_count = 100  # Max zero values in embedding
    
    def validate(self, embedding: List[float]) -> bool:
        """Check if embedding looks normal"""
        
        # Calculate magnitude
        magnitude = np.linalg.norm(embedding)
        
        # Check magnitude bounds
        if not (self.normal_magnitude_range[0] <= magnitude <= self.normal_magnitude_range[1]):
            logger.warning(f"Anomalous embedding magnitude: {magnitude}")
            return False
        
        # Check for too many zeros
        zero_count = sum(1 for x in embedding if abs(x) < 1e-6)
        if zero_count > self.max_zero_count:
            logger.warning(f"Embedding has {zero_count} zeros")
            return False
        
        # Check for NaN or Inf
        if not all(np.isfinite(x) for x in embedding):
            logger.error("Embedding contains NaN or Inf")
            return False
        
        return True
```

**Rate Limiting Embedding Generation**
```python
# Prevent flooding with embedding requests
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)

@app.post("/ingest")
@limiter.limit("100/hour")  # Per IP
@limiter.limit("500/hour", key_func=lambda: get_user_id())  # Per user
async def ingest_memory(...):
    ...
```

**Embedding Diversity Checks**
```python
async def check_embedding_diversity(user_id: str, new_embedding: List[float]):
    """Prevent users from storing too many similar embeddings"""
    
    # Get recent embeddings for user
    recent = await pool.fetch(
        """
        SELECT embedding FROM memories
        WHERE user_id = $1
          AND created_at > NOW() - INTERVAL '1 hour'
        LIMIT 100
        """,
        user_id
    )
    
    # Check similarity to recent embeddings
    for row in recent:
        similarity = cosine_similarity(new_embedding, row['embedding'])
        if similarity > 0.98:  # Nearly identical
            raise ValueError("Too similar to recent memory - possible attack")
```

---

## 5. Rate Limiting & DoS Prevention

### Concerns

**Resource Exhaustion**
- Risk: Unlimited ingestion flooding database
- Risk: Expensive embedding generation for all requests
- Risk: Large result sets consuming memory

**Targeted Attacks**
- Risk: Automated bot traffic
- Risk: Credential stuffing attempts
- Risk: Scraping memory data

### Mitigations

**Multi-Level Rate Limiting**
```python
# Per-IP limits (FastAPI)
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)

# Per-endpoint limits
@app.post("/ingest")
@limiter.limit("100/hour")  # Aggressive for write operations
async def ingest_memory(...):
    ...

@app.post("/search")
@limiter.limit("1000/hour")  # More lenient for reads
async def search_memories(...):
    ...
```

**Per-User Quotas**
```python
# Database schema
CREATE TABLE user_quotas (
    user_id VARCHAR(255) PRIMARY KEY,
    max_memories INT DEFAULT 50000,
    max_daily_ingestions INT DEFAULT 1000,
    current_memory_count INT DEFAULT 0,
    today_ingestion_count INT DEFAULT 0,
    quota_reset_at TIMESTAMP DEFAULT NOW()
);

# Check before ingestion
async def check_user_quota(user_id: str) -> bool:
    """Verify user hasn't exceeded quotas"""
    
    quota = await pool.fetchrow(
        "SELECT * FROM user_quotas WHERE user_id = $1",
        user_id
    )
    
    if not quota:
        # Create default quota
        await create_default_quota(user_id)
        return True
    
    # Check daily ingestion limit
    if quota['today_ingestion_count'] >= quota['max_daily_ingestions']:
        raise QuotaExceededError("Daily ingestion limit reached")
    
    # Check total memory count
    if quota['current_memory_count'] >= quota['max_memories']:
        raise QuotaExceededError("Total memory storage limit reached")
    
    return True
```

**Request Size Limits**
```python
# Limit request body size
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

class RequestSizeLimiter(BaseHTTPMiddleware):
    def __init__(self, app, max_size: int = 1_000_000):  # 1MB default
        super().__init__(app)
        self.max_size = max_size
    
    async def dispatch(self, request: Request, call_next):
        if request.method in ["POST", "PUT", "PATCH"]:
            content_length = request.headers.get("content-length")
            if content_length and int(content_length) > self.max_size:
                return JSONResponse(
                    status_code=413,
                    content={"error": "Request too large"}
                )
        return await call_next(request)

app.add_middleware(RequestSizeLimiter, max_size=1_000_000)
```

**Connection Pool Limits**
```python
# Prevent connection exhaustion
db_pool = await asyncpg.create_pool(
    ...,
    min_size=5,
    max_size=20,  # Limit concurrent connections
    max_inactive_connection_lifetime=300,  # 5 minutes
    command_timeout=30  # 30 second query timeout
)
```

**Query Result Limits**
```python
# Always enforce maximum result sizes
MAX_SEARCH_RESULTS = 100

async def search_memories(query: str, limit: int = 10):
    # Enforce upper bound
    limit = min(limit, MAX_SEARCH_RESULTS)
    
    results = await pool.fetch(
        "SELECT * FROM memories WHERE ... LIMIT $1",
        limit
    )
    return results
```

---

## 6. Secrets Management

### Concerns

**Hardcoded Secrets**
- Risk: API keys in source code
- Risk: Database passwords in config files
- Risk: Secrets committed to git

**Environment Variable Leakage**
- Risk: .env files in production containers
- Risk: Secrets in error messages
- Risk: Secrets in logs

### Mitigations

**Secret Storage Options**

**Option 1: HashiCorp Vault**
```python
import hvac

class VaultSecretManager:
    def __init__(self, vault_url: str, token: str):
        self.client = hvac.Client(url=vault_url, token=token)
    
    async def get_secret(self, path: str) -> str:
        """Retrieve secret from Vault"""
        secret = self.client.secrets.kv.v2.read_secret_version(path=path)
        return secret['data']['data']['value']

# Usage
vault = VaultSecretManager(VAULT_URL, VAULT_TOKEN)
db_password = await vault.get_secret('coda/database/password')
```

**Option 2: AWS Secrets Manager**
```python
import boto3
import json

class AWSSecretManager:
    def __init__(self):
        self.client = boto3.client('secretsmanager')
    
    def get_secret(self, secret_name: str) -> dict:
        """Retrieve secret from AWS Secrets Manager"""
        response = self.client.get_secret_value(SecretId=secret_name)
        return json.loads(response['SecretString'])

# Usage
secrets = AWSSecretManager()
db_creds = secrets.get_secret('coda/prod/database')
```

**Option 3: Encrypted .env (SOPS)**
```bash
# Encrypt .env file with SOPS
sops --encrypt .env > .env.encrypted

# Decrypt at runtime
sops --decrypt .env.encrypted > .env

# In Python
import subprocess
subprocess.run(['sops', '--decrypt', '.env.encrypted'], check=True)
```

**Secret Rotation**
```python
class SecretRotator:
    """Automated secret rotation"""
    
    async def rotate_api_key(self):
        """Rotate API key with zero downtime"""
        
        # Generate new key
        new_key = secrets.token_urlsafe(32)
        
        # Store with transition period
        await self.store_key(new_key, status='pending', expires_in_days=90)
        
        # Mark old key as deprecated (7 day grace period)
        await self.deprecate_old_key(grace_period_days=7)
        
        # Notify services of new key
        await self.notify_services(new_key)
        
        logger.info("API key rotation initiated")
    
    async def rotate_database_password(self):
        """Rotate DB password without downtime"""
        
        # Create new user with new password
        new_user = f"coda_{secrets.token_hex(4)}"
        new_password = secrets.token_urlsafe(32)
        
        await self.create_db_user(new_user, new_password)
        
        # Grant same permissions as old user
        await self.clone_permissions(old_user='coda', new_user=new_user)
        
        # Update connection pool with new credentials
        await self.update_pool_credentials(new_user, new_password)
        
        # After grace period, remove old user
        await self.schedule_user_deletion(old_user='coda', delay_days=7)
```

**Never Log Secrets**
```python
import logging
import re

class SecretSanitizingFilter(logging.Filter):
    """Remove secrets from log messages"""
    
    PATTERNS = [
        (re.compile(r'api[_-]?key["\']?\s*[:=]\s*["\']?([a-zA-Z0-9_-]+)', re.I), 'api_key=***'),
        (re.compile(r'password["\']?\s*[:=]\s*["\']?([^\s"\']+)', re.I), 'password=***'),
        (re.compile(r'Bearer\s+([a-zA-Z0-9_-]+)', re.I), 'Bearer ***'),
    ]
    
    def filter(self, record):
        for pattern, replacement in self.PATTERNS:
            record.msg = pattern.sub(replacement, str(record.msg))
        return True

# Apply to all loggers
logging.getLogger().addFilter(SecretSanitizingFilter())
```

---

## 7. Audit Logging & Monitoring

### Concerns

**Insufficient Logging**
- Risk: Cannot trace security incidents
- Risk: No accountability for actions
- Risk: Missing suspicious activity patterns

**Log Tampering**
- Risk: Attackers deleting logs
- Risk: Logs modified to hide tracks

### Mitigations

**Comprehensive Audit Log**
```sql
-- Audit log table
CREATE TABLE memory_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Who
    user_id VARCHAR(255) NOT NULL,
    service_name VARCHAR(100),  -- Which service performed action
    
    -- What
    action VARCHAR(100) NOT NULL,  -- 'ingest', 'search', 'delete', 'update'
    resource_type VARCHAR(50),     -- 'memory', 'user_quota'
    resource_id VARCHAR(255),
    
    -- How
    ip_address INET,
    user_agent TEXT,
    api_key_id VARCHAR(255),  -- Which key was used (not the key itself)
    
    -- Details
    details JSONB,  -- Action-specific details
    result VARCHAR(50),  -- 'success', 'failure', 'partial'
    error_message TEXT,
    
    -- Performance
    duration_ms INT,
    
    -- Indexes
    INDEX idx_audit_timestamp (timestamp DESC),
    INDEX idx_audit_user (user_id, timestamp DESC),
    INDEX idx_audit_action (action, timestamp DESC)
);

-- Immutable (append-only)
ALTER TABLE memory_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY no_update_policy ON memory_audit_log FOR UPDATE USING (false);
CREATE POLICY no_delete_policy ON memory_audit_log FOR DELETE USING (false);
```

**Logging Implementation**
```python
async def log_audit_event(
    user_id: str,
    action: str,
    resource_type: str = None,
    resource_id: str = None,
    result: str = 'success',
    details: dict = None,
    ip_address: str = None,
    user_agent: str = None,
    duration_ms: int = None,
    error_message: str = None
):
    """Log audit event"""
    
    await pool.execute(
        """
        INSERT INTO memory_audit_log (
            user_id, action, resource_type, resource_id,
            result, details, ip_address, user_agent,
            duration_ms, error_message
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        """,
        user_id, action, resource_type, resource_id,
        result, details, ip_address, user_agent,
        duration_ms, error_message
    )

# Usage
await log_audit_event(
    user_id="user_123",
    action="memory.search",
    details={"query": "sensitive data", "results_count": 5},
    ip_address=request.client.host,
    duration_ms=45
)
```

**Suspicious Activity Detection**
```python
class AnomalyDetector:
    """Detect suspicious patterns in audit logs"""
    
    async def detect_bulk_access(self, user_id: str, window_minutes: int = 5):
        """Detect unusual bulk memory access"""
        
        result = await pool.fetchrow(
            """
            SELECT COUNT(*) as access_count
            FROM memory_audit_log
            WHERE user_id = $1
              AND action = 'memory.search'
              AND timestamp > NOW() - INTERVAL '1 minute' * $2
            """,
            user_id, window_minutes
        )
        
        if result['access_count'] > 100:  # 100+ searches in 5 min
            await self.alert_security_team(
                f"Bulk access detected: {user_id} made {result['access_count']} searches"
            )
            return True
        
        return False
    
    async def detect_failed_auth_attempts(self, ip_address: str):
        """Detect brute force attempts"""
        
        result = await pool.fetchrow(
            """
            SELECT COUNT(*) as failure_count
            FROM memory_audit_log
            WHERE ip_address = $1
              AND result = 'failure'
              AND timestamp > NOW() - INTERVAL '10 minutes'
            """,
            ip_address
        )
        
        if result['failure_count'] > 10:
            # Block IP temporarily
            await self.add_to_blocklist(ip_address, duration_minutes=60)
            return True
        
        return False
```

**Tamper-Proof Logs (Write to external system)**
```python
import logging
from pythonjsonlogger import jsonlogger

# Send to external log aggregation (Datadog, Splunk, etc.)
class ExternalLogHandler(logging.Handler):
    """Forward logs to external system"""
    
    def emit(self, record):
        log_entry = self.format(record)
        # Send to external service
        try:
            requests.post(
                EXTERNAL_LOG_ENDPOINT,
                json=json.loads(log_entry),
                headers={'Authorization': f'Bearer {LOG_API_KEY}'}
            )
        except Exception:
            # Don't fail if external logging fails
            pass

handler = ExternalLogHandler()
handler.setFormatter(jsonlogger.JsonFormatter())
logger.addHandler(handler)
```

---

## 8. Data Privacy & Compliance

### Concerns

**GDPR Compliance**
- Risk: No mechanism for data deletion
- Risk: Cannot export user data
- Risk: No consent tracking

**Data Retention**
- Risk: Storing data longer than necessary
- Risk: No archival policy

**Sensitive Data in Memories**
- Risk: PII stored without encryption
- Risk: Medical/financial data in plain text

### Mitigations

**Right to Deletion (GDPR Article 17)**
```python
class DataPrivacyManager:
    """Handle GDPR/privacy compliance"""
    
    async def delete_user_data(
        self,
        user_id: str,
        permanent: bool = False,
        reason: str = None
    ):
        """Delete or anonymize user data"""
        
        if permanent:
            # Immediate permanent deletion
            await pool.execute(
                "DELETE FROM memories WHERE user_id = $1",
                user_id
            )
            await pool.execute(
                "DELETE FROM memory_audit_log WHERE user_id = $1",
                user_id
            )
            
            await self.log_deletion(user_id, "permanent", reason)
        
        else:
            # Soft delete with 30-day grace period
            await pool.execute(
                """
                UPDATE memories
                SET is_deleted = true,
                    deleted_at = NOW(),
                    content = '[REDACTED]',
                    embedding = NULL,
                    metadata = '{}'::jsonb
                WHERE user_id = $1
                """,
                user_id
            )
            
            # Schedule permanent deletion
            await self.schedule_permanent_deletion(
                user_id,
                delete_after_days=30
            )
        
        logger.info(f"User data deletion initiated: {user_id}")
    
    async def export_user_data(self, user_id: str) -> dict:
        """Export all user data (GDPR Article 20)"""
        
        memories = await pool.fetch(
            "SELECT * FROM memories WHERE user_id = $1",
            user_id
        )
        
        audit_logs = await pool.fetch(
            "SELECT * FROM memory_audit_log WHERE user_id = $1 ORDER BY timestamp DESC",
            user_id
        )
        
        return {
            "user_id": user_id,
            "exported_at": datetime.utcnow().isoformat(),
            "memories": [dict(m) for m in memories],
            "audit_logs": [dict(a) for a in audit_logs]
        }
```

**Data Retention Policies**
```python
# Automated cleanup job
async def enforce_retention_policy():
    """Delete old data per retention policy"""
    
    # Delete soft-deleted data after grace period
    await pool.execute(
        """
        DELETE FROM memories
        WHERE is_deleted = true
          AND deleted_at < NOW() - INTERVAL '30 days'
        """
    )
    
    # Archive old unused memories
    await pool.execute(
        """
        UPDATE memories
        SET is_archived = true, archived_at = NOW()
        WHERE created_at < NOW() - INTERVAL '2 years'
          AND access_count < 5
          AND NOT is_archived
        """
    )
    
    # Delete very old audit logs (keep 1 year)
    await pool.execute(
        """
        DELETE FROM memory_audit_log
        WHERE timestamp < NOW() - INTERVAL '1 year'
        """
    )
```

**Sensitive Data Detection**
```python
import re

class SensitiveDataDetector:
    """Detect PII in memory content"""
    
    PATTERNS = {
        'ssn': re.compile(r'\b\d{3}-\d{2}-\d{4}\b'),
        'credit_card': re.compile(r'\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b'),
        'email': re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'),
        'phone': re.compile(r'\b\d{3}[-.]?\d{3}[-.]?\d{4}\b'),
    }
    
    def scan(self, content: str) -> dict:
        """Scan for sensitive data"""
        
        findings = {}
        for name, pattern in self.PATTERNS.items():
            matches = pattern.findall(content)
            if matches:
                findings[name] = len(matches)
        
        return findings
    
    def redact(self, content: str) -> str:
        """Redact sensitive data"""
        
        redacted = content
        for name, pattern in self.PATTERNS.items():
            redacted = pattern.sub(f'[REDACTED_{name.upper()}]', redacted)
        
        return redacted

# Usage
detector = SensitiveDataDetector()
findings = detector.scan(memory_content)
if findings:
    logger.warning(f"Sensitive data detected: {findings}")
    # Option 1: Reject
    raise ValueError("Cannot store PII")
    # Option 2: Redact
    memory_content = detector.redact(memory_content)
```

---

## 9. Network Security

### Concerns

**Exposed Services**
- Risk: Direct internet access to databases
- Risk: Unencrypted traffic
- Risk: No network segmentation

**Man-in-the-Middle Attacks**
- Risk: API calls intercepted
- Risk: Database connections snooped

### Mitigations

**Network Architecture**
```
┌─────────────────────────────────────┐
│         Public Internet              │
└─────────────┬───────────────────────┘
              │
      ┌───────▼────────┐
      │  Reverse Proxy  │ (Nginx/Traefik)
      │  + TLS + WAF    │
      └───────┬────────┘
              │
   ┌──────────┼──────────┐
   │          │          │
┌──▼───┐  ┌──▼───┐  ┌──▼───┐
│Memory│  │Memory│  │ coda│
│Ingest│  │Search│  │ Main │
└──┬───┘  └──┬───┘  └──┬───┘
   │         │          │
   └─────────┼──────────┘
             │
    ┌────────▼────────┐
    │  Internal Only   │
    │  - PostgreSQL    │
    │  - Redis         │
    │  - No Ext Access │
    └─────────────────┘
```

**TLS Everywhere**
```yaml
# Docker Compose - force TLS
services:
  postgres:
    environment:
      POSTGRES_HOST_AUTH_METHOD: scram-sha-256
      POSTGRES_INITDB_ARGS: "--auth-host=scram-sha-256"
    command: 
      - "postgres"
      - "-c"
      - "ssl=on"
      - "-c"
      - "ssl_cert_file=/var/lib/postgresql/server.crt"
      - "-c"
      - "ssl_key_file=/var/lib/postgresql/server.key"
```

```python
# Python - verify TLS
import asyncpg

pool = await asyncpg.create_pool(
    host=DB_HOST,
    ssl='require',  # Require TLS
    server_settings={'ssl': 'on'}
)
```

**Firewall Rules**
```bash
# iptables - only allow from specific IPs
iptables -A INPUT -p tcp --dport 5432 -s 10.0.1.0/24 -j ACCEPT  # Internal network only
iptables -A INPUT -p tcp --dport 5432 -j DROP  # Block all other DB access

# Allow Redis only from app servers
iptables -A INPUT -p tcp --dport 6379 -s 10.0.1.10 -j ACCEPT  # Memory service
iptables -A INPUT -p tcp --dport 6379 -j DROP
```

**WAF Configuration**
```nginx
# Nginx with ModSecurity WAF
location /api/memory {
    # Rate limiting
    limit_req zone=memory burst=20 nodelay;
    
    # Block common attacks
    modsecurity on;
    modsecurity_rules_file /etc/nginx/modsec/main.conf;
    
    # HTTPS only
    if ($scheme != "https") {
        return 301 https://$host$request_uri;
    }
    
    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    
    proxy_pass http://memory-service:8001;
}
```

---

## 10. Backup Security

### Concerns

**Unencrypted Backups**
- Risk: Backup files stolen
- Risk: Backups on insecure storage

**Backup Access**
- Risk: No access control on backups
- Risk: Backups readable by anyone

### Mitigations

**Encrypted Backups**
```python
from cryptography.fernet import Fernet
import subprocess

class BackupManager:
    """Secure backup management"""
    
    def __init__(self, encryption_key: bytes):
        self.cipher = Fernet(encryption_key)
    
    async def create_encrypted_backup(self):
        """Create encrypted database backup"""
        
        # Dump database
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        backup_file = f'/tmp/backup_{timestamp}.sql'
        
        subprocess.run([
            'pg_dump',
            '-h', DB_HOST,
            '-U', DB_USER,
            '-d', DB_NAME,
            '-f', backup_file
        ], check=True)
        
        # Encrypt
        with open(backup_file, 'rb') as f:
            data = f.read()
        
        encrypted_data = self.cipher.encrypt(data)
        
        encrypted_file = f'{backup_file}.enc'
        with open(encrypted_file, 'wb') as f:
            f.write(encrypted_data)
        
        # Remove unencrypted version
        os.remove(backup_file)
        
        # Upload to secure storage
        await self.upload_to_s3(
            encrypted_file,
            bucket='coda-backups-encrypted',
            encryption='aws:kms',
            kms_key_id=KMS_KEY_ID
        )
        
        logger.info(f"Encrypted backup created: {encrypted_file}")
    
    async def restore_from_backup(self, backup_file: str):
        """Restore from encrypted backup"""
        
        # Download from S3
        await self.download_from_s3(backup_file, '/tmp/restore.sql.enc')
        
        # Decrypt
        with open('/tmp/restore.sql.enc', 'rb') as f:
            encrypted_data = f.read()
        
        decrypted_data = self.cipher.decrypt(encrypted_data)
        
        with open('/tmp/restore.sql', 'wb') as f:
            f.write(decrypted_data)
        
        # Restore
        subprocess.run([
            'psql',
            '-h', DB_HOST,
            '-U', DB_USER,
            '-d', DB_NAME,
            '-f', '/tmp/restore.sql'
        ], check=True)
```

**Backup Access Control**
```python
# S3 bucket policy - only backup service can access
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "AWS": "arn:aws:iam::ACCOUNT:role/BackupServiceRole"
            },
            "Action": [
                "s3:PutObject",
                "s3:GetObject"
            ],
            "Resource": "arn:aws:s3:::coda-backups-encrypted/*"
        },
        {
            "Effect": "Deny",
            "Principal": "*",
            "Action": "s3:*",
            "Resource": "arn:aws:s3:::coda-backups-encrypted/*",
            "Condition": {
                "StringNotEquals": {
                    "aws:PrincipalArn": "arn:aws:iam::ACCOUNT:role/BackupServiceRole"
                }
            }
        }
    ]
}
```

---

## 11. Log Sanitization

### Concerns

**Secrets in Logs**
- Risk: API keys logged
- Risk: Passwords in error messages
- Risk: User data in debug logs

**Log Injection**
- Risk: Newlines breaking log format
- Risk: Malicious log entries

### Mitigations

**Log Filtering**
```python
import logging
import re
import json

class SanitizingFormatter(logging.Formatter):
    """Remove sensitive data from logs"""
    
    SENSITIVE_PATTERNS = [
        # API keys
        (re.compile(r'(["\']?api[_-]?key["\']?\s*[:=]\s*["\']?)([a-zA-Z0-9_-]{20,})', re.I), r'\1***'),
        # Passwords
        (re.compile(r'(["\']?password["\']?\s*[:=]\s*["\']?)([^\s"\']+)', re.I), r'\1***'),
        # Tokens
        (re.compile(r'(Bearer\s+)([a-zA-Z0-9_-]+)', re.I), r'\1***'),
        # Email addresses in content
        (re.compile(r'\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Z|a-z]{2,})\b'), r'[EMAIL]@\2'),
    ]
    
    def format(self, record):
        original = super().format(record)
        
        # Apply sanitization patterns
        sanitized = original
        for pattern, replacement in self.SENSITIVE_PATTERNS:
            sanitized = pattern.sub(replacement, sanitized)
        
        return sanitized

# Configure
handler = logging.StreamHandler()
handler.setFormatter(SanitizingFormatter(
    '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
))
logging.getLogger().addHandler(handler)
```

**Structured Logging**
```python
import structlog

# Configure structured logging
structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.stdlib.add_log_level,
        structlog.processors.JSONRenderer()
    ],
    wrapper_class=structlog.stdlib.BoundLogger,
    logger_factory=structlog.stdlib.LoggerFactory(),
)

logger = structlog.get_logger()

# Log with structured data (easier to sanitize)
logger.info(
    "memory_ingested",
    user_id=user_id,
    memory_id=str(memory_id),
    content_length=len(content),  # Don't log actual content
    importance=importance
)
```

**Never Log Full Memory Content**
```python
# GOOD - Log metadata only
logger.info(
    "Memory stored",
    memory_id=memory_id,
    user_id=user_id,
    content_type=content_type,
    content_preview=content[:50] + "..."  # First 50 chars only
)

# BAD - Full content in logs
logger.info(f"Memory stored: {content}")  # NEVER DO THIS
```

---

## 12. Webhook Security

### Concerns

**Unauthenticated Webhooks**
- Risk: Anyone can trigger ingestion
- Risk: Fake events from malicious actors

**Replay Attacks**
- Risk: Same webhook replayed multiple times

### Mitigations

**Webhook Signature Verification**
```python
import hmac
import hashlib
from typing import Optional

class WebhookVerifier:
    """Verify webhook signatures"""
    
    def __init__(self, secret: str):
        self.secret = secret.encode()
    
    def verify(self, payload: str, signature: str, timestamp: str = None) -> bool:
        """Verify HMAC signature of webhook payload"""
        
        # Verify timestamp if provided (prevent replay)
        if timestamp:
            webhook_time = datetime.fromisoformat(timestamp)
            age_seconds = (datetime.utcnow() - webhook_time).total_seconds()
            if age_seconds > 300:  # 5 minute window
                logger.warning(f"Webhook timestamp too old: {age_seconds}s")
                return False
        
        # Compute expected signature
        expected = hmac.new(
            self.secret,
            payload.encode(),
            hashlib.sha256
        ).hexdigest()
        
        # Constant-time comparison
        try:
            return hmac.compare_digest(expected, signature)
        except Exception:
            return False

# Usage
@app.post("/webhook/n8n")
async def handle_n8n_webhook(request: Request):
    """Handle webhook from n8n"""
    
    # Get signature and timestamp from headers
    signature = request.headers.get('X-N8N-Signature')
    timestamp = request.headers.get('X-N8N-Timestamp')
    
    if not signature:
        raise HTTPException(status_code=401, detail="Missing signature")
    
    # Read body
    body = await request.body()
    payload = body.decode()
    
    # Verify signature
    verifier = WebhookVerifier(WEBHOOK_SECRET)
    if not verifier.verify(payload, signature, timestamp):
        logger.warning("Invalid webhook signature", extra={
            "ip": request.client.host,
            "user_agent": request.headers.get('user-agent')
        })
        raise HTTPException(status_code=403, detail="Invalid signature")
    
    # Process webhook
    data = json.loads(payload)
    await process_webhook_event(data)
    
    return {"status": "ok"}
```

**Webhook Rate Limiting**
```python
# Separate rate limit for webhooks
@app.post("/webhook/ingest")
@limiter.limit("500/hour")  # Higher limit for automated systems
async def webhook_ingest(...):
    ...
```

---

## 13. Data Integrity

### Concerns

**Tampering Detection**
- Risk: Memories modified without detection
- Risk: Database corruption

**Accidental Corruption**
- Risk: Application bugs corrupting data
- Risk: Failed transactions

### Mitigations

**Content Hash Verification**
```sql
-- Add content hash column
ALTER TABLE memories ADD COLUMN content_hash VARCHAR(64);
CREATE INDEX idx_memories_content_hash ON memories (content_hash);
```

```python
import hashlib

def calculate_content_hash(content: str, metadata: dict) -> str:
    """Calculate SHA-256 hash of memory content"""
    
    hash_input = f"{content}|{json.dumps(metadata, sort_keys=True)}"
    return hashlib.sha256(hash_input.encode()).hexdigest()

# On storage
content_hash = calculate_content_hash(content, metadata)
await pool.execute(
    "INSERT INTO memories (..., content_hash) VALUES (..., $n)",
    [..., content_hash]
)

# On retrieval - verify integrity
async def verify_memory_integrity(memory: dict) -> bool:
    """Verify memory hasn't been tampered with"""
    
    expected_hash = calculate_content_hash(
        memory['content'],
        memory['metadata']
    )
    
    if expected_hash != memory['content_hash']:
        logger.error(
            "Memory integrity check failed",
            memory_id=memory['id'],
            expected=expected_hash,
            actual=memory['content_hash']
        )
        return False
    
    return True
```

**Database Constraints**
```sql
-- Ensure critical fields are never NULL
ALTER TABLE memories
    ALTER COLUMN user_id SET NOT NULL,
    ALTER COLUMN content SET NOT NULL,
    ALTER COLUMN content_type SET NOT NULL;

-- Check constraints
ALTER TABLE memories
    ADD CONSTRAINT check_importance CHECK (importance >= 0 AND importance <= 1),
    ADD CONSTRAINT check_confidence CHECK (confidence >= 0 AND confidence <= 1);

-- Foreign key constraints (if applicable)
ALTER TABLE memories
    ADD CONSTRAINT fk_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
```

**Transaction Safety**
```python
# Always use transactions for multi-step operations
async def store_memory_with_audit(memory_data: dict):
    """Store memory with audit log in single transaction"""
    
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Store memory
            memory_id = await conn.fetchval(
                "INSERT INTO memories (...) VALUES (...) RETURNING id",
                [...]
            )
            
            # Create audit log entry
            await conn.execute(
                "INSERT INTO memory_audit_log (...) VALUES (...)",
                [...]
            )
            
            # Update user quota
            await conn.execute(
                """
                UPDATE user_quotas
                SET current_memory_count = current_memory_count + 1
                WHERE user_id = $1
                """,
                user_id
            )
    
    # Either all succeed or all rollback
    return memory_id
```

---

## 14. Timing Attacks

### Concerns

**Information Leakage via Timing**
- Risk: Response time reveals if data exists
- Risk: Different code paths take different times

### Mitigations

**Constant-Time Operations**
```python
import hmac
import secrets
import asyncio

# Use timing-safe comparison
def verify_api_key(provided: str, expected: str) -> bool:
    """Constant-time API key comparison"""
    return hmac.compare_digest(provided, expected)

# Add jitter to response times
async def search_with_constant_time(query: str, target_ms: int = 200):
    """Ensure searches take approximately same time"""
    
    start = time.time()
    
    # Perform search
    results = await perform_search(query)
    
    # Calculate remaining time to reach target
    elapsed_ms = (time.time() - start) * 1000
    if elapsed_ms < target_ms:
        jitter = secrets.randbelow(20) - 10  # ±10ms random
        sleep_ms = target_ms - elapsed_ms + jitter
        await asyncio.sleep(sleep_ms / 1000)
    
    return results
```

---

## 15. Memory Lifecycle Security

### Concerns

**Zombie Data**
- Risk: Deleted users' data still exists
- Risk: Old data never purged

**Uncontrolled Growth**
- Risk: Database grows indefinitely
- Risk: Performance degrades

### Mitigations

**Automated Cleanup Jobs**
```python
from apscheduler.schedulers.asyncio import AsyncIOScheduler

scheduler = AsyncIOScheduler()

@scheduler.scheduled_job('cron', hour=2)  # 2 AM daily
async def cleanup_deleted_data():
    """Permanent deletion after grace period"""
    
    result = await pool.execute(
        """
        DELETE FROM memories
        WHERE is_deleted = true
          AND deleted_at < NOW() - INTERVAL '30 days'
        """
    )
    logger.info(f"Deleted {result} old memories")

@scheduler.scheduled_job('cron', day_of_week='sun', hour=3)  # Sunday 3 AM
async def archive_old_memories():
    """Archive rarely accessed old memories"""
    
    await pool.execute(
        """
        UPDATE memories
        SET is_archived = true, archived_at = NOW()
        WHERE created_at < NOW() - INTERVAL '1 year'
          AND access_count < 3
          AND NOT is_archived
          AND NOT is_deleted
        """
    )

scheduler.start()
```

---

## 16. API Security

### Concerns

**API Abuse**
- Risk: Automated scraping
- Risk: Data exfiltration

**Missing Security Headers**
- Risk: XSS, clickjacking, etc.

### Mitigations

**Security Headers**
```python
from fastapi import Response
from starlette.middleware.base import BaseHTTPMiddleware

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['X-XSS-Protection'] = '1; mode=block'
        response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
        response.headers['Content-Security-Policy'] = "default-src 'self'"
        
        # Don't leak server info
        response.headers.pop('Server', None)
        
        return response

app.add_middleware(SecurityHeadersMiddleware)
```

**CORS Configuration**
```python
from fastapi.middleware.cors import CORSMiddleware

# Restrictive CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://coda.yourdomain.com",  # Only your domains
        "https://app.yourdomain.com"
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST"],  # Only needed methods
    allow_headers=["X-API-Key", "Content-Type"],
    max_age=3600
)
```

---

## 17. Database Security

### Concerns

**SQL Injection**
- Covered in Section 3

**Privilege Escalation**
- Risk: App has excessive DB permissions

**Connection String Exposure**
- Risk: Credentials in connection strings

### Mitigations

**Least Privilege Database User**
```sql
-- Create limited-privilege user for application
CREATE USER coda_app WITH PASSWORD 'secure_password';

-- Grant only necessary permissions
GRANT CONNECT ON DATABASE coda TO coda_app;
GRANT USAGE ON SCHEMA public TO coda_app;
GRANT SELECT, INSERT, UPDATE ON memories TO coda_app;
GRANT SELECT, INSERT ON memory_audit_log TO coda_app;

-- NO DELETE on memories (use soft delete)
-- NO access to user_quotas (separate admin user)

-- Read-only user for analytics
CREATE USER coda_readonly WITH PASSWORD 'secure_password';
GRANT CONNECT ON DATABASE coda TO coda_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO coda_readonly;
```

**Connection Pooling Security**
```python
# Limit connection lifetime
pool = await asyncpg.create_pool(
    ...,
    max_inactive_connection_lifetime=300,  # 5 min
    max_queries=50000,  # Recycle connection after 50k queries
    command_timeout=30,  # Timeout individual queries
    server_settings={
        'application_name': 'coda-memory-service',
        'timezone': 'UTC'
    }
)
```

---

## 18. Container Security

### Concerns

**Vulnerable Base Images**
- Risk: Outdated dependencies
- Risk: Known CVEs

**Privileged Containers**
- Risk: Container escape

### Mitigations

**Secure Dockerfiles**
```dockerfile
# Use specific versions, not 'latest'
FROM python:3.11.7-slim AS base

# Run as non-root user
RUN useradd -m -u 1000 coda && \
    chown -R coda:coda /app

USER coda

# Scan for vulnerabilities
# docker scan python:3.11.7-slim
```

**Docker Compose Security**
```yaml
services:
  memory-ingestion:
    # No privileged mode
    privileged: false
    
    # Drop all capabilities
    cap_drop:
      - ALL
    
    # Read-only root filesystem
    read_only: true
    tmpfs:
      - /tmp
    
    # Resource limits
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 4G
        reservations:
          memory: 2G
    
    # Security options
    security_opt:
      - no-new-privileges:true
    
    # Network isolation
    networks:
      - internal
    # No direct external access
```

---

## 19. Incident Response

### Concerns

**No Incident Plan**
- Risk: Slow response to breaches
- Risk: Evidence destroyed

**No Monitoring**
- Risk: Breaches go undetected

### Mitigations

**Incident Response Playbook**
```markdown
# Security Incident Response Plan

## Detection
1. Monitor for:
   - Failed authentication spikes
   - Unusual data access patterns
   - Database performance anomalies
   - Unexpected traffic patterns

## Containment
1. Rotate compromised API keys immediately
2. Block suspicious IP addresses
3. Enable read-only mode on database
4. Preserve audit logs

## Investigation
1. Review audit logs for unauthorized access
2. Check database for data exfiltration
3. Analyze network logs
4. Identify attack vector

## Recovery
1. Restore from backup if data corrupted
2. Deploy security patches
3. Update access controls
4. Notify affected users (if applicable)

## Post-Incident
1. Document lessons learned
2. Update security measures
3. Train team on new procedures
```

**Automated Alerting**
```python
import logging
from slack_sdk import WebClient

class SecurityAlertHandler(logging.Handler):
    """Send critical security events to Slack"""
    
    def __init__(self, slack_token: str, channel: str):
        super().__init__(level=logging.CRITICAL)
        self.slack = WebClient(token=slack_token)
        self.channel = channel
    
    def emit(self, record):
        if 'security' in record.getMessage().lower():
            self.slack.chat_postMessage(
                channel=self.channel,
                text=f"🚨 SECURITY ALERT: {record.getMessage()}",
                blocks=[{
                    "type": "section",
                    "text": {"type": "mrkdwn", "text": f"*{record.levelname}*: {record.getMessage()}"},
                    "fields": [
                        {"type": "mrkdwn", "text": f"*Time:*\n{record.created}"},
                        {"type": "mrkdwn", "text": f"*Module:*\n{record.module}"}
                    ]
                }]
            )

logger.addHandler(SecurityAlertHandler(SLACK_TOKEN, '#security-alerts'))
```

---

## 20. Security Testing

### Concerns

**No Security Testing**
- Risk: Vulnerabilities in production

**Manual Testing Only**
- Risk: Human error, incomplete coverage

### Mitigations

**Automated Security Tests**
```python
import pytest

@pytest.mark.security
async def test_sql_injection_protection():
    """Verify SQL injection is prevented"""
    
    malicious_inputs = [
        "'; DROP TABLE memories; --",
        "1' OR '1'='1",
        "admin'--",
        "1; DELETE FROM memories"
    ]
    
    for malicious in malicious_inputs:
        with pytest.raises(ValueError):
            await sanitize_content(malicious)

@pytest.mark.security
async def test_user_isolation():
    """Verify users cannot access other users' data"""
    
    # Create memories for two users
    memory_a = await create_memory(user_id="user_a", content="Secret A")
    memory_b = await create_memory(user_id="user_b", content="Secret B")
    
    # User A searches
    results = await search_memories(user_id="user_a", query="Secret")
    
    # Verify no leakage
    assert all(r['user_id'] == "user_a" for r in results)
    assert memory_b not in [r['id'] for r in results]

@pytest.mark.security
async def test_rate_limiting():
    """Verify rate limiting works"""
    
    # Make 101 requests (limit is 100)
    for i in range(101):
        if i < 100:
            response = await client.post("/ingest", ...)
            assert response.status_code == 200
        else:
            response = await client.post("/ingest", ...)
            assert response.status_code == 429  # Rate limited
```

**Penetration Testing**
```bash
# Run OWASP ZAP against API
docker run -t owasp/zap2docker-stable zap-baseline.py \
    -t https://api.coda.local \
    -r zap_report.html

# SQL injection testing with sqlmap
sqlmap -u "https://api.coda.local/search" \
    --data='{"query":"test"}' \
    --headers="X-API-Key: test-key" \
    --level=5 --risk=3

# Dependency vulnerability scanning
pip-audit
safety check
```

---

## Summary & Checklist

### Implementation Priority

**Critical (Must Have Before Production):**
- [ ] Multi-user data isolation (RLS)
- [ ] Input validation & sanitization
- [ ] API key authentication
- [ ] TLS everywhere
- [ ] Rate limiting
- [ ] Audit logging
- [ ] Secrets management (not in .env files)

**High (Implement Soon):**
- [ ] Webhook signature verification
- [ ] Backup encryption
- [ ] Log sanitization
- [ ] User quotas
- [ ] Data retention policies
- [ ] Anomaly detection

**Medium (Plan for V2):**
- [ ] Advanced RBAC
- [ ] Embedding poisoning detection
- [ ] Data integrity hashing
- [ ] Automated security testing
- [ ] Incident response playbook

**Low (Nice to Have):**
- [ ] Timing attack mitigations
- [ ] Advanced audit analytics
- [ ] Security training program

---

## Future Security Updates

**When adding new features, always consider:**
1. Does this introduce new attack surface?
2. Can users access other users' data?
3. What secrets need protection?
4. What should be logged?
5. What are the resource limits?
6. How can this be abused?

**Regular Security Tasks:**
- Monthly: Review audit logs for anomalies
- Quarterly: Dependency updates, penetration testing
- Yearly: Comprehensive security audit, update policies

---

**Document Maintenance:**
- Update this document when new security concerns are identified
- Reference specific sections in security reviews
- Link to this document from code comments for security-sensitive areas

**Last Updated:** 2026-02-08  
**Next Review:** 2026-03-08
