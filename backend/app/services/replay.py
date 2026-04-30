import json
import uuid

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import CapturedRequest, DeliveryAttempt
from app.outbound.replay_http import do_replay, sanitize_headers, validate_destination_url
from app.queue.retry_queue import enqueue_retry
from app.services.access import assert_request_session_access


async def _run_replay(db: AsyncSession, captured_request: CapturedRequest, destination_url: str, payload: str | None):
    headers = sanitize_headers(captured_request.headers)
    replay_result = await do_replay(captured_request.method, destination_url, headers, payload)
    attempt = DeliveryAttempt(request_id=captured_request.id, destination_url=destination_url)
    attempt.status_code = replay_result["status_code"]
    attempt.response_headers = replay_result["response_headers"]
    attempt.response_body = replay_result["response_body"]
    attempt.duration_ms = replay_result["duration_ms"]
    attempt.error = replay_result["error"]
    db.add(attempt)
    await db.commit()
    await db.refresh(attempt)
    return attempt, replay_result


async def replay_request(db: AsyncSession, captured_request: CapturedRequest, session_id: str, destination_url: str, body_override: str | None, redis_client, logger):
    try:
        validate_destination_url(destination_url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    await assert_request_session_access(db, captured_request, session_id)
    payload = body_override if body_override is not None else captured_request.body
    attempt, replay_result = await _run_replay(db, captured_request, destination_url, payload)

    if replay_result["error"]:
        logger.warning("Replay failed for request %s: %s", captured_request.id, replay_result["error"])
        await enqueue_retry(redis_client, str(captured_request.id), destination_url, 1)
    elif replay_result["status_code"] and int(replay_result["status_code"]) >= 500:
        await enqueue_retry(redis_client, str(captured_request.id), destination_url, 1)
    return attempt


async def process_retry_job(job_data: str, session_factory, redis_client, logger):
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
        result = await db.get(CapturedRequest, uuid.UUID(request_id))
        if not result:
            logger.warning("Request %s not found, skipping retry", request_id)
            return
        attempt, replay_result = await _run_replay(db, result, destination_url, result.body)

    if replay_result["error"]:
        logger.warning("Attempt %d for %s errored: %s", attempt_number, request_id, replay_result["error"])
        await enqueue_retry(redis_client, request_id, destination_url, attempt_number + 1)
    elif replay_result["status_code"] and int(replay_result["status_code"]) >= 500:
        await enqueue_retry(redis_client, request_id, destination_url, attempt_number + 1)
    else:
        logger.info("Attempt %d for %s -> %s", attempt_number, request_id, attempt.status_code)
