import logging
import re
import unicodedata

import numpy as np
from sentence_transformers import SentenceTransformer

from ..config import settings

logger = logging.getLogger(__name__)

_model: SentenceTransformer | None = None


def get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        raise RuntimeError("Embedding model not loaded")
    return _model


def load_model() -> SentenceTransformer:
    global _model
    logger.info("Loading embedding model: %s", settings.embedding_model)
    _model = SentenceTransformer(settings.embedding_model)
    logger.info("Embedding model loaded (dim=%d)", _model.get_sentence_embedding_dimension())
    return _model


def sanitize_text(text: str) -> str:
    """Normalize and clean text for embedding."""
    # Normalize unicode
    text = unicodedata.normalize("NFKC", text)
    # Remove control characters (keep newlines/tabs)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]", "", text)
    # Collapse repeated whitespace
    text = re.sub(r"\s+", " ", text)
    # Collapse repeated characters (more than 5 in a row)
    text = re.sub(r"(.)\1{5,}", r"\1\1\1", text)
    # Truncate
    text = text.strip()[:settings.max_content_length]
    return text


def generate_embedding(text: str) -> list[float]:
    """Generate a normalised embedding vector for the given text."""
    model = get_model()
    clean = sanitize_text(text)
    if not clean:
        raise ValueError("Text is empty after sanitization")

    vec = model.encode(clean, normalize_embeddings=True)
    arr = np.asarray(vec, dtype=np.float32)

    # Validate output
    if np.any(np.isnan(arr)) or np.any(np.isinf(arr)):
        raise ValueError("Embedding contains NaN or Inf values")

    magnitude = float(np.linalg.norm(arr))
    if magnitude < 1e-6:
        raise ValueError("Embedding has near-zero magnitude")

    return arr.tolist()


def generate_embeddings_batch(texts: list[str]) -> list[list[float]]:
    """Generate embeddings for multiple texts in one forward pass."""
    model = get_model()
    cleaned = [sanitize_text(t) for t in texts]
    if not all(cleaned):
        raise ValueError("One or more texts are empty after sanitization")

    vecs = model.encode(cleaned, normalize_embeddings=True, batch_size=32)
    results = []
    for vec in vecs:
        arr = np.asarray(vec, dtype=np.float32)
        if np.any(np.isnan(arr)) or np.any(np.isinf(arr)):
            raise ValueError("Embedding contains NaN or Inf values")
        results.append(arr.tolist())
    return results
