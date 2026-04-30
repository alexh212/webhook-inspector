import json
import logging
import time

import redis.asyncio as aioredis

MAX_RETRIES = 5
RETRY_QUEUE_KEY = "retry_queue"

logger = logging.getLogger("webhookinspector")


async def enqueue_retry(
    redis_client: aioredis.Redis,
    request_id: str,
    destination_url: str,
    attempt_number: int,
) -> None:
    if attempt_number >= MAX_RETRIES:
        logger.info("Max retries (%d) reached for request %s", MAX_RETRIES, request_id)
        return
    delay = 5 ** attempt_number
    job = json.dumps(
        {
            "request_id": request_id,
            "destination_url": destination_url,
            "attempt_number": attempt_number,
        }
    )
    await redis_client.zadd(RETRY_QUEUE_KEY, {job: time.time() + delay})
    logger.info("Retry %d queued for request %s in %ds", attempt_number, request_id, delay)
