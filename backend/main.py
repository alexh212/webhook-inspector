import hashlib
import hmac
import json
import logging
import os
import secrets
import time
import uuid
from typing import Optional

import httpx
import redis.asyncio as aioredis
from dotenv import load_dotenv
from fastapi import FastAPI, Depends, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.middleware.base import BaseHTTPMiddleware

from database import get_db, get_session_factory
from models import Endpoint, CapturedRequest, DeliveryAttempt
from retry import enqueue_retry, sanitize_headers, validate_destination_url

load_dotenv()

logger = logging.getLogger("webhookinspector")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

limiter = Limiter(key_func=get_remote_address)

app = FastAPI(title="WebhookInspector")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:5174").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        return response

app.add_middleware(SecurityHeadersMiddleware)

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
redis_client = aioredis.from_url(REDIS_URL)

MAX_BODY_SIZE = 1 * 1024 * 1024  # 1 MB


def parse_uuid(value: str, label: str = "ID") -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail=f"Invalid {label}: {value}")


def get_session_id(x_session_id: Optional[str] = Header(None)) -> str:
    if not x_session_id or len(x_session_id) < 16:
        raise HTTPException(status_code=401, detail="Missing or invalid session ID")
    return x_session_id


class EndpointCreate(BaseModel):
    name: Optional[str] = Field(None, max_length=255)

class ReplayRequest(BaseModel):
    destination_url: str = Field(..., max_length=2048)
    body_override: Optional[str] = Field(None, max_length=MAX_BODY_SIZE)


@app.get("/health")
async def health(db: AsyncSession = Depends(get_db)):
    checks = {"db": "ok", "redis": "ok"}
    try:
        await db.execute(text("SELECT 1"))
    except Exception:
        checks["db"] = "error"
    try:
        await redis_client.ping()
    except Exception:
        checks["redis"] = "error"
    healthy = all(v == "ok" for v in checks.values())
    if not healthy:
        raise HTTPException(status_code=503, detail=checks)
    return {"status": "ok", **checks}


@app.post("/api/endpoints")
@limiter.limit("30/minute")
async def create_endpoint(
    request: Request,
    body: EndpointCreate,
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id)
):
    secret = secrets.token_hex(32)
    ep = Endpoint(name=body.name, session_id=session_id, secret=secret)
    db.add(ep)
    await db.commit()
    await db.refresh(ep)
    return {"id": str(ep.id), "url": f"/hooks/{ep.id}", "secret": secret}


