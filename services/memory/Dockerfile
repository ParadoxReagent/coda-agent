FROM python:3.12-slim

# Install build dependencies for numpy/sentence-transformers
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps with increased timeout and retries
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --timeout=1000 --retries=5 -r requirements.txt

# Pre-download the embedding model at build time (cache the model downloads)
RUN --mount=type=cache,target=/root/.cache/torch \
    python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')"

# Copy application code
COPY src/ ./src/

# Run as non-root user
RUN useradd --create-home --uid 1000 appuser
USER appuser

EXPOSE 8010

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8010"]
