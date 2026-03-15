import asyncio
import json
import time
import os
from dotenv import load_dotenv
import redis.asyncio as aioredis
import httpx
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import select
from models import CapturedRequest, DeliveryAttempt
import uuid

load_dotenv()

engine = create_async_engine(os.getenv("DATABASE_URL"))
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
redis_client = aioredis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379"))


async def enqueue_retry(request_id: str, destination_url: str, attempt_number: int):
    if attempt_number >= 5:
        print(f"[worker] Max retries reached for {request_id}")
        return
    delay = 5 ** attempt_number
    job = json.dumps({
        "request_id": request_id,
        "destination_url": destination_url,
        "attempt_number": attempt_number,
    })
    await redis_client.zadd("retry_queue", {job: time.time() + delay})
    print(f"[worker] Retry {attempt_number} queued for {request_id} in {delay}s")


async def process_job(job_data: str):
    job = json.loads(job_data)
    request_id = job["request_id"]
    destination_url = job["destination_url"]
    attempt_number = job["attempt_number"]

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(CapturedRequest).where(CapturedRequest.id == uuid.UUID(request_id))
        )
        r = result.scalar_one_or_none()
        if not r:
            print(f"[worker] Request {request_id} not found, skipping")
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
            attempt.response_body = response.text
            attempt.duration_ms = str(round((time.time() - start) * 1000))
            success = response.status_code < 500
            print(f"[worker] Attempt {attempt_number} → {response.status_code}")

        except Exception as e:
            attempt.error = str(e)
            print(f"[worker] Attempt {attempt_number} errored: {e}")

        db.add(attempt)
        await db.commit()

        if not success:
            await enqueue_retry(request_id, destination_url, attempt_number + 1)


async def retry_worker():
    print("[worker] Started")
    while True:
        jobs = await redis_client.zrangebyscore("retry_queue", "-inf", time.time())
        for job_data in jobs:
            await redis_client.zrem("retry_queue", job_data)
            await process_job(job_data)
        await asyncio.sleep(1)


if __name__ == "__main__":
    asyncio.run(retry_worker())
