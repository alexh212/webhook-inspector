from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, get_session_id, parse_uuid
from app.runtime import limiter
from app.schemas import EndpointCreate
from app.services import endpoints as endpoint_service
from app.services import requests as request_service

router = APIRouter()


@router.post("/api/endpoints")
@limiter.limit("30/minute")
async def create_endpoint(
    request: Request,
    body: EndpointCreate,
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id),
):
    return await endpoint_service.create_endpoint(db, body.name, session_id)


@router.get("/api/endpoints")
async def list_endpoints(
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    return await endpoint_service.list_endpoints(db, session_id, limit, offset)


@router.get("/api/endpoints/{endpoint_id}/requests")
async def list_requests(
    endpoint_id: str,
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    endpoint_uuid = parse_uuid(endpoint_id, "endpoint ID")
    return await request_service.list_requests(db, endpoint_uuid, session_id, limit, offset)


@router.delete("/api/endpoints/{endpoint_id}")
async def delete_endpoint(
    endpoint_id: str,
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id),
):
    endpoint_uuid = parse_uuid(endpoint_id, "endpoint ID")
    return await endpoint_service.delete_endpoint(db, endpoint_uuid, session_id)
