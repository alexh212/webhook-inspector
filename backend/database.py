import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from dotenv import load_dotenv

load_dotenv()

_engine = None
_AsyncSessionLocal = None

def get_engine():
    global _engine, _AsyncSessionLocal
    if _engine is None:
        _engine = create_async_engine(os.getenv("DATABASE_URL"), echo=True)
        _AsyncSessionLocal = sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False)
    return _engine

def get_session_factory():
    get_engine()
    return _AsyncSessionLocal

AsyncSessionLocal = None  # will be set on first use

async def get_db():
    factory = get_session_factory()
    async with factory() as session:
        yield session
