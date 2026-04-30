import asyncio
import logging
import os
import time

import redis.asyncio as aioredis
from dotenv import load_dotenv

import flows
import store

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("webhookinspector.worker")

if not os.getenv("DATABASE_URL"):
    raise RuntimeError("DATABASE_URL environment variable is required")

session_factory = store.get_session_factory()
redis_client = aioredis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379"))


async def retry_worker():
    logger.info("Retry worker started")
    while True:
        results = await redis_client.zpopmin(flows.RETRY_QUEUE_KEY, count=10)
        for job_data, score in results:
            if score > time.time():
                await redis_client.zadd(flows.RETRY_QUEUE_KEY, {job_data: score})
                continue
            try:
                payload = job_data if isinstance(job_data, str) else job_data.decode()
                await flows.process_retry_job(payload, session_factory, redis_client, logger)
            except Exception:
                logger.exception("Unexpected error processing retry job")
        await asyncio.sleep(1)


if __name__ == "__main__":
    asyncio.run(retry_worker())
