import secrets

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Endpoint
from app.services.access import get_session_endpoint_or_404


async def create_endpoint(db: AsyncSession, name: str | None, session_id: str) -> dict:
    secret = secrets.token_hex(32)
    endpoint = Endpoint(name=name, session_id=session_id, secret=secret)
    db.add(endpoint)
    await db.commit()
    await db.refresh(endpoint)
    return {"id": str(endpoint.id), "url": f"/hooks/{endpoint.id}", "secret": secret}


async def list_endpoints(db: AsyncSession, session_id: str, limit: int, offset: int) -> list[dict]:
    result = await db.execute(
        select(Endpoint)
        .where(Endpoint.session_id == session_id)
        .order_by(Endpoint.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    endpoints = result.scalars().all()
    return [{"id": str(endpoint.id), "name": endpoint.name, "created_at": endpoint.created_at} for endpoint in endpoints]


async def delete_endpoint(db: AsyncSession, endpoint_id, session_id: str) -> dict:
    endpoint = await get_session_endpoint_or_404(db, endpoint_id, session_id)
    await db.delete(endpoint)
    await db.commit()
    return {"status": "deleted"}
