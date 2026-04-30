from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, get_session_id, parse_uuid
from app import runtime
from app.schemas import ReplayRequest
from app.services.access import get_request_or_404
from app.services.replay import replay_request
from app.services.requests import delete_request, get_request, list_attempts

router = APIRouter()


@router.get("/api/requests/{request_id}")
async def get_request_details(
    request_id: str,
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id),
):
    request_uuid = parse_uuid(request_id, "request ID")
    return await get_request(db, request_uuid, session_id)


@router.post("/api/requests/{request_id}/replay")
@runtime.limiter.limit("10/minute")
async def replay_endpoint_request(
    request: Request,
    request_id: str,
    body: ReplayRequest,
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id),
):
    request_uuid = parse_uuid(request_id, "request ID")
    captured_request = await get_request_or_404(db, request_uuid)
    attempt = await replay_request(
        db,
        captured_request,
        session_id,
        body.destination_url,
        body.body_override,
        runtime.redis_client,
        runtime.logger,
    )
    return {
        "id": str(attempt.id),
        "status_code": attempt.status_code,
        "response_body": attempt.response_body,
        "duration_ms": attempt.duration_ms,
        "error": attempt.error,
    }


@router.get("/api/requests/{request_id}/attempts")
async def list_request_attempts(
    request_id: str,
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id),
):
    request_uuid = parse_uuid(request_id, "request ID")
    return await list_attempts(db, request_uuid, session_id)


@router.delete("/api/requests/{request_id}")
async def delete_endpoint_request(
    request_id: str,
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id),
):
    request_uuid = parse_uuid(request_id, "request ID")
    return await delete_request(db, request_uuid, session_id)
