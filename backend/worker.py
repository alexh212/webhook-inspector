import asyncio
import json
import time
import os
import logging
import uuid

from dotenv import load_dotenv
import redis.asyncio as aioredis
import httpx
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import select

from models import CapturedRequest, DeliveryAttempt
from retry import enqueue_retry, validate_destination_url

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("webhookinspector.worker")

db_url = os.getenv("DATABASE_URL")
if not db_url:
    raise RuntimeError("DATABASE_URL environment variable is required")

engine = create_async_engine(db_url)
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
        result = await db.execute(
            select(CapturedRequest).where(CapturedRequest.id == uuid.UUID(request_id))
        )
        r = result.scalar_one_or_none()
        if not r:
            logger.warning("Request %s not found, skipping retry", request_id)
            return

        headers = dict(r.headers)
        headers.pop("host", None)
        headers.pop("content-length", None)

        attempt = DeliveryAttempt(request_id=r.id, destination_url=destination_url)
        success = False

        try:
            start = time.time()
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.request(
                    method=r.method,
                    url=destination_url,
                    headers=headers,
                    content=r.body.encode() if r.body else b"",
                )
            attempt.status_code = str(response.status_code)
            attempt.response_headers = dict(response.headers)
            attempt.response_body = response.text
            attempt.duration_ms = str(round((time.time() - start) * 1000))
            success = response.status_code < 500
            logger.info("Attempt %d for %s -> %d", attempt_number, request_id, response.status_code)

        except Exception as e:
            attempt.error = str(e)
            logger.warning("Attempt %d for %s errored: %s", attempt_number, request_id, e)

        db.add(attempt)
        await db.commit()

        if not success:
            await enqueue_retry(redis_client, request_id, destination_url, attempt_number + 1)


async def retry_worker():
    logger.info("Retry worker started")
    while True:
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
