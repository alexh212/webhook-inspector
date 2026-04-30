import hmac
import hashlib
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from database import get_db
from main import app
from retry import sanitize_headers

TEST_SESSION = "test-session-id-pytest-123456"
HEADERS = {"x-session-id": TEST_SESSION}


async def test_health(client):
    res = await client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert data["db"] == "ok"
    assert data["redis"] == "ok"


async def test_health_db_failure_returns_503(client):
    class FailingDB:
        async def execute(self, *_args, **_kwargs):
            raise RuntimeError("db unavailable")

    async def override_get_db_failure():
        yield FailingDB()

    original_override = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = override_get_db_failure
    try:
        res = await client.get("/health")
    finally:
        if original_override is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = original_override

    assert res.status_code == 503
    assert res.json()["detail"]["db"] == "error"
    assert res.json()["detail"]["redis"] == "ok"


async def test_health_redis_failure_returns_503(client):
    with patch("app.runtime.redis_client.ping", AsyncMock(side_effect=RuntimeError("redis unavailable"))):
        res = await client.get("/health")

    assert res.status_code == 503
    assert res.json()["detail"]["db"] == "ok"
    assert res.json()["detail"]["redis"] == "error"


async def test_security_headers(client):
    res = await client.get("/health")
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["x-frame-options"] == "DENY"
    assert "strict-origin" in res.headers["referrer-policy"]


async def test_create_endpoint(client):
    res = await client.post("/api/endpoints", json={"name": "Test"}, headers=HEADERS)
    assert res.status_code == 200
    data = res.json()
    assert "id" in data
    assert "url" in data
    assert "secret" in data


async def test_list_endpoints_empty_for_new_session(client):
    res = await client.get("/api/endpoints", headers={"x-session-id": "brand-new-session-xyz"})
    assert res.status_code == 200
    assert res.json() == []


async def test_capture_webhook(client):
    ep = await client.post("/api/endpoints", json={"name": "Capture Test"}, headers=HEADERS)
    ep_data = ep.json()
    ep_id = ep_data["id"]
    secret = ep_data["secret"]

    body = b'{"event": "payment.succeeded", "amount": 9900}'
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

    res = await client.post(
        f"/hooks/{ep_id}",
        content=body,
        headers={"Content-Type": "application/json", "x-webhook-signature": sig}
    )
    assert res.status_code == 200
    assert res.json() == {"status": "received"}


async def test_capture_webhook_publish_failure_still_returns_200(client):
    ep = await client.post("/api/endpoints", json={"name": "Publish Failure Test"}, headers=HEADERS)
    ep_data = ep.json()
    ep_id = ep_data["id"]
    secret = ep_data["secret"]

    body = b'{"event": "payment.succeeded", "amount": 9900}'
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

    with patch("app.runtime.redis_client.publish", AsyncMock(side_effect=RuntimeError("redis publish failed"))):
        res = await client.post(
            f"/hooks/{ep_id}",
            content=body,
            headers={"Content-Type": "application/json", "x-webhook-signature": sig},
        )

    assert res.status_code == 200
    assert res.json() == {"status": "received"}


async def test_capture_webhook_missing_signature_rejected(client):
    ep = await client.post("/api/endpoints", json={"name": "HMAC Test"}, headers=HEADERS)
    ep_id = ep.json()["id"]

    res = await client.post(
        f"/hooks/{ep_id}",
        json={"event": "test"},
        headers={"Content-Type": "application/json"}
    )
    assert res.status_code == 401
    assert "Missing" in res.json()["detail"] or "signature" in res.json()["detail"].lower()


async def test_capture_webhook_invalid_signature_rejected(client):
    ep = await client.post("/api/endpoints", json={"name": "Bad Sig Test"}, headers=HEADERS)
    ep_id = ep.json()["id"]

    res = await client.post(
        f"/hooks/{ep_id}",
        json={"event": "test"},
        headers={"Content-Type": "application/json", "x-webhook-signature": "deadbeef"}
    )
    assert res.status_code == 401


async def test_captured_request_appears_in_list(client):
    ep = await client.post("/api/endpoints", json={"name": "List Test"}, headers=HEADERS)
    ep_data = ep.json()
    ep_id = ep_data["id"]
    secret = ep_data["secret"]

    body = b'{"event": "test"}'
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    await client.post(f"/hooks/{ep_id}", content=body, headers={"x-webhook-signature": sig})

    res = await client.get(f"/api/endpoints/{ep_id}/requests", headers=HEADERS)
    assert res.status_code == 200
    requests = res.json()
    assert len(requests) >= 1
    assert requests[0]["method"] == "POST"


