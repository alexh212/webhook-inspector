from fastapi import FastAPI, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database import get_db
from models import Endpoint, CapturedRequest
from pydantic import BaseModel
from typing import Optional
import uuid, json
import redis.asyncio as aioredis
from dotenv import load_dotenv
import os

load_dotenv()

app = FastAPI(title="WebhookInspector")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174"],
    allow_methods=["*"],
    allow_headers=["*"],
)

redis_client = aioredis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379"))

class EndpointCreate(BaseModel):
    name: Optional[str] = None

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.post("/api/endpoints")
async def create_endpoint(body: EndpointCreate, db: AsyncSession = Depends(get_db)):
    ep = Endpoint(name=body.name)
    db.add(ep)
    await db.commit()
    await db.refresh(ep)
    return {"id": str(ep.id), "url": f"/hooks/{ep.id}"}

@app.get("/api/endpoints")
async def list_endpoints(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Endpoint).order_by(Endpoint.created_at.desc()))
    endpoints = result.scalars().all()
    return [{"id": str(e.id), "name": e.name, "created_at": e.created_at} for e in endpoints]

@app.api_route("/hooks/{endpoint_id}", methods=["GET","POST","PUT","PATCH","DELETE"])
async def capture_webhook(endpoint_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Endpoint).where(Endpoint.id == uuid.UUID(endpoint_id)))
    ep = result.scalar_one_or_none()
    if not ep:
        raise HTTPException(status_code=404, detail="Endpoint not found")

    body = await request.body()
    captured = CapturedRequest(
        endpoint_id=ep.id,
        method=request.method,
        headers=dict(request.headers),
        body=body.decode("utf-8", errors="replace"),
        query_params=dict(request.query_params),
        source_ip=request.client.host,
        content_type=request.headers.get("content-type"),
    )
    db.add(captured)
    await db.commit()
    await db.refresh(captured)

    # Publish to Redis pub/sub
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
async def list_requests(endpoint_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(CapturedRequest)
        .where(CapturedRequest.endpoint_id == uuid.UUID(endpoint_id))
        .order_by(CapturedRequest.received_at.desc())
    )
    reqs = result.scalars().all()
    return [{"id": str(r.id), "method": r.method, "content_type": r.content_type,
             "source_ip": r.source_ip, "received_at": r.received_at} for r in reqs]

@app.get("/api/requests/{request_id}")
async def get_request(request_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(CapturedRequest).where(CapturedRequest.id == uuid.UUID(request_id)))
    r = result.scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="Not found")
    return {"id": str(r.id), "method": r.method, "headers": r.headers,
            "body": r.body, "query_params": r.query_params,
            "source_ip": r.source_ip, "content_type": r.content_type, "received_at": r.received_at}

@app.websocket("/ws/endpoints/{endpoint_id}")
async def websocket_feed(websocket: WebSocket, endpoint_id: str):
    await websocket.accept()

    # Each subscriber needs its own Redis connection
    sub_redis = aioredis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379"))
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


# ── Replay ──────────────────────────────────────────────────────────────────

from models import DeliveryAttempt
import httpx, time

class ReplayRequest(BaseModel):
    destination_url: str
    body_override: Optional[str] = None

@app.post("/api/requests/{request_id}/replay")
async def replay_request(request_id: str, body: ReplayRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(CapturedRequest).where(CapturedRequest.id == uuid.UUID(request_id)))
    r = result.scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="Request not found")

    headers = dict(r.headers)
    headers.pop("host", None)
    headers.pop("content-length", None)

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
    except Exception as e:
        attempt.error = str(e)

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
async def list_attempts(request_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(DeliveryAttempt)
        .where(DeliveryAttempt.request_id == uuid.UUID(request_id))
        .order_by(DeliveryAttempt.attempted_at.desc())
    )
    attempts = result.scalars().all()
    return [{"id": str(a.id), "destination_url": a.destination_url, "status_code": a.status_code,
             "duration_ms": a.duration_ms, "error": a.error, "attempted_at": a.attempted_at} for a in attempts]
