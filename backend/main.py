from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database import get_db
from models import Endpoint, CapturedRequest
from pydantic import BaseModel
from typing import Optional
import uuid

app = FastAPI(title="WebhookInspector")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174", "http://localhost:5174"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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
