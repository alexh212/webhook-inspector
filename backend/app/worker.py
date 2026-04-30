import asyncio
import logging
import os
import time

from dotenv import load_dotenv
import redis.asyncio as aioredis

from app.db.session import get_session_factory
from app.queue.retry_queue import RETRY_QUEUE_KEY
from app.services.replay import process_retry_job

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("webhookinspector.worker")

if not os.getenv("DATABASE_URL"):
    raise RuntimeError("DATABASE_URL environment variable is required")

session_factory = get_session_factory()
redis_client = aioredis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379"))


async def retry_worker():
    logger.info("Retry worker started")
    while True:
        results = await redis_client.zpopmin(RETRY_QUEUE_KEY, count=10)
        for job_data, score in results:
            if score > time.time():
                await redis_client.zadd(RETRY_QUEUE_KEY, {job_data: score})
                continue
            try:
                job_payload = job_data if isinstance(job_data, str) else job_data.decode()
                await process_retry_job(job_payload, session_factory, redis_client, logger)
            except Exception:
                logger.exception("Unexpected error processing retry job")
        await asyncio.sleep(1)
