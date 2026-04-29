import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import type { Endpoint, CapturedRequest, DeleteTarget } from "./types";
import { API, SESSION_ID, copyTextWithFeedback, fetchEndpointRequests, timeAgo } from "./utils";

interface Props {
  endpoint: Endpoint;
  hookUrl: string;
  selectedId: string | null;
  feedWidth: number;
  onSelect: (id: string) => void;
  onDeleteClick: (target: DeleteTarget) => void;
  onResizeStart: () => void;
  onError: (msg: string) => void;
}

export interface RequestFeedHandle {
  removeRequest: (id: string) => void;
}

const RequestFeed = forwardRef<RequestFeedHandle, Props>(function RequestFeed(
  { endpoint, hookUrl, selectedId, feedWidth, onSelect, onDeleteClick, onResizeStart, onError },
  ref,
) {
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [wsStatus, setWsStatus] = useState<"disconnected" | "connected" | "reconnecting">("disconnected");
  const [copied, setCopied] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(1000);

  useImperativeHandle(ref, () => ({
    removeRequest: (id: string) => setRequests(prev => prev.filter(r => r.id !== id)),
  }));

  const copyUrl = () => {
    copyTextWithFeedback(hookUrl, setCopied);
  };

  const connect = useCallback(function openConnection(endpointId: string) {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }

    const ws = new WebSocket(`${API.replace("http", "ws")}/ws/endpoints/${endpointId}?session_id=${SESSION_ID}`);
    wsRef.current = ws;

    ws.onopen = () => { setWsStatus("connected"); reconnectDelay.current = 1000; };
    ws.onmessage = (event) => {
      try { setRequests(prev => [JSON.parse(event.data), ...prev]); } catch { /* ignore */ }
    };
    ws.onerror = () => setWsStatus("reconnecting");
    ws.onclose = () => {
      setWsStatus("reconnecting");
      const delay = Math.min(reconnectDelay.current, 30000);
      reconnectTimer.current = setTimeout(() => {
        reconnectDelay.current = delay * 2;
        openConnection(endpointId);
      }, delay);
    };
  }, []);

  useEffect(() => {
    setRequests([]);
    setLoading(true);
    fetchEndpointRequests(endpoint.id)
      .then(setRequests)
      .catch(e => onError(`Failed to load requests: ${e.message}`))
      .finally(() => setLoading(false));

    connect(endpoint.id);

    return () => {
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
      setWsStatus("disconnected");
    };
  }, [endpoint.id, connect, onError]);

  return (
    <div className="feed" style={{ width: feedWidth }}>
      <div className="feed-meta">
        {requests.length} request{requests.length !== 1 ? "s" : ""} —{" "}
        <span className={wsStatus === "connected" ? "ws-live" : wsStatus === "reconnecting" ? "ws-reconnecting" : "ws-offline"}>
          ● {wsStatus === "connected" ? "live" : wsStatus === "reconnecting" ? "reconnecting" : "offline"}
        </span>
      </div>

      {loading ? (
        <div className="empty">Loading requests...</div>
      ) : requests.length === 0 ? (
        <div className="feed-empty-state">
          <div className="feed-empty-label">Waiting for requests...</div>
          <code className="feed-empty-url">{hookUrl}</code>
          <button className="feed-empty-copy" onClick={copyUrl}>{copied ? "✓ Copied" : "Copy URL"}</button>
          <pre className="feed-empty-curl">{`curl -X POST ${hookUrl} \\\n  -H "Content-Type: application/json" \\\n  -d '{"event": "test"}'`}</pre>
        </div>
      ) : (
        requests.map(r => (
          <div
            key={r.id}
            className={`req-row ${selectedId === r.id ? "active" : ""}`}
            onClick={() => onSelect(r.id)}
          >
            <span className={`method method-${r.method}`}>{r.method}</span>
            <span className="req-type">{r.content_type || "no content-type"}</span>
            <span className="req-time">{timeAgo(r.received_at)}</span>
            <span
              className="item-delete"
              onClick={e => { e.stopPropagation(); onDeleteClick({ type: "request", id: r.id }); }}
            >×</span>
          </div>
        ))
      )}

      <div className="feed-resize" onMouseDown={onResizeStart} />
    </div>
  );
});

export default RequestFeed;
