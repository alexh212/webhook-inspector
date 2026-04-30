from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import app as app_module
from security import sanitize_headers, validate_destination_url

TEST_SESSION = "test-session-id-pytest-123456"
HEADERS = {"x-session-id": TEST_SESSION}


# ----- helpers -----


def _mock_httpx_client(status_code: int = 200, body: str = "ok"):
    response = MagicMock()
    response.status_code = status_code
    response.headers = {}
    response.text = body
    client = AsyncMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)
    client.request = AsyncMock(return_value=response)
    return client


def _mock_httpx_client_error(exc: Exception):
    client = AsyncMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)
    client.request = AsyncMock(side_effect=exc)
    return client


async def _capture(client, name: str) -> tuple[str, str]:
    ep = await client.post("/api/endpoints", json={"name": name}, headers=HEADERS)
    data = ep.json()
    body = b'{"event": "test"}'
    await client.post(f"/hooks/{data['id']}", content=body)
    reqs = await client.get(f"/api/endpoints/{data['id']}/requests", headers=HEADERS)
    return data["id"], reqs.json()[0]["id"]


# ----- health -----


async def test_health_ok(client):
    res = await client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "db": "ok", "redis": "ok"}


async def test_health_db_failure_returns_503(client):
    class FailingDB:
        async def execute(self, *_args, **_kwargs):
            raise RuntimeError("db unavailable")

    async def override():
        yield FailingDB()

    original = app_module.app.dependency_overrides.get(app_module.store.get_db)
    app_module.app.dependency_overrides[app_module.store.get_db] = override
    try:
        res = await client.get("/health")
    finally:
        if original is None:
            app_module.app.dependency_overrides.pop(app_module.store.get_db, None)
        else:
            app_module.app.dependency_overrides[app_module.store.get_db] = original

    assert res.status_code == 503
    assert res.json()["detail"]["db"] == "error"


async def test_security_headers_present(client):
    res = await client.get("/health")
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["x-frame-options"] == "DENY"


# ----- endpoints CRUD -----


async def test_create_endpoint(client):
    res = await client.post("/api/endpoints", json={"name": "Test"}, headers=HEADERS)
    assert res.status_code == 200
    data = res.json()
    assert {"id", "url", "secret"} <= data.keys()
    assert data["secret"] is None


async def test_list_endpoints_session_isolation(client):
    res = await client.get("/api/endpoints", headers={"x-session-id": "brand-new-session-xyz"})
    assert res.status_code == 200
    assert res.json() == []


async def test_delete_endpoint(client):
    ep = await client.post("/api/endpoints", json={"name": "Delete Test"}, headers=HEADERS)
    res = await client.delete(f"/api/endpoints/{ep.json()['id']}", headers=HEADERS)
    assert res.status_code == 200
    assert res.json() == {"status": "deleted"}


# ----- session security -----


async def test_missing_session_id_returns_401(client):
    res = await client.get("/api/endpoints")
    assert res.status_code == 401


async def test_request_forbidden_for_other_session(client):
    _, req_id = await _capture(client, "Forbidden Test")
    res = await client.get(f"/api/requests/{req_id}", headers={"x-session-id": "different-session-xyz"})
    assert res.status_code == 403


# ----- capture -----


async def test_capture_webhook_happy(client):
    ep = await client.post("/api/endpoints", json={"name": "Capture"}, headers=HEADERS)
    data = ep.json()
    res = await client.post(
        f"/hooks/{data['id']}",
        content=b'{"event": "payment.succeeded"}',
        headers={"Content-Type": "application/json"},
    )
    assert res.status_code == 200
    assert res.json() == {"status": "received"}


async def test_capture_webhook_missing_signature_rejected(client):
    ep = await client.post(
        "/api/endpoints",
        json={"name": "HMAC", "require_signature": True},
        headers=HEADERS,
    )
    assert ep.json()["secret"] is not None
    res = await client.post(f"/hooks/{ep.json()['id']}", json={"event": "test"})
    assert res.status_code == 401


