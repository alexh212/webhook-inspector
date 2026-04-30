from typing import Optional

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.dependencies import get_session_factory, parse_uuid
from app import runtime
from app.db.models import Endpoint

router = APIRouter()


@router.websocket("/ws/endpoints/{endpoint_id}")
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
    async with get_session_factory()() as db:
        result = await db.execute(select(Endpoint).where(Endpoint.id == endpoint_uuid))
        endpoint = result.scalar_one_or_none()
        if not endpoint:
            await websocket.close(code=4004)
            return
        if not session_id or session_id != endpoint.session_id:
            await websocket.close(code=4001)
            return

    pubsub = runtime.redis_client.pubsub()
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
