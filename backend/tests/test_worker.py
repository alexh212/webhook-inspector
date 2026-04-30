import json
import uuid
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

import flows


class _FakeSession:
    def __init__(self, captured):
        self.add = MagicMock()
        self.commit = AsyncMock()
        self.refresh = AsyncMock()
        self.get = AsyncMock(return_value=captured)


def _session_factory(fake_session):
    @asynccontextmanager
    async def _ctx():
        yield fake_session

    return lambda: _ctx()


@pytest.mark.asyncio
async def test_process_job_success_does_not_enqueue(monkeypatch):
    captured = SimpleNamespace(id=uuid.uuid4(), method="POST", headers={}, body='{"ok":true}')
    job = json.dumps(
        {"request_id": str(captured.id), "destination_url": "https://example.com", "attempt_number": 2}
    )
    fake = _FakeSession(captured)
    enqueue_mock = AsyncMock()
    monkeypatch.setattr(flows, "validate_destination_url", lambda _u: None)
    monkeypatch.setattr(
        flows,
        "do_replay",
        AsyncMock(return_value={"status_code": "200", "response_headers": {}, "response_body": "ok", "duration_ms": "5", "error": None}),
    )
    monkeypatch.setattr(flows, "enqueue_retry", enqueue_mock)
    monkeypatch.setattr(flows.store, "add_delivery_attempt", AsyncMock(return_value=SimpleNamespace(id=uuid.uuid4(), status_code="200")))

    await flows.process_retry_job(job, _session_factory(fake), AsyncMock(), MagicMock())

    enqueue_mock.assert_not_called()


@pytest.mark.asyncio
async def test_process_job_5xx_enqueues_next_attempt(monkeypatch):
    captured = SimpleNamespace(id=uuid.uuid4(), method="POST", headers={}, body='{"ok":true}')
    job = json.dumps(
        {"request_id": str(captured.id), "destination_url": "https://example.com", "attempt_number": 2}
    )
    fake = _FakeSession(captured)
    redis_client = AsyncMock()
    enqueue_mock = AsyncMock()
    monkeypatch.setattr(flows, "validate_destination_url", lambda _u: None)
    monkeypatch.setattr(
        flows,
        "do_replay",
        AsyncMock(return_value={"status_code": "502", "response_headers": {}, "response_body": "bad", "duration_ms": "7", "error": None}),
    )
    monkeypatch.setattr(flows, "enqueue_retry", enqueue_mock)
    monkeypatch.setattr(flows.store, "add_delivery_attempt", AsyncMock(return_value=SimpleNamespace(id=uuid.uuid4(), status_code="502")))

    logger = MagicMock()
    await flows.process_retry_job(job, _session_factory(fake), redis_client, logger)

    enqueue_mock.assert_awaited_once_with(redis_client, str(captured.id), "https://example.com", 3, logger)


@pytest.mark.asyncio
async def test_process_job_blocked_destination_skipped(monkeypatch):
    request_id = str(uuid.uuid4())
    job = json.dumps({"request_id": request_id, "destination_url": "http://127.0.0.1", "attempt_number": 1})
    session_factory = AsyncMock()

    def _blocked(_u):
        raise ValueError("blocked")

    monkeypatch.setattr(flows, "validate_destination_url", _blocked)

    await flows.process_retry_job(job, session_factory, AsyncMock(), MagicMock())

    session_factory.assert_not_called()
