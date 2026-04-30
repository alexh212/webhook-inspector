import json
import uuid
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services import replay


class _FakeSession:
    def __init__(self, captured_request):
        self.captured_request = captured_request
        self.add = MagicMock()
        self.commit = AsyncMock()
        self.refresh = AsyncMock()
        self.get = AsyncMock(return_value=captured_request)


def _session_factory(fake_session):
    @asynccontextmanager
    async def _ctx():
        yield fake_session

    return lambda: _ctx()


@pytest.mark.asyncio
async def test_process_job_skips_blocked_destination(monkeypatch):
    request_id = str(uuid.uuid4())
    job = json.dumps({"request_id": request_id, "destination_url": "http://127.0.0.1", "attempt_number": 1})

    session_local = AsyncMock()

    def _raise_blocked(_url):
        raise ValueError("blocked")

    monkeypatch.setattr(replay, "validate_destination_url", _raise_blocked)

    await replay.process_retry_job(job, session_local, AsyncMock(), MagicMock())

    session_local.assert_not_called()


@pytest.mark.asyncio
async def test_process_job_ignores_missing_request(monkeypatch):
    request_id = str(uuid.uuid4())
    job = json.dumps({"request_id": request_id, "destination_url": "https://example.com", "attempt_number": 1})

    fake_session = _FakeSession(None)
    enqueue_retry_mock = AsyncMock()
    monkeypatch.setattr(replay, "validate_destination_url", lambda _url: None)
    monkeypatch.setattr(replay, "enqueue_retry", enqueue_retry_mock)

    await replay.process_retry_job(job, _session_factory(fake_session), AsyncMock(), MagicMock())

    enqueue_retry_mock.assert_not_called()
    fake_session.commit.assert_not_called()


@pytest.mark.asyncio
async def test_process_job_success_does_not_enqueue_retry(monkeypatch):
    captured_request = SimpleNamespace(id=uuid.uuid4(), method="POST", headers={}, body='{"ok":true}')
    job = json.dumps(
        {"request_id": str(captured_request.id), "destination_url": "https://example.com", "attempt_number": 2}
    )

    fake_session = _FakeSession(captured_request)
    enqueue_retry_mock = AsyncMock()
    monkeypatch.setattr(replay, "validate_destination_url", lambda _url: None)
    monkeypatch.setattr(
        replay,
        "do_replay",
        AsyncMock(
            return_value={
                "status_code": "200",
                "response_headers": {},
                "response_body": "ok",
                "duration_ms": "5",
                "error": None,
            }
        ),
    )
    monkeypatch.setattr(replay, "enqueue_retry", enqueue_retry_mock)

    await replay.process_retry_job(job, _session_factory(fake_session), AsyncMock(), MagicMock())

    enqueue_retry_mock.assert_not_called()
    fake_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_process_job_5xx_enqueues_retry(monkeypatch):
    captured_request = SimpleNamespace(id=uuid.uuid4(), method="POST", headers={}, body='{"ok":true}')
    job = json.dumps(
        {"request_id": str(captured_request.id), "destination_url": "https://example.com", "attempt_number": 2}
    )

    fake_session = _FakeSession(captured_request)
    redis_client = AsyncMock()
    enqueue_retry_mock = AsyncMock()
    monkeypatch.setattr(replay, "validate_destination_url", lambda _url: None)
    monkeypatch.setattr(
        replay,
        "do_replay",
        AsyncMock(
            return_value={
                "status_code": "502",
                "response_headers": {},
                "response_body": "bad gateway",
                "duration_ms": "7",
                "error": None,
            }
        ),
    )
    monkeypatch.setattr(replay, "enqueue_retry", enqueue_retry_mock)

    await replay.process_retry_job(job, _session_factory(fake_session), redis_client, MagicMock())

    enqueue_retry_mock.assert_awaited_once_with(redis_client, str(captured_request.id), "https://example.com", 3)
    fake_session.commit.assert_awaited_once()
