from fastapi import APIRouter

from app.api.endpoints import router as endpoints_router
from app.api.health import router as health_router
from app.api.hooks import router as hooks_router
from app.api.requests import router as requests_router
from app.api.websocket import router as websocket_router


def create_api_router():
    api_router = APIRouter()
    api_router.include_router(health_router)
    api_router.include_router(endpoints_router)
    api_router.include_router(hooks_router)
    api_router.include_router(requests_router)
    api_router.include_router(websocket_router)
    return api_router
