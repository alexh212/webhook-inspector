import logging

import redis.asyncio as aioredis
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.config import REDIS_URL

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("webhookinspector")
limiter = Limiter(key_func=get_remote_address)
redis_client = aioredis.from_url(REDIS_URL)
