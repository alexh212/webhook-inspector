import os

from dotenv import load_dotenv
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

load_dotenv()

_factory = None


def create_database_engine(echo: bool | None = None, poolclass=None):
    """Neon/Render copy-paste URLs use libpq query params (sslmode, channel_binding) that must not be forwarded to asyncpg."""
    url = os.getenv("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL environment variable is required")
    if echo is None:
        echo = os.getenv("DEBUG", "").lower() in ("1", "true", "yes")
    u = make_url(url)
    if u.drivername in ("postgres", "postgresql", "postgresql+psycopg2", "postgresql+psycopg"):
        u = u.set(drivername="postgresql+asyncpg")
    q = dict(u.query.items()) if u.query else {}
    sslmode = q.pop("sslmode", None)
    q.pop("channel_binding", None)
    ssl_val = q.pop("ssl", None)
    use_ssl = (
        sslmode == "require"
        or str(ssl_val or "").lower() in ("true", "require", "1")
        or (u.host is not None and "neon.tech" in u.host)
    )
    u = u.set(query=q)
    kwargs = {"echo": echo}
    if poolclass is not None:
        kwargs["poolclass"] = poolclass
    if use_ssl:
        kwargs["connect_args"] = {"ssl": True}
    return create_async_engine(u, **kwargs)


def get_session_factory():
    # Lazy init so test fixtures can override get_db before the engine is created.
    global _factory
    if _factory is None:
        engine = create_database_engine()
        _factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return _factory


async def get_db():
    async with get_session_factory()() as session:
        yield session
