from unittest.mock import AsyncMock, patch

import pytest
from dotenv import load_dotenv
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from store import create_database_engine

load_dotenv()


@pytest.fixture(scope="session")
async def client():
    engine = create_database_engine(echo=False, poolclass=NullPool)
    TestSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    import app as app_module

    app_module.limiter.enabled = False

    async def override_get_db():
        async with TestSessionLocal() as session:
            yield session

    app_module.app.dependency_overrides[app_module.store.get_db] = override_get_db

    with patch("app.redis_client") as mock_redis:
        mock_redis.ping = AsyncMock(return_value=True)
        mock_redis.publish = AsyncMock(return_value=1)
        mock_redis.zadd = AsyncMock(return_value=1)
        async with AsyncClient(transport=ASGITransport(app=app_module.app), base_url="http://test") as c:
            yield c

    app_module.app.dependency_overrides.clear()
    app_module.limiter.enabled = True
