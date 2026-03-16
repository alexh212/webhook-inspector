import pytest
import asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool
from unittest.mock import AsyncMock, patch
import os
from dotenv import load_dotenv

load_dotenv()

@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    yield loop
    loop.close()

@pytest.fixture(scope="session")
async def client():
    engine = create_async_engine(
        os.getenv("DATABASE_URL"),
        poolclass=NullPool,
        echo=False
    )
    TestSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    from database import get_db
    from main import app

    async def override_get_db():
        async with TestSessionLocal() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db

    with patch("main.redis_client") as mock_redis:
        mock_redis.publish = AsyncMock(return_value=1)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            yield c

    app.dependency_overrides.clear()
