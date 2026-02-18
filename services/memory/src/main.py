import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .config import settings
from .db import close_pool, init_pool
from .logging_filters import SuppressHealthAccessFilter
from .middleware.auth import ApiKeyMiddleware
from .routes.health import router as health_router
from .routes.ingest import router as ingest_router
from .routes.manage import router as manage_router
from .routes.search import router as search_router
from .services.embedding import load_model

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

access_logger = logging.getLogger("uvicorn.access")
if not any(isinstance(f, SuppressHealthAccessFilter) for f in access_logger.filters):
    access_logger.addFilter(SuppressHealthAccessFilter())

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting memory service")
    load_model()
    await init_pool()
    logger.info("Memory service ready")
    yield
    logger.info("Shutting down memory service")
    await close_pool()


app = FastAPI(title="Coda Memory Service", lifespan=lifespan)

# Middleware
app.add_middleware(ApiKeyMiddleware)

# Routes
app.include_router(health_router)
app.include_router(ingest_router)
app.include_router(search_router)
app.include_router(manage_router)
