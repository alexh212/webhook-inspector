import os

from dotenv import load_dotenv
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

load_dotenv()

_factory = None


def create_database_engine(echo: bool | None = None, poolclass=None):
    url = os.getenv("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL environment variable is required")
    if echo is None:
        echo = os.getenv("DEBUG", "").lower() in ("1", "true", "yes")
    url_obj = make_url(url)
    if url_obj.drivername in ("postgres", "postgresql", "postgresql+psycopg2", "postgresql+psycopg"):
        url_obj = url_obj.set(drivername="postgresql+asyncpg")
    query = dict(url_obj.query.items()) if url_obj.query else {}
    sslmode = query.pop("sslmode", None)
    query.pop("channel_binding", None)
    ssl_value = query.pop("ssl", None)
    use_ssl = (
        sslmode == "require"
        or str(ssl_value or "").lower() in ("true", "require", "1")
        or (url_obj.host is not None and "neon.tech" in url_obj.host)
    )
    url_obj = url_obj.set(query=query)
    kwargs = {"echo": echo}
    if poolclass is not None:
        kwargs["poolclass"] = poolclass
    if use_ssl:
        kwargs["connect_args"] = {"ssl": True}
    return create_async_engine(url_obj, **kwargs)


def get_session_factory():
    global _factory
    if _factory is None:
        engine = create_database_engine()
        _factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return _factory


async def get_db():
    async with get_session_factory()() as session:
        yield session