@app.get("/api/endpoints")
async def list_endpoints(
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    result = await db.execute(
        select(Endpoint)
        .where(Endpoint.session_id == session_id)
        .order_by(Endpoint.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    endpoints = result.scalars().all()
    return [{"id": str(e.id), "name": e.name, "created_at": e.created_at} for e in endpoints]


@app.api_route("/hooks/{endpoint_id}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
@limiter.limit("60/minute")
async def capture_webhook(request: Request, endpoint_id: str, db: AsyncSession = Depends(get_db)):
    ep_uuid = parse_uuid(endpoint_id, "endpoint ID")
    result = await db.execute(select(Endpoint).where(Endpoint.id == ep_uuid))
    ep = result.scalar_one_or_none()
    if not ep:
        raise HTTPException(status_code=404, detail="Endpoint not found")

    content_length = int(request.headers.get("content-length", 0))
    if content_length > MAX_BODY_SIZE:
        raise HTTPException(status_code=413, detail="Request body too large")

    body = await request.body()
    if len(body) > MAX_BODY_SIZE:
        raise HTTPException(status_code=413, detail="Request body too large")

    if ep.secret:
        signature = request.headers.get("x-webhook-signature")
        if not signature:
            raise HTTPException(status_code=401, detail="Missing webhook signature")
        expected = hmac.new(ep.secret.encode(), body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise HTTPException(status_code=401, detail="Invalid signature")

    source_ip = request.client.host if request.client else "unknown"

    captured = CapturedRequest(
        endpoint_id=ep.id,
        method=request.method,
        headers=dict(request.headers),
        body=body.decode("utf-8", errors="replace"),
        query_params=dict(request.query_params),
        source_ip=source_ip,
        content_type=request.headers.get("content-type"),
    )
    db.add(captured)
    await db.commit()
    await db.refresh(captured)

    await redis_client.publish(
        f"endpoint:{endpoint_id}",
        json.dumps({
            "id": str(captured.id),
            "method": captured.method,
            "content_type": captured.content_type,
            "source_ip": captured.source_ip,
            "received_at": captured.received_at.isoformat(),
        })
    )
    return {"status": "received"}


@app.get("/api/endpoints/{endpoint_id}/requests")
async def list_requests(
    endpoint_id: str,
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    ep_uuid = parse_uuid(endpoint_id, "endpoint ID")
    result = await db.execute(select(Endpoint).where(
        Endpoint.id == ep_uuid,
        Endpoint.session_id == session_id
    ))
    ep = result.scalar_one_or_none()
    if not ep:
        raise HTTPException(status_code=404, detail="Endpoint not found")

    result = await db.execute(
        select(CapturedRequest)
        .where(CapturedRequest.endpoint_id == ep_uuid)
        .order_by(CapturedRequest.received_at.desc())
        .limit(limit)
        .offset(offset)
    )
    reqs = result.scalars().all()
    return [{"id": str(r.id), "method": r.method, "content_type": r.content_type,
             "source_ip": r.source_ip, "received_at": r.received_at} for r in reqs]


@app.get("/api/requests/{request_id}")
async def get_request(
    request_id: str,
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id)
):
    req_uuid = parse_uuid(request_id, "request ID")
    result = await db.execute(select(CapturedRequest).where(CapturedRequest.id == req_uuid))
    r = result.scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="Not found")

    ep_result = await db.execute(select(Endpoint).where(
        Endpoint.id == r.endpoint_id,
        Endpoint.session_id == session_id
    ))
    if not ep_result.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Forbidden")

    return {"id": str(r.id), "method": r.method, "headers": r.headers,
            "body": r.body, "query_params": r.query_params,
            "source_ip": r.source_ip, "content_type": r.content_type, "received_at": r.received_at}


@app.websocket("/ws/endpoints/{endpoint_id}")
async def websocket_feed(websocket: WebSocket, endpoint_id: str, session_id: Optional[str] = None):
    try:
        ep_uuid = uuid.UUID(endpoint_id)
    except (ValueError, AttributeError):
        await websocket.close(code=4000)
        return

    await websocket.accept()

    async with get_session_factory()() as db:
        result = await db.execute(select(Endpoint).where(Endpoint.id == ep_uuid))
        ep = result.scalar_one_or_none()
        if not ep:
            await websocket.close(code=4004)
            return
        if not session_id or session_id != ep.session_id:
            await websocket.close(code=4001)
            return

    sub_redis = aioredis.from_url(REDIS_URL)
    pubsub = sub_redis.pubsub()
    await pubsub.subscribe(f"endpoint:{endpoint_id}")
    try:
        async for message in pubsub.listen():
            if message["type"] == "message":
                await websocket.send_text(message["data"].decode())
    except WebSocketDisconnect:
        pass
    finally:
        await pubsub.unsubscribe(f"endpoint:{endpoint_id}")
        await sub_redis.close()


@app.post("/api/requests/{request_id}/replay")
@limiter.limit("10/minute")
async def replay_request(
    request: Request,
    request_id: str,
    body: ReplayRequest,
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id)
):
    req_uuid = parse_uuid(request_id, "request ID")

    try:
        validate_destination_url(body.destination_url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    result = await db.execute(select(CapturedRequest).where(CapturedRequest.id == req_uuid))
    r = result.scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="Request not found")

    ep_result = await db.execute(select(Endpoint).where(
        Endpoint.id == r.endpoint_id,
        Endpoint.session_id == session_id
    ))
    if not ep_result.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Forbidden")

    headers = sanitize_headers(r.headers)

    payload = body.body_override if body.body_override is not None else r.body
    attempt = DeliveryAttempt(request_id=r.id, destination_url=body.destination_url)

    start = time.time()
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.request(
                method=r.method,
                url=body.destination_url,
                headers=headers,
                content=payload.encode() if payload else b"",
            )
        attempt.status_code = str(response.status_code)
        attempt.response_headers = dict(response.headers)
        attempt.response_body = response.text
        attempt.duration_ms = str(round((time.time() - start) * 1000))
        if response.status_code >= 500:
            await enqueue_retry(redis_client, str(r.id), body.destination_url, 1)
    except Exception as e:
        attempt.error = str(e)
        logger.warning("Replay failed for request %s: %s", request_id, e)
        await enqueue_retry(redis_client, str(r.id), body.destination_url, 1)

    db.add(attempt)
    await db.commit()
    await db.refresh(attempt)

    return {
        "id": str(attempt.id),
        "status_code": attempt.status_code,
        "response_body": attempt.response_body,
        "duration_ms": attempt.duration_ms,
        "error": attempt.error,
    }


@app.get("/api/requests/{request_id}/attempts")
async def list_attempts(
    request_id: str,
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id)
):
    req_uuid = parse_uuid(request_id, "request ID")
    result = await db.execute(select(CapturedRequest).where(CapturedRequest.id == req_uuid))
    r = result.scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="Not found")

    ep_result = await db.execute(select(Endpoint).where(
        Endpoint.id == r.endpoint_id,
        Endpoint.session_id == session_id
    ))
    if not ep_result.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Forbidden")

    result = await db.execute(
        select(DeliveryAttempt)
        .where(DeliveryAttempt.request_id == req_uuid)
        .order_by(DeliveryAttempt.attempted_at.desc())
    )
    attempts = result.scalars().all()
    return [{"id": str(a.id), "destination_url": a.destination_url, "status_code": a.status_code,
             "duration_ms": a.duration_ms, "error": a.error, "attempted_at": a.attempted_at} for a in attempts]


@app.delete("/api/endpoints/{endpoint_id}")
async def delete_endpoint(
    endpoint_id: str,
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id)
):
    ep_uuid = parse_uuid(endpoint_id, "endpoint ID")
    result = await db.execute(select(Endpoint).where(
        Endpoint.id == ep_uuid,
        Endpoint.session_id == session_id
    ))
    ep = result.scalar_one_or_none()
    if not ep:
        raise HTTPException(status_code=404, detail="Endpoint not found")
    await db.delete(ep)
    await db.commit()
    return {"status": "deleted"}


@app.delete("/api/requests/{request_id}")
async def delete_request(
    request_id: str,
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id)
):
    req_uuid = parse_uuid(request_id, "request ID")
    result = await db.execute(select(CapturedRequest).where(CapturedRequest.id == req_uuid))
    r = result.scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="Not found")

    ep_result = await db.execute(select(Endpoint).where(
        Endpoint.id == r.endpoint_id,
        Endpoint.session_id == session_id
    ))
    if not ep_result.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Forbidden")

    await db.delete(r)
    await db.commit()
    return {"status": "deleted"}
