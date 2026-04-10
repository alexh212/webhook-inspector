import logging
import os

from dotenv import load_dotenv
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

load_dotenv()

logger = logging.getLogger("webhookinspector")

_engine = None
_AsyncSessionLocal = None


def _get_database_url() -> str:
    url = os.getenv("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL environment variable is required")
    return url


def get_engine():
    global _engine, _AsyncSessionLocal
    if _engine is None:
        debug = os.getenv("DEBUG", "").lower() in ("1", "true", "yes")
        _engine = create_async_engine(_get_database_url(), echo=debug)
        _AsyncSessionLocal = sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False)
    return _engine


def get_session_factory():
    get_engine()
    return _AsyncSessionLocal


async def get_db():
    factory = get_session_factory()
    async with factory() as session:
        yield session
