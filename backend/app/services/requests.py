from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import CapturedRequest, DeliveryAttempt
from app.services.access import assert_request_session_access, get_request_or_404, get_session_endpoint_or_404


async def list_requests(db: AsyncSession, endpoint_id, session_id: str, limit: int, offset: int) -> list[dict]:
    await get_session_endpoint_or_404(db, endpoint_id, session_id)
    result = await db.execute(
        select(CapturedRequest)
        .where(CapturedRequest.endpoint_id == endpoint_id)
        .order_by(CapturedRequest.received_at.desc())
        .limit(limit)
        .offset(offset)
    )
    requests = result.scalars().all()
    return [
        {
            "id": str(captured_request.id),
            "method": captured_request.method,
            "content_type": captured_request.content_type,
            "source_ip": captured_request.source_ip,
            "received_at": captured_request.received_at,
        }
        for captured_request in requests
    ]


async def get_request(db: AsyncSession, request_id, session_id: str) -> dict:
    captured_request = await get_request_or_404(db, request_id)
    await assert_request_session_access(db, captured_request, session_id)
    return {
        "id": str(captured_request.id),
        "method": captured_request.method,
        "headers": captured_request.headers,
        "body": captured_request.body,
        "query_params": captured_request.query_params,
        "source_ip": captured_request.source_ip,
        "content_type": captured_request.content_type,
        "received_at": captured_request.received_at,
    }


async def list_attempts(db: AsyncSession, request_id, session_id: str) -> list[dict]:
    captured_request = await get_request_or_404(db, request_id)
    await assert_request_session_access(db, captured_request, session_id)
    result = await db.execute(
        select(DeliveryAttempt)
        .where(DeliveryAttempt.request_id == request_id)
        .order_by(DeliveryAttempt.attempted_at.desc())
    )
    attempts = result.scalars().all()
    return [
        {
            "id": str(attempt.id),
            "destination_url": attempt.destination_url,
            "status_code": attempt.status_code,
            "duration_ms": attempt.duration_ms,
            "error": attempt.error,
            "attempted_at": attempt.attempted_at,
        }
        for attempt in attempts
    ]


async def delete_request(db: AsyncSession, request_id, session_id: str) -> dict:
    captured_request = await get_request_or_404(db, request_id)
    await assert_request_session_access(db, captured_request, session_id)
    await db.delete(captured_request)
    await db.commit()
    return {"status": "deleted"}
