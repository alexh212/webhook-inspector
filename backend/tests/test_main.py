import hmac
import hashlib

TEST_SESSION = "test-session-id-pytest-123456"
HEADERS = {"x-session-id": TEST_SESSION}


async def test_health(client):
    res = await client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert data["db"] == "ok"
    assert data["redis"] == "ok"


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


async def test_capture_webhook_missing_signature_rejected(client):
    """When endpoint has a secret, unsigned requests must be rejected."""
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
    """An incorrect signature must be rejected."""
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


async def test_capture_webhook_invalid_endpoint(client):
    res = await client.post("/hooks/00000000-0000-0000-0000-000000000000", json={"event": "test"})
    assert res.status_code == 404


async def test_invalid_uuid_returns_400(client):
    res = await client.get("/api/endpoints/not-a-uuid/requests", headers=HEADERS)
    assert res.status_code == 400


async def test_replay_ssrf_blocked(client):
    """Replay to private IP ranges must be rejected."""
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
    """Replay with non-http URLs must be rejected."""
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
    """Endpoint name exceeding 255 chars should be rejected."""
    long_name = "a" * 300
    res = await client.post("/api/endpoints", json={"name": long_name}, headers=HEADERS)
    assert res.status_code == 422


async def test_body_too_large_rejected(client):
    """Webhook body exceeding 1MB should be rejected."""
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
    """List endpoints respects limit and offset."""
    for i in range(3):
        await client.post("/api/endpoints", json={"name": f"Page {i}"}, headers=HEADERS)

    res = await client.get("/api/endpoints?limit=2&offset=0", headers=HEADERS)
    assert res.status_code == 200
    assert len(res.json()) <= 2
