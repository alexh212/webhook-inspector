import asyncio
import json
import time
import os
import logging
import uuid

from dotenv import load_dotenv
import redis.asyncio as aioredis
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import select

from database import create_database_engine
from models import CapturedRequest, DeliveryAttempt
from retry import do_replay, enqueue_retry, sanitize_headers, validate_destination_url

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("webhookinspector.worker")

if not os.getenv("DATABASE_URL"):
    raise RuntimeError("DATABASE_URL environment variable is required")

engine = create_database_engine(echo=False)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
redis_client = aioredis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379"))


async def process_job(job_data: str):
    job = json.loads(job_data)
    request_id = job["request_id"]
    destination_url = job["destination_url"]
    attempt_number = job["attempt_number"]

    try:
        validate_destination_url(destination_url)
    except ValueError as exc:
        logger.warning("Blocked SSRF attempt in retry for %s: %s", request_id, exc)
        return

    async with AsyncSessionLocal() as db:
        query = await db.execute(
            select(CapturedRequest).where(CapturedRequest.id == uuid.UUID(request_id))
        )
        r = query.scalar_one_or_none()
        if not r:
            logger.warning("Request %s not found, skipping retry", request_id)
            return

        headers = sanitize_headers(r.headers)
        attempt = DeliveryAttempt(request_id=r.id, destination_url=destination_url)

        result = await do_replay(r.method, destination_url, headers, r.body)
        attempt.status_code = result["status_code"]
        attempt.response_headers = result["response_headers"]
        attempt.response_body = result["response_body"]
        attempt.duration_ms = result["duration_ms"]
        attempt.error = result["error"]
        success = not result["error"] and result["status_code"] is not None and int(result["status_code"]) < 500

        if result["error"]:
            logger.warning("Attempt %d for %s errored: %s", attempt_number, request_id, result["error"])
        elif result["status_code"]:
            logger.info("Attempt %d for %s -> %s", attempt_number, request_id, result["status_code"])

        db.add(attempt)
        await db.commit()

        if not success:
            await enqueue_retry(redis_client, request_id, destination_url, attempt_number + 1)


async def retry_worker():
    logger.info("Retry worker started")
    while True:
        # Pop up to 10 jobs at once. Jobs not yet due are re-inserted so other
        # due jobs behind them in the set can still be processed this tick.
        results = await redis_client.zpopmin("retry_queue", count=10)
        for job_data, score in results:
            if score > time.time():
                await redis_client.zadd("retry_queue", {job_data: score})
                continue
            try:
                await process_job(job_data if isinstance(job_data, str) else job_data.decode())
            except Exception:
                logger.exception("Unexpected error processing retry job")
        await asyncio.sleep(1)


if __name__ == "__main__":
    asyncio.run(retry_worker())
