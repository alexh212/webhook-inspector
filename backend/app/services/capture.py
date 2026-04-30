import hashlib
import hmac
import json

from fastapi import HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import MAX_BODY_SIZE
from app.db.models import CapturedRequest
from app.services.access import get_endpoint_or_404


async def capture_webhook(db: AsyncSession, request: Request, endpoint_id, endpoint_id_str: str, redis_client, logger) -> dict:
    endpoint = await get_endpoint_or_404(db, endpoint_id)

    content_length = int(request.headers.get("content-length", 0))
    if content_length > MAX_BODY_SIZE:
        raise HTTPException(status_code=413, detail="Request body too large")

    body = await request.body()
    if len(body) > MAX_BODY_SIZE:
        raise HTTPException(status_code=413, detail="Request body too large")

    if endpoint.secret:
        signature = request.headers.get("x-webhook-signature")
        if not signature:
            raise HTTPException(status_code=401, detail="Missing webhook signature")
        expected = hmac.new(endpoint.secret.encode(), body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise HTTPException(status_code=401, detail="Invalid signature")

    source_ip = request.client.host if request.client else "unknown"
    captured_request = CapturedRequest(
        endpoint_id=endpoint.id,
        method=request.method,
        headers=dict(request.headers),
        body=body.decode("utf-8", errors="replace"),
        query_params=dict(request.query_params),
        source_ip=source_ip,
        content_type=request.headers.get("content-type"),
    )
    db.add(captured_request)
    await db.commit()
    await db.refresh(captured_request)

    try:
        await redis_client.publish(
            f"endpoint:{endpoint_id_str}",
            json.dumps(
                {
                    "id": str(captured_request.id),
                    "method": captured_request.method,
                    "content_type": captured_request.content_type,
                    "source_ip": captured_request.source_ip,
                    "received_at": captured_request.received_at.isoformat(),
                }
            ),
        )
    except Exception as exc:
        logger.warning("Failed to publish webhook event for endpoint %s: %s", endpoint_id_str, exc)
    return {"status": "received"}
