import os

from dotenv import load_dotenv
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

load_dotenv()

_factory = None


def get_session_factory():
    # Lazy init so test fixtures can override get_db before the engine is created.
    global _factory
    if _factory is None:
        url = os.getenv("DATABASE_URL")
        if not url:
            raise RuntimeError("DATABASE_URL environment variable is required")
        debug = os.getenv("DEBUG", "").lower() in ("1", "true", "yes")
        engine = create_async_engine(url, echo=debug)
        _factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return _factory


async def get_db():
    async with get_session_factory()() as session:
        yield session
