# Backend Flow

```mermaid
flowchart TD
client[Client] --> apiRoutes["APIRoutes (/health, /api/endpoints, /api/requests/*)"]
webhookSender[WebhookSender] --> hookRoute["HookRoute (/hooks/{endpoint_id})"]
browserWs[BrowserWebSocket] --> wsRoute["WebSocketRoute (/ws/endpoints/{endpoint_id})"]

subgraph appLayer [AppLayer]
apiRoutes --> endpointApi["endpoints.py"]
apiRoutes --> requestApi["requests.py"]
apiRoutes --> healthApi["health.py"]
hookRoute --> hookApi["hooks.py"]
wsRoute --> wsApi["websocket.py"]

endpointApi --> endpointService["EndpointService:create/list/delete endpoint"]
requestApi --> requestService["RequestService:get/list/delete request + list attempts"]
requestApi --> replayService["ReplayService:replay request + enqueue retry"]
hookApi --> captureService["CaptureService:validate/signature/store/publish"]
wsApi --> streamService["StreamService:authorize session + stream pubsub events"]

workerLoop["WorkerLoop:zpopmin -> due check -> process_retry_job -> sleep(1s)"] --> replayService
end

subgraph infraLayer [InfraLayer]
endpointService --> db[(Postgres)]
requestService --> db
captureService --> db
replayService --> db

captureService --> redisPub[(RedisPubSub)]
streamService --> redisPub
replayService --> redisQueue[(RedisRetryQueue)]
redisQueue --> workerLoop

replayService --> outboundHttp[OutboundHTTP]
outboundHttp --> target[ExternalTarget]
end
```

## Route to service mapping

- `GET /health` -> `health.py` (DB + Redis checks)
- `POST /api/endpoints`, `GET /api/endpoints`, `DELETE /api/endpoints/{id}` -> `EndpointService`
- `GET /api/endpoints/{id}/requests`, `GET /api/requests/{id}`, `DELETE /api/requests/{id}`, `GET /api/requests/{id}/attempts` -> `RequestService`
- `POST /api/requests/{id}/replay` -> `ReplayService`
- `GET|POST|PUT|PATCH|DELETE /hooks/{endpoint_id}` -> `CaptureService`
- `WS /ws/endpoints/{endpoint_id}` -> stream service logic in `websocket.py`
