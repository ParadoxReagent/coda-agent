FROM python:3.12-slim AS builder

# Install build dependencies for numpy/sentence-transformers
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir --timeout=1000 --retries=5 -r requirements.txt

# Pre-download the embedding model at build time
ENV SENTENCE_TRANSFORMERS_HOME=/app/models
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')"

# --- Runtime ---
FROM python:3.12-slim

WORKDIR /app

# Copy installed packages and entry-point binaries from builder (no build-essential in runtime)
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin/uvicorn /usr/local/bin/uvicorn

# Copy pre-downloaded model
COPY --from=builder /app/models /app/models
ENV SENTENCE_TRANSFORMERS_HOME=/app/models

# Copy application code
COPY src/ ./src/

# Run as non-root user
RUN useradd --create-home --uid 1000 appuser && \
    chown -R appuser:appuser /app/models
USER appuser

EXPOSE 8010

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8010"]
