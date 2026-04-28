import asyncio
import os
from unittest.mock import AsyncMock, patch

import pytest
from dotenv import load_dotenv
from httpx import AsyncClient, ASGITransport
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from database import create_database_engine

load_dotenv()

@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    yield loop
    loop.close()

@pytest.fixture(scope="session")
async def client():
    engine = create_database_engine(echo=False, poolclass=NullPool)
    TestSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    from database import get_db
    from main import app, limiter

    limiter.enabled = False

    async def override_get_db():
        async with TestSessionLocal() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db

    with patch("main.redis_client") as mock_redis:
        mock_redis.publish = AsyncMock(return_value=1)
        mock_redis.zadd = AsyncMock(return_value=1)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            yield c

    app.dependency_overrides.clear()
    limiter.enabled = True
