from fastapi import APIRouter

from ..models import HealthResponse
from ..services.embedding import get_model
from ..services.storage import check_connection

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    model_loaded = False
    try:
        get_model()
        model_loaded = True
    except RuntimeError:
        pass

    db_connected = await check_connection()

    return HealthResponse(
        status="ok" if (model_loaded and db_connected) else "degraded",
        model_loaded=model_loaded,
        database_connected=db_connected,
    )
