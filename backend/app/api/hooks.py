from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, parse_uuid
from app import runtime
from app.services.capture import capture_webhook

router = APIRouter()


@router.api_route("/hooks/{endpoint_id}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
@runtime.limiter.limit("60/minute")
async def capture_hook(request: Request, endpoint_id: str, db: AsyncSession = Depends(get_db)):
    endpoint_uuid = parse_uuid(endpoint_id, "endpoint ID")
    return await capture_webhook(db, request, endpoint_uuid, endpoint_id, runtime.redis_client, runtime.logger)
