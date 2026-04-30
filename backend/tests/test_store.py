import pytest

from store import create_database_engine


def test_postgresql_url_is_coerced_to_asyncpg(monkeypatch):
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://u:p@ep-x.neon.tech/db?sslmode=require&channel_binding=require",
    )
    engine = create_database_engine()
    assert engine.url.drivername == "postgresql+asyncpg"
    assert "sslmode" not in engine.url.query
    assert "channel_binding" not in engine.url.query


def test_missing_database_url_raises(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        create_database_engine()