async def test_session_isolation(client):
    ep = await client.post("/api/endpoints", json={"name": "Session Test"}, headers=HEADERS)
    ep_id = ep.json()["id"]
    res = await client.get(f"/api/endpoints/{ep_id}/requests", headers={"x-session-id": "completely-different-session-abc"})
    assert res.status_code == 404


async def test_delete_endpoint(client):
    ep = await client.post("/api/endpoints", json={"name": "Delete Test"}, headers=HEADERS)
    ep_id = ep.json()["id"]
    res = await client.delete(f"/api/endpoints/{ep_id}", headers=HEADERS)
    assert res.status_code == 200
    assert res.json() == {"status": "deleted"}


async def test_missing_session_id_returns_401(client):
    res = await client.get("/api/endpoints")
    assert res.status_code == 401


def test_websocket_invalid_uuid_rejected():
    with TestClient(app) as sync_client:
        with pytest.raises(WebSocketDisconnect):
            with sync_client.websocket_connect("/ws/endpoints/not-a-uuid?session_id=test-session-id-pytest-123456"):
                pass


async def test_capture_webhook_invalid_endpoint(client):
    res = await client.post("/hooks/00000000-0000-0000-0000-000000000000", json={"event": "test"})
    assert res.status_code == 404


async def test_invalid_uuid_returns_400(client):
    res = await client.get("/api/endpoints/not-a-uuid/requests", headers=HEADERS)
    assert res.status_code == 400


async def test_replay_ssrf_blocked(client):
    ep = await client.post("/api/endpoints", json={"name": "SSRF Test"}, headers=HEADERS)
    ep_data = ep.json()
    ep_id = ep_data["id"]
    secret = ep_data["secret"]

    body = b'{"event": "ssrf-test"}'
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    await client.post(f"/hooks/{ep_id}", content=body, headers={"x-webhook-signature": sig})

    reqs = await client.get(f"/api/endpoints/{ep_id}/requests", headers=HEADERS)
    req_id = reqs.json()[0]["id"]

    for blocked_url in [
        "http://127.0.0.1:8080/evil",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.1/internal",
    ]:
        res = await client.post(
            f"/api/requests/{req_id}/replay",
            json={"destination_url": blocked_url},
            headers=HEADERS,
        )
        assert res.status_code == 400, f"Expected 400 for {blocked_url}, got {res.status_code}"


async def test_replay_invalid_url_rejected(client):
    ep = await client.post("/api/endpoints", json={"name": "URL Test"}, headers=HEADERS)
    ep_data = ep.json()
    ep_id = ep_data["id"]
    secret = ep_data["secret"]

    body = b'{"event": "url-test"}'
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    await client.post(f"/hooks/{ep_id}", content=body, headers={"x-webhook-signature": sig})

    reqs = await client.get(f"/api/endpoints/{ep_id}/requests", headers=HEADERS)
    req_id = reqs.json()[0]["id"]

    res = await client.post(
        f"/api/requests/{req_id}/replay",
        json={"destination_url": "ftp://evil.com/file"},
        headers=HEADERS,
    )
    assert res.status_code == 400


async def test_endpoint_name_max_length(client):
    long_name = "a" * 300
    res = await client.post("/api/endpoints", json={"name": long_name}, headers=HEADERS)
    assert res.status_code == 422


async def test_body_too_large_rejected(client):
    ep = await client.post("/api/endpoints", json={"name": "Size Test"}, headers=HEADERS)
    ep_data = ep.json()
    ep_id = ep_data["id"]
    secret = ep_data["secret"]

    large_body = b"x" * (1024 * 1024 + 1)
    sig = hmac.new(secret.encode(), large_body, hashlib.sha256).hexdigest()
    res = await client.post(
        f"/hooks/{ep_id}",
        content=large_body,
        headers={"x-webhook-signature": sig, "content-length": str(len(large_body))},
    )
    assert res.status_code == 413


async def test_pagination(client):
    for i in range(3):
        await client.post("/api/endpoints", json={"name": f"Page {i}"}, headers=HEADERS)

    res = await client.get("/api/endpoints?limit=2&offset=0", headers=HEADERS)
    assert res.status_code == 200
    assert len(res.json()) <= 2


async def _capture(client, name: str) -> tuple[str, str]:
    """Create an endpoint, fire one signed request, return (ep_id, req_id)."""
    ep = await client.post("/api/endpoints", json={"name": name}, headers=HEADERS)
    ep_data = ep.json()
    ep_id, secret = ep_data["id"], ep_data["secret"]
    body = b'{"event": "test"}'
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    await client.post(f"/hooks/{ep_id}", content=body, headers={"x-webhook-signature": sig})
    reqs = await client.get(f"/api/endpoints/{ep_id}/requests", headers=HEADERS)
    return ep_id, reqs.json()[0]["id"]


