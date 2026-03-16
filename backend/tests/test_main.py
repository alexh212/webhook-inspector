TEST_SESSION = "test-session-id-pytest-123456"
HEADERS = {"x-session-id": TEST_SESSION}

async def test_health(client):
    res = await client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}

async def test_create_endpoint(client):
    res = await client.post("/api/endpoints", json={"name": "Test"}, headers=HEADERS)
    assert res.status_code == 200
    data = res.json()
    assert "id" in data
    assert "url" in data

async def test_list_endpoints_empty_for_new_session(client):
    res = await client.get("/api/endpoints", headers={"x-session-id": "brand-new-session-xyz"})
    assert res.status_code == 200
    assert res.json() == []

async def test_capture_webhook(client):
    ep = await client.post("/api/endpoints", json={"name": "Capture Test"}, headers=HEADERS)
    ep_id = ep.json()["id"]
    res = await client.post(
        f"/hooks/{ep_id}",
        json={"event": "payment.succeeded", "amount": 9900},
        headers={"Content-Type": "application/json"}
    )
    assert res.status_code == 200
    assert res.json() == {"status": "received"}

async def test_captured_request_appears_in_list(client):
    ep = await client.post("/api/endpoints", json={"name": "List Test"}, headers=HEADERS)
    ep_id = ep.json()["id"]
    await client.post(f"/hooks/{ep_id}", json={"event": "test"})
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
