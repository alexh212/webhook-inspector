import json
import logging
import time
import uuid

import httpx
from fastapi import HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

import store
from security import sanitize_headers, validate_destination_url, verify_hmac_signature

MAX_RETRIES = 5
RETRY_QUEUE_KEY = "retry_queue"
MAX_BODY_SIZE = 1 * 1024 * 1024


# ----- capture flow -----


async def capture_webhook(
    db: AsyncSession,
    request: Request,
    endpoint_uuid,
    endpoint_id_str: str,
    redis_client,
    logger: logging.Logger,
) -> dict:
    endpoint = await store.get_endpoint_or_404(db, endpoint_uuid)

    content_length = int(request.headers.get("content-length", 0))
    if content_length > MAX_BODY_SIZE:
        raise HTTPException(status_code=413, detail="Request body too large")

    body = await request.body()
    if len(body) > MAX_BODY_SIZE:
        raise HTTPException(status_code=413, detail="Request body too large")

    if endpoint.secret:
        verify_hmac_signature(endpoint.secret, body, request.headers.get("x-webhook-signature"))

    captured = await store.add_captured_request(
        db,
        endpoint_id=endpoint.id,
        method=request.method,
        headers=dict(request.headers),
        body=body.decode("utf-8", errors="replace"),
        query_params=dict(request.query_params),
        source_ip=request.client.host if request.client else "unknown",
        content_type=request.headers.get("content-type"),
    )

    try:
        await redis_client.publish(
            f"endpoint:{endpoint_id_str}",
            json.dumps(
                {
                    "id": str(captured.id),
                    "method": captured.method,
                    "content_type": captured.content_type,
                    "source_ip": captured.source_ip,
                    "received_at": captured.received_at.isoformat(),
                }
            ),
        )
    except Exception as exc:
        logger.warning("Failed to publish webhook event for endpoint %s: %s", endpoint_id_str, exc)
    return {"status": "received"}


# ----- replay flow (shared by API + worker) -----


async def do_replay(method: str, url: str, headers: dict, body: str | None) -> dict:
    start = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.request(
                method=method,
                url=url,
                headers=headers,
                content=body.encode() if body else b"",
            )
        return {
            "status_code": str(response.status_code),
            "response_headers": dict(response.headers),
            "response_body": response.text,
            "duration_ms": str(round((time.perf_counter() - start) * 1000)),
            "error": None,
        }
    except httpx.HTTPError as exc:
        return {
            "status_code": None,
            "response_headers": {},
            "response_body": None,
            "duration_ms": None,
            "error": f"Replay request failed: {exc}",
        }


async def _execute_replay(db: AsyncSession, captured, destination_url: str, payload: str | None):
    headers = sanitize_headers(captured.headers)
    result = await do_replay(captured.method, destination_url, headers, payload)
    attempt = await store.add_delivery_attempt(
        db,
        request_id=captured.id,
        destination_url=destination_url,
        status_code=result["status_code"],
        response_headers=result["response_headers"],
        response_body=result["response_body"],
        duration_ms=result["duration_ms"],
        error=result["error"],
    )
    return attempt, result


def _should_retry(result: dict) -> bool:
    if result["error"]:
        return True
    code = result["status_code"]
    return bool(code and int(code) >= 500)


async def enqueue_retry(redis_client, request_id: str, destination_url: str, attempt_number: int, logger: logging.Logger) -> None:
    if attempt_number >= MAX_RETRIES:
        logger.info("Max retries (%d) reached for request %s", MAX_RETRIES, request_id)
        return
    delay = 5 ** attempt_number
    job = json.dumps(
        {"request_id": request_id, "destination_url": destination_url, "attempt_number": attempt_number}
    )
    await redis_client.zadd(RETRY_QUEUE_KEY, {job: time.time() + delay})
    logger.info("Retry %d queued for request %s in %ds", attempt_number, request_id, delay)


async def replay_request(
    db: AsyncSession,
    captured,
    session_id: str,
    destination_url: str,
    body_override: str | None,
    redis_client,
    logger: logging.Logger,
):
    try:
        validate_destination_url(destination_url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    await store.assert_request_session_access(db, captured, session_id)
    payload = body_override if body_override is not None else captured.body
    attempt, result = await _execute_replay(db, captured, destination_url, payload)

    if _should_retry(result):
        if result["error"]:
            logger.warning("Replay failed for request %s: %s", captured.id, result["error"])
        await enqueue_retry(redis_client, str(captured.id), destination_url, 1, logger)
    return attempt


async def process_retry_job(job_data: str, session_factory, redis_client, logger: logging.Logger) -> None:
    job = json.loads(job_data)
    request_id = job["request_id"]
    destination_url = job["destination_url"]
    attempt_number = job["attempt_number"]

    try:
        validate_destination_url(destination_url)
    except ValueError as exc:
        logger.warning("Blocked SSRF attempt in retry for %s: %s", request_id, exc)
        return

    async with session_factory() as db:
        captured = await db.get(store.CapturedRequest, uuid.UUID(request_id))
        if not captured:
            logger.warning("Request %s not found, skipping retry", request_id)
            return
        attempt, result = await _execute_replay(db, captured, destination_url, captured.body)

    if _should_retry(result):
        if result["error"]:
            logger.warning("Attempt %d for %s errored: %s", attempt_number, request_id, result["error"])
        await enqueue_retry(redis_client, request_id, destination_url, attempt_number + 1, logger)
    else:
        logger.info("Attempt %d for %s -> %s", attempt_number, request_id, attempt.status_code)
