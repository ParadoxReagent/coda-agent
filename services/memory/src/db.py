import asyncpg
import logging

from .config import settings

logger = logging.getLogger(__name__)

pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    global pool
    if pool is None:
        raise RuntimeError("Database pool not initialised")
    return pool


async def init_pool() -> asyncpg.Pool:
    global pool
    pool = await asyncpg.create_pool(
        settings.database_url,
        min_size=settings.pool_min_size,
        max_size=settings.pool_max_size,
    )
    logger.info("Database pool created")
    return pool


async def close_pool() -> None:
    global pool
    if pool:
        await pool.close()
        pool = None
        logger.info("Database pool closed")
