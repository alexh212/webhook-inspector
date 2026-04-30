import os
import secrets
import uuid
from datetime import datetime, timezone

from dotenv import load_dotenv
from fastapi import HTTPException
from sqlalchemy import Column, DateTime, ForeignKey, String, Text, select
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import declarative_base, sessionmaker

load_dotenv()

Base = declarative_base()


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Endpoint(Base):
    __tablename__ = "endpoints"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=True)
    session_id = Column(String(64), nullable=True, index=True)
    secret = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=_utcnow)


class CapturedRequest(Base):
    __tablename__ = "captured_requests"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    endpoint_id = Column(UUID(as_uuid=True), ForeignKey("endpoints.id", ondelete="CASCADE"))
    method = Column(String(10))
    headers = Column(JSONB)
    body = Column(Text)
    query_params = Column(JSONB)
    source_ip = Column(String(45))
    content_type = Column(String(255))
    received_at = Column(DateTime, default=_utcnow)


class DeliveryAttempt(Base):
    __tablename__ = "delivery_attempts"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id = Column(UUID(as_uuid=True), ForeignKey("captured_requests.id", ondelete="CASCADE"))
    destination_url = Column(Text, nullable=False)
    status_code = Column(String(10), nullable=True)
    response_headers = Column(JSONB, nullable=True)
    response_body = Column(Text, nullable=True)
    duration_ms = Column(String(20), nullable=True)
    error = Column(Text, nullable=True)
    attempted_at = Column(DateTime, default=_utcnow)


_factory = None


def create_database_engine(echo: bool | None = None, poolclass=None):
    url = os.getenv("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL environment variable is required")
    if echo is None:
        echo = os.getenv("DEBUG", "").lower() in ("1", "true", "yes")
    url_obj = make_url(url)
    if url_obj.drivername in ("postgres", "postgresql", "postgresql+psycopg2", "postgresql+psycopg"):
        url_obj = url_obj.set(drivername="postgresql+asyncpg")
    query = dict(url_obj.query.items()) if url_obj.query else {}
    sslmode = query.pop("sslmode", None)
    query.pop("channel_binding", None)
    ssl_value = query.pop("ssl", None)
    use_ssl = (
        sslmode == "require"
        or str(ssl_value or "").lower() in ("true", "require", "1")
        or (url_obj.host is not None and "neon.tech" in url_obj.host)
    )
    url_obj = url_obj.set(query=query)
    kwargs = {"echo": echo}
    if poolclass is not None:
        kwargs["poolclass"] = poolclass
    if use_ssl:
        kwargs["connect_args"] = {"ssl": True}
    return create_async_engine(url_obj, **kwargs)


def get_session_factory():
    global _factory
    if _factory is None:
        engine = create_database_engine()
        _factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return _factory


async def get_db():
    async with get_session_factory()() as session:
        yield session


# ----- query helpers -----


async def get_endpoint(db: AsyncSession, endpoint_id) -> Endpoint | None:
    result = await db.execute(select(Endpoint).where(Endpoint.id == endpoint_id))
    return result.scalar_one_or_none()


async def get_endpoint_or_404(db: AsyncSession, endpoint_id) -> Endpoint:
    endpoint = await get_endpoint(db, endpoint_id)
    if not endpoint:
        raise HTTPException(status_code=404, detail="Endpoint not found")
    return endpoint


async def get_session_endpoint_or_404(db: AsyncSession, endpoint_id, session_id: str) -> Endpoint:
    result = await db.execute(
        select(Endpoint).where(Endpoint.id == endpoint_id, Endpoint.session_id == session_id)
    )
    endpoint = result.scalar_one_or_none()
    if not endpoint:
        raise HTTPException(status_code=404, detail="Endpoint not found")
    return endpoint


async def get_request_or_404(db: AsyncSession, request_id) -> CapturedRequest:
    result = await db.execute(select(CapturedRequest).where(CapturedRequest.id == request_id))
    captured = result.scalar_one_or_none()
    if not captured:
        raise HTTPException(status_code=404, detail="Not found")
    return captured


async def assert_request_session_access(db: AsyncSession, captured: CapturedRequest, session_id: str) -> None:
    result = await db.execute(
        select(Endpoint).where(
            Endpoint.id == captured.endpoint_id,
            Endpoint.session_id == session_id,
        )
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Forbidden")


# ----- endpoint CRUD -----


async def create_endpoint(
    db: AsyncSession, name: str | None, session_id: str, require_signature: bool = False
) -> dict:
    secret = secrets.token_hex(32) if require_signature else None
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
    return [
        {"id": str(e.id), "name": e.name, "created_at": e.created_at}
        for e in result.scalars().all()
    ]


async def delete_endpoint(db: AsyncSession, endpoint_id, session_id: str) -> dict:
    endpoint = await get_session_endpoint_or_404(db, endpoint_id, session_id)
    await db.delete(endpoint)
    await db.commit()
    return {"status": "deleted"}


# ----- request CRUD -----


async def list_requests(db: AsyncSession, endpoint_id, session_id: str, limit: int, offset: int) -> list[dict]:
    await get_session_endpoint_or_404(db, endpoint_id, session_id)
    result = await db.execute(
        select(CapturedRequest)
        .where(CapturedRequest.endpoint_id == endpoint_id)
        .order_by(CapturedRequest.received_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return [
        {
            "id": str(r.id),
            "method": r.method,
            "content_type": r.content_type,
            "source_ip": r.source_ip,
            "received_at": r.received_at,
        }
        for r in result.scalars().all()
    ]


async def get_request(db: AsyncSession, request_id, session_id: str) -> dict:
    captured = await get_request_or_404(db, request_id)
    await assert_request_session_access(db, captured, session_id)
    return {
        "id": str(captured.id),
        "method": captured.method,
        "headers": captured.headers,
        "body": captured.body,
        "query_params": captured.query_params,
        "source_ip": captured.source_ip,
        "content_type": captured.content_type,
        "received_at": captured.received_at,
    }


async def list_attempts(db: AsyncSession, request_id, session_id: str) -> list[dict]:
    captured = await get_request_or_404(db, request_id)
    await assert_request_session_access(db, captured, session_id)
    result = await db.execute(
        select(DeliveryAttempt)
        .where(DeliveryAttempt.request_id == request_id)
        .order_by(DeliveryAttempt.attempted_at.desc())
    )
    return [
        {
            "id": str(a.id),
            "destination_url": a.destination_url,
            "status_code": a.status_code,
            "duration_ms": a.duration_ms,
            "error": a.error,
            "attempted_at": a.attempted_at,
        }
        for a in result.scalars().all()
    ]


async def delete_request(db: AsyncSession, request_id, session_id: str) -> dict:
    captured = await get_request_or_404(db, request_id)
    await assert_request_session_access(db, captured, session_id)
    await db.delete(captured)
    await db.commit()
    return {"status": "deleted"}


async def add_captured_request(db: AsyncSession, **fields) -> CapturedRequest:
    captured = CapturedRequest(**fields)
    db.add(captured)
    await db.commit()
    await db.refresh(captured)
    return captured


async def add_delivery_attempt(db: AsyncSession, **fields) -> DeliveryAttempt:
    attempt = DeliveryAttempt(**fields)
    db.add(attempt)
    await db.commit()
    await db.refresh(attempt)
    return attempt
