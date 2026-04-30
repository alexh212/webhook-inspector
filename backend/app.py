import logging
import os
import uuid
from typing import Optional

import redis.asyncio as aioredis
from dotenv import load_dotenv
from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.middleware.base import BaseHTTPMiddleware

import flows
import store

# ----- config + runtime -----

load_dotenv()

ALLOWED_ORIGINS = os.getenv(
    "ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:5174"
).split(",")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("webhookinspector")
limiter = Limiter(key_func=get_remote_address)
redis_client = aioredis.from_url(REDIS_URL)


# ----- middleware -----


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        return response


# ----- dependencies -----


def parse_uuid(value: str, label: str = "ID") -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail=f"Invalid {label}: {value}")


def get_session_id(x_session_id: Optional[str] = Header(None)) -> str:
    if not x_session_id or len(x_session_id) < 16:
        raise HTTPException(status_code=401, detail="Missing or invalid session ID")
    return x_session_id


# ----- pydantic schemas -----


class EndpointCreate(BaseModel):
    name: Optional[str] = Field(None, max_length=255)


class ReplayRequest(BaseModel):
    destination_url: str = Field(..., max_length=2048)
    body_override: Optional[str] = Field(None, max_length=flows.MAX_BODY_SIZE)


# ----- app + middleware wiring -----

app = FastAPI(title="WebhookInspector")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)
app.add_middleware(SecurityHeadersMiddleware)


# ----- routes -----


@app.get("/health")
async def health(db: AsyncSession = Depends(store.get_db)):
    checks = {"db": "ok", "redis": "ok"}
    try:
        await db.execute(text("SELECT 1"))
    except Exception as exc:
        logger.warning("Database health check failed: %s", exc)
        checks["db"] = "error"
    try:
        await redis_client.ping()
    except Exception as exc:
        logger.warning("Redis health check failed: %s", exc)
        checks["redis"] = "error"
    if not all(v == "ok" for v in checks.values()):
        raise HTTPException(status_code=503, detail=checks)
    return {"status": "ok", **checks}


@app.post("/api/endpoints")
@limiter.limit("30/minute")
async def create_endpoint(
    request: Request,
    body: EndpointCreate,
    db: AsyncSession = Depends(store.get_db),
    session_id: str = Depends(get_session_id),
):
    return await store.create_endpoint(db, body.name, session_id)


@app.get("/api/endpoints")
async def list_endpoints(
    db: AsyncSession = Depends(store.get_db),
    session_id: str = Depends(get_session_id),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    return await store.list_endpoints(db, session_id, limit, offset)


@app.delete("/api/endpoints/{endpoint_id}")
async def delete_endpoint(
    endpoint_id: str,
    db: AsyncSession = Depends(store.get_db),
    session_id: str = Depends(get_session_id),
):
    return await store.delete_endpoint(db, parse_uuid(endpoint_id, "endpoint ID"), session_id)


@app.get("/api/endpoints/{endpoint_id}/requests")
async def list_endpoint_requests(
    endpoint_id: str,
    db: AsyncSession = Depends(store.get_db),
    session_id: str = Depends(get_session_id),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    return await store.list_requests(
        db, parse_uuid(endpoint_id, "endpoint ID"), session_id, limit, offset
    )


@app.api_route("/hooks/{endpoint_id}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
@limiter.limit("60/minute")
async def capture_hook(
    request: Request,
    endpoint_id: str,
    db: AsyncSession = Depends(store.get_db),
):
    endpoint_uuid = parse_uuid(endpoint_id, "endpoint ID")
    return await flows.capture_webhook(db, request, endpoint_uuid, endpoint_id, redis_client, logger)


@app.get("/api/requests/{request_id}")
async def get_request_details(
    request_id: str,
    db: AsyncSession = Depends(store.get_db),
    session_id: str = Depends(get_session_id),
):
    return await store.get_request(db, parse_uuid(request_id, "request ID"), session_id)


@app.get("/api/requests/{request_id}/attempts")
async def list_request_attempts(
    request_id: str,
    db: AsyncSession = Depends(store.get_db),
    session_id: str = Depends(get_session_id),
):
    return await store.list_attempts(db, parse_uuid(request_id, "request ID"), session_id)


@app.delete("/api/requests/{request_id}")
async def delete_endpoint_request(
    request_id: str,
    db: AsyncSession = Depends(store.get_db),
    session_id: str = Depends(get_session_id),
):
    return await store.delete_request(db, parse_uuid(request_id, "request ID"), session_id)


@app.post("/api/requests/{request_id}/replay")
@limiter.limit("10/minute")
async def replay_endpoint_request(
    request: Request,
    request_id: str,
    body: ReplayRequest,
    db: AsyncSession = Depends(store.get_db),
    session_id: str = Depends(get_session_id),
):
    request_uuid = parse_uuid(request_id, "request ID")
    captured = await store.get_request_or_404(db, request_uuid)
    attempt = await flows.replay_request(
        db,
        captured,
        session_id,
        body.destination_url,
        body.body_override,
        redis_client,
        logger,
    )
    return {
        "id": str(attempt.id),
        "status_code": attempt.status_code,
        "response_body": attempt.response_body,
        "duration_ms": attempt.duration_ms,
        "error": attempt.error,
    }


@app.websocket("/ws/endpoints/{endpoint_id}")
async def websocket_feed(
    websocket: WebSocket,
    endpoint_id: str,
    session_id: Optional[str] = Query(None, min_length=16),
):
    try:
        endpoint_uuid = parse_uuid(endpoint_id, "endpoint ID")
    except HTTPException:
        await websocket.close(code=4000)
        return

    await websocket.accept()
    async with store.get_session_factory()() as db:
        endpoint = await store.get_endpoint(db, endpoint_uuid)
        if not endpoint:
            await websocket.close(code=4004)
            return
        if not session_id or session_id != endpoint.session_id:
            await websocket.close(code=4001)
            return

    pubsub = redis_client.pubsub()
    await pubsub.subscribe(f"endpoint:{endpoint_id}")
    try:
        async for message in pubsub.listen():
            if message["type"] == "message":
                await websocket.send_text(message["data"].decode())
    except WebSocketDisconnect:
        return
    finally:
        await pubsub.unsubscribe(f"endpoint:{endpoint_id}")
        await pubsub.close()