async def test_capture_webhook_body_too_large(client):
    ep = await client.post("/api/endpoints", json={"name": "Size"}, headers=HEADERS)
    data = ep.json()
    res = await client.post(
        f"/hooks/{data['id']}",
        content=b"x" * (1024 * 1024 + 1),
        headers={"content-length": str(1024 * 1024 + 1)},
    )
    assert res.status_code == 413


# ----- replay (API path, shares flows._execute_replay with worker) -----


async def test_replay_success(client):
    _, req_id = await _capture(client, "Replay Success")
    with patch("flows.httpx.AsyncClient", return_value=_mock_httpx_client(200, '{"ok": true}')):
        res = await client.post(
            f"/api/requests/{req_id}/replay",
            json={"destination_url": "https://httpbin.org/anything"},
            headers=HEADERS,
        )
    assert res.status_code == 200
    data = res.json()
    assert data["status_code"] == "200"
    assert data["error"] is None
    assert data["duration_ms"] is not None


async def test_replay_ssrf_blocked(client):
    _, req_id = await _capture(client, "SSRF")
    res = await client.post(
        f"/api/requests/{req_id}/replay",
        json={"destination_url": "http://127.0.0.1:8080/evil"},
        headers=HEADERS,
    )
    assert res.status_code == 400


async def test_replay_http_500_enqueues_retry(client):
    _, req_id = await _capture(client, "Replay 500")
    with (
        patch("flows.httpx.AsyncClient", return_value=_mock_httpx_client(500, "boom")),
        patch("flows.enqueue_retry", AsyncMock()) as enqueue_mock,
    ):
        res = await client.post(
            f"/api/requests/{req_id}/replay",
            json={"destination_url": "https://httpbin.org/anything"},
            headers=HEADERS,
        )
    assert res.status_code == 200
    assert res.json()["status_code"] == "500"
    enqueue_mock.assert_awaited_once()


async def test_replay_timeout_error_enqueues_retry(client):
    _, req_id = await _capture(client, "Replay Timeout")
    with (
        patch("flows.httpx.AsyncClient", return_value=_mock_httpx_client_error(httpx.ReadTimeout("timed out"))),
        patch("flows.enqueue_retry", AsyncMock()) as enqueue_mock,
    ):
        res = await client.post(
            f"/api/requests/{req_id}/replay",
            json={"destination_url": "https://httpbin.org/anything"},
            headers=HEADERS,
        )
    assert res.status_code == 200
    assert "Replay request failed" in res.json()["error"]
    enqueue_mock.assert_awaited_once()


async def test_list_attempts_after_replay(client):
    _, req_id = await _capture(client, "Attempts")
    with patch("flows.httpx.AsyncClient", return_value=_mock_httpx_client(200)):
        await client.post(
            f"/api/requests/{req_id}/replay",
            json={"destination_url": "https://httpbin.org/anything"},
            headers=HEADERS,
        )
    res = await client.get(f"/api/requests/{req_id}/attempts", headers=HEADERS)
    assert res.status_code == 200
    attempts = res.json()
    assert len(attempts) == 1
    assert attempts[0]["status_code"] == "200"


# ----- websocket auth -----


def test_websocket_invalid_uuid_rejected():
    with TestClient(app_module.app) as sync_client:
        with pytest.raises(WebSocketDisconnect):
            with sync_client.websocket_connect(
                "/ws/endpoints/not-a-uuid?session_id=" + TEST_SESSION
            ):
                pass


# ----- security units -----


def test_sanitize_headers_strips_hop_by_hop():
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer token",
        "host": "example.com",
        "connection": "keep-alive",
        "content-length": "42",
        "transfer-encoding": "chunked",
        "x-custom": "value",
    }
    assert sanitize_headers(headers) == {
        "Content-Type": "application/json",
        "Authorization": "Bearer token",
        "x-custom": "value",
    }


def test_validate_destination_url_blocks_private():
    with pytest.raises(ValueError):
        validate_destination_url("http://127.0.0.1/evil")
