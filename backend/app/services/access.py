from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import CapturedRequest, Endpoint


async def get_endpoint_or_404(db: AsyncSession, endpoint_id):
    result = await db.execute(select(Endpoint).where(Endpoint.id == endpoint_id))
    endpoint = result.scalar_one_or_none()
    if not endpoint:
        raise HTTPException(status_code=404, detail="Endpoint not found")
    return endpoint


async def get_session_endpoint_or_404(db: AsyncSession, endpoint_id, session_id: str):
    result = await db.execute(
        select(Endpoint).where(
            Endpoint.id == endpoint_id,
            Endpoint.session_id == session_id,
        )
    )
    endpoint = result.scalar_one_or_none()
    if not endpoint:
        raise HTTPException(status_code=404, detail="Endpoint not found")
    return endpoint


async def get_request_or_404(db: AsyncSession, request_id):
    result = await db.execute(select(CapturedRequest).where(CapturedRequest.id == request_id))
    captured_request = result.scalar_one_or_none()
    if not captured_request:
        raise HTTPException(status_code=404, detail="Not found")
    return captured_request


async def assert_request_session_access(db: AsyncSession, captured_request: CapturedRequest, session_id: str):
    result = await db.execute(
        select(Endpoint).where(
            Endpoint.id == captured_request.endpoint_id,
            Endpoint.session_id == session_id,
        )
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Forbidden")
