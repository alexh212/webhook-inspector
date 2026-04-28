import pytest

from database import create_database_engine


@pytest.fixture
def set_db_url(monkeypatch):
    def _set(url: str):
        monkeypatch.setenv("DATABASE_URL", url)
    return _set


def test_neon_url_strips_libpq_params_and_keeps_asyncpg(set_db_url):
    set_db_url("postgresql+asyncpg://u:p@ep-x.neon.tech/db?sslmode=require&channel_binding=require")
    engine = create_database_engine()
    assert engine.url.drivername == "postgresql+asyncpg"
    assert "sslmode" not in engine.url.query
    assert "channel_binding" not in engine.url.query


def test_plain_postgresql_scheme_is_coerced_to_asyncpg(set_db_url):
    set_db_url("postgresql://u:p@ep-x.neon.tech/db?sslmode=require")
    engine = create_database_engine()
    assert engine.url.drivername == "postgresql+asyncpg"


def test_psycopg2_scheme_is_coerced_to_asyncpg(set_db_url):
    set_db_url("postgresql+psycopg2://u:p@ep-x.neon.tech/db")
    engine = create_database_engine()
    assert engine.url.drivername == "postgresql+asyncpg"


def test_missing_database_url_raises(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        create_database_engine()