async def test_get_request_detail(client):
    _, req_id = await _capture(client, "Detail Test")
    res = await client.get(f"/api/requests/{req_id}", headers=HEADERS)
    assert res.status_code == 200
    data = res.json()
    assert data["id"] == req_id
    assert data["method"] == "POST"
    assert "headers" in data
    assert "body" in data
    assert "query_params" in data


async def test_get_request_detail_forbidden(client):
    _, req_id = await _capture(client, "Forbidden Detail Test")
    res = await client.get(f"/api/requests/{req_id}", headers={"x-session-id": "different-session-xyz"})
    assert res.status_code == 403


async def test_delete_request(client):
    _, req_id = await _capture(client, "Delete Request Test")
    res = await client.delete(f"/api/requests/{req_id}", headers=HEADERS)
    assert res.status_code == 200
    assert res.json() == {"status": "deleted"}
    res = await client.get(f"/api/requests/{req_id}", headers=HEADERS)
    assert res.status_code == 404


async def test_delete_request_forbidden(client):
    _, req_id = await _capture(client, "Delete Forbidden Test")
    res = await client.delete(f"/api/requests/{req_id}", headers={"x-session-id": "different-session-xyz"})
    assert res.status_code == 403


def _mock_httpx_client(status_code: int = 200, body: str = "ok"):
    mock_response = MagicMock()
    mock_response.status_code = status_code
    mock_response.headers = {}
    mock_response.text = body
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.request = AsyncMock(return_value=mock_response)
    return mock_client


async def test_replay_success(client):
    _, req_id = await _capture(client, "Replay Success Test")
    with patch("app.outbound.replay_http.httpx.AsyncClient", return_value=_mock_httpx_client(200, '{"ok": true}')):
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


async def test_replay_http_500_enqueues_retry(client):
    _, req_id = await _capture(client, "Replay Retry 500 Test")
    with (
        patch("app.outbound.replay_http.httpx.AsyncClient", return_value=_mock_httpx_client(500, "upstream failure")),
        patch("app.services.replay.enqueue_retry", AsyncMock()) as enqueue_retry_mock,
    ):
        res = await client.post(
            f"/api/requests/{req_id}/replay",
            json={"destination_url": "https://httpbin.org/anything"},
            headers=HEADERS,
        )

    assert res.status_code == 200
    assert res.json()["status_code"] == "500"
    enqueue_retry_mock.assert_awaited_once()


def _mock_httpx_client_error(exc: Exception):
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.request = AsyncMock(side_effect=exc)
    return mock_client


async def test_replay_timeout_enqueues_retry_and_sets_error(client):
    _, req_id = await _capture(client, "Replay Timeout Test")
    with (
        patch("app.outbound.replay_http.httpx.AsyncClient", return_value=_mock_httpx_client_error(httpx.ReadTimeout("timed out"))),
        patch("app.services.replay.enqueue_retry", AsyncMock()) as enqueue_retry_mock,
    ):
        res = await client.post(
            f"/api/requests/{req_id}/replay",
            json={"destination_url": "https://httpbin.org/anything"},
            headers=HEADERS,
        )

    assert res.status_code == 200
    assert "Replay request failed" in res.json()["error"]
    enqueue_retry_mock.assert_awaited_once()


async def test_list_attempts_after_replay(client):
    _, req_id = await _capture(client, "Attempts Test")
    with patch("app.outbound.replay_http.httpx.AsyncClient", return_value=_mock_httpx_client(200)):
        await client.post(
            f"/api/requests/{req_id}/replay",
            json={"destination_url": "https://httpbin.org/anything"},
            headers=HEADERS,
        )
    res = await client.get(f"/api/requests/{req_id}/attempts", headers=HEADERS)
    assert res.status_code == 200
    attempts = res.json()
    assert len(attempts) == 1
    assert attempts[0]["destination_url"] == "https://httpbin.org/anything"
    assert attempts[0]["status_code"] == "200"


def test_sanitize_headers_removes_hop_by_hop():
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer token",
        "host": "example.com",
        "connection": "keep-alive",
        "content-length": "42",
        "transfer-encoding": "chunked",
        "x-custom": "value",
    }
    result = sanitize_headers(headers)
    assert result == {"Content-Type": "application/json", "Authorization": "Bearer token", "x-custom": "value"}


def test_sanitize_headers_case_insensitive():
    headers = {"Host": "example.com", "CONNECTION": "keep-alive", "Content-Type": "application/json"}
    result = sanitize_headers(headers)
    assert result == {"Content-Type": "application/json"}
