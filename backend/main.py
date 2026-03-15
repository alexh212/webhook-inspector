from fastapi import FastAPI, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect, Header
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database import get_db
from models import Endpoint, CapturedRequest, DeliveryAttempt
from pydantic import BaseModel
from typing import Optional
import uuid, json, time, os
import redis.asyncio as aioredis
import httpx
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="WebhookInspector")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174"],
    allow_methods=["*"],
    allow_headers=["*", "x-session-id"],
)

redis_client = aioredis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379"))


def get_session_id(x_session_id: Optional[str] = Header(None)) -> str:
    if not x_session_id or len(x_session_id) < 16:
        raise HTTPException(status_code=401, detail="Missing or invalid session ID")
    return x_session_id


async def enqueue_retry(request_id: str, destination_url: str, attempt_number: int):
    if attempt_number >= 5:
        return
    delay = 5 ** attempt_number
    job = json.dumps({
        "request_id": request_id,
        "destination_url": destination_url,
        "attempt_number": attempt_number,
    })
    await redis_client.zadd("retry_queue", {job: time.time() + delay})


class EndpointCreate(BaseModel):
    name: Optional[str] = None

class ReplayRequest(BaseModel):
    destination_url: str
    body_override: Optional[str] = None


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/api/endpoints")
async def create_endpoint(
    body: EndpointCreate,
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id)
):
    ep = Endpoint(name=body.name, session_id=session_id)
    db.add(ep)
    await db.commit()
    await db.refresh(ep)
    return {"id": str(ep.id), "url": f"/hooks/{ep.id}"}


@app.get("/api/endpoints")
async def list_endpoints(
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id)
):
    result = await db.execute(
        select(Endpoint)
        .where(Endpoint.session_id == session_id)
        .order_by(Endpoint.created_at.desc())
    )
    endpoints = result.scalars().all()
    return [{"id": str(e.id), "name": e.name, "created_at": e.created_at} for e in endpoints]


@app.api_route("/hooks/{endpoint_id}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
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
    session_id: str = Depends(get_session_id)
):
    result = await db.execute(select(Endpoint).where(
        Endpoint.id == uuid.UUID(endpoint_id),
        Endpoint.session_id == session_id
    ))
    ep = result.scalar_one_or_none()
    if not ep:
        raise HTTPException(status_code=404, detail="Endpoint not found")

    result = await db.execute(
        select(CapturedRequest)
        .where(CapturedRequest.endpoint_id == uuid.UUID(endpoint_id))
        .order_by(CapturedRequest.received_at.desc())
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
    result = await db.execute(select(CapturedRequest).where(CapturedRequest.id == uuid.UUID(request_id)))
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
    await websocket.accept()

    from database import AsyncSessionLocal
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Endpoint).where(Endpoint.id == uuid.UUID(endpoint_id)))
        ep = result.scalar_one_or_none()
        if not ep:
            await websocket.close(code=4004)
            return

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


@app.post("/api/requests/{request_id}/replay")
async def replay_request(
    request_id: str,
    body: ReplayRequest,
    db: AsyncSession = Depends(get_db),
    session_id: str = Depends(get_session_id)
):
    result = await db.execute(select(CapturedRequest).where(CapturedRequest.id == uuid.UUID(request_id)))
    r = result.scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="Request not found")

    ep_result = await db.execute(select(Endpoint).where(
        Endpoint.id == r.endpoint_id,
        Endpoint.session_id == session_id
    ))
    if not ep_result.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Forbidden")

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
        if response.status_code >= 500:
            await enqueue_retry(str(r.id), body.destination_url, 1)
    except Exception as e:
        attempt.error = str(e)
        await enqueue_retry(str(r.id), body.destination_url, 1)

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
    result = await db.execute(select(CapturedRequest).where(CapturedRequest.id == uuid.UUID(request_id)))
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
        .where(DeliveryAttempt.request_id == uuid.UUID(request_id))
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
    result = await db.execute(select(Endpoint).where(
        Endpoint.id == uuid.UUID(endpoint_id),
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
    result = await db.execute(select(CapturedRequest).where(CapturedRequest.id == uuid.UUID(request_id)))
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
