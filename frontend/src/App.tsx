import { useState, useEffect, useRef, useCallback } from "react";

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

function getSessionId(): string {
  let id = localStorage.getItem("wi_session_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("wi_session_id", id);
  }
  return id;
}

const SESSION_ID = getSessionId();

const apiFetch = (url: string, options: RequestInit = {}) =>
  fetch(`${API}${url}`, {
    ...options,
    headers: { ...options.headers as Record<string, string>, "x-session-id": SESSION_ID },
  });

type Endpoint = { id: string; name: string; created_at: string };
type CapturedRequest = { id: string; method: string; content_type: string; source_ip: string; received_at: string };
type RequestDetail = {
  id: string; method: string; headers: Record<string, string>;
  body: string; query_params: Record<string, string>;
  source_ip: string; content_type: string; received_at: string;
};
type ReplayResult = { status_code: string; response_body: string; duration_ms: string; error: string | null };
type DeliveryAttempt = { id: string; destination_url: string; status_code: string | null; duration_ms: string | null; error: string | null; attempted_at: string };

function timeAgo(date: string) {
  const seconds = Math.floor((Date.now() - new Date(date + "Z").getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

const METHOD_COLOR: Record<string, string> = {
  GET: "#4ade80", POST: "#60a5fa", PUT: "#fb923c", DELETE: "#f87171", PATCH: "#c084fc"
};

function tryFormatJson(str: string) {
  try { return JSON.stringify(JSON.parse(str), null, 2); }
  catch { return str; }
}

export default function App({ onBack }: { onBack: () => void }) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [selected, setSelected] = useState<Endpoint | null>(null);
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [newName, setNewName] = useState("");
  const [copied, setCopied] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);
  const [replayUrl, setReplayUrl] = useState("http://localhost:9000");
  const [replayBody, setReplayBody] = useState<string | null>(null);
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [attempts, setAttempts] = useState<DeliveryAttempt[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [feedWidth, setFeedWidth] = useState(380);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const isResizingSidebar = useRef(false);
  const isResizingFeed = useRef(false);

  const onMouseMoveSidebar = useCallback((e: MouseEvent) => {
    if (!isResizingSidebar.current) return;
    setSidebarWidth(Math.min(Math.max(e.clientX, 160), 400));
  }, []);

  const onMouseMoveFeed = useCallback((e: MouseEvent) => {
    if (!isResizingFeed.current) return;
    setFeedWidth(Math.min(Math.max(e.clientX - sidebarWidth, 200), 600));
  }, [sidebarWidth]);

  const stopResize = useCallback(() => {
    isResizingSidebar.current = false;
    isResizingFeed.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  useEffect(() => {
    window.addEventListener("mousemove", onMouseMoveSidebar);
    window.addEventListener("mousemove", onMouseMoveFeed);
    window.addEventListener("mouseup", stopResize);
    return () => {
      window.removeEventListener("mousemove", onMouseMoveSidebar);
      window.removeEventListener("mousemove", onMouseMoveFeed);
      window.removeEventListener("mouseup", stopResize);
    };
  }, [onMouseMoveSidebar, onMouseMoveFeed, stopResize]);

  useEffect(() => {
    apiFetch("/api/endpoints").then(r => r.json()).then(setEndpoints);
  }, []);

  useEffect(() => {
    if (!selected) return;
    setDetail(null);
    setRequests([]);
    setAttempts([]);
    apiFetch(`/api/endpoints/${selected.id}/requests`).then(r => r.json()).then(setRequests);
    const ws = new WebSocket(`${API.replace("http", "ws")}/ws/endpoints/${selected.id}?session_id=${SESSION_ID}`);
    ws.onmessage = (event) => {
      const newRequest = JSON.parse(event.data);
      setRequests(prev => [newRequest, ...prev]);
    };
    return () => ws.close();
  }, [selected?.id]);

  const loadAttempts = async (id: string) => {
    const res = await apiFetch(`/api/requests/${id}/attempts`);
    const data = await res.json();
    setAttempts(data);
  };

  useEffect(() => {
    if (!detail) return;
    const interval = setInterval(() => loadAttempts(detail.id), 5000);
    return () => clearInterval(interval);
  }, [detail?.id]);

  const loadDetail = async (id: string) => {
    const res = await apiFetch(`/api/requests/${id}`);
    const data = await res.json();
    setDetail(data);
    setReplayBody(data.body);
    setReplayResult(null);
    setAttempts([]);
    loadAttempts(id);
  };

  const createEndpoint = async () => {
    const res = await apiFetch("/api/endpoints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName || "Untitled" }),
    });
    const ep = await res.json();
    const newEp = { id: ep.id, name: newName || "Untitled", created_at: new Date().toISOString() };
    setEndpoints(prev => [newEp, ...prev]);
    setSelected(newEp);
    setRequests([]);
    setDetail(null);
    setNewName("");
    if (ep.secret) setSecrets(prev => ({ ...prev, [ep.id]: ep.secret }));
  };

  const hookUrl = selected ? `${API}/hooks/${selected.id}` : "";

  const copyUrl = () => {
    navigator.clipboard.writeText(hookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copySecret = () => {
    if (selected && secrets[selected.id]) {
      navigator.clipboard.writeText(secrets[selected.id]);
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 2000);
    }
  };

  const replay = async () => {
    if (!detail) return;
    setReplaying(true);
    setReplayResult(null);
    const res = await apiFetch(`/api/requests/${detail.id}/replay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destination_url: replayUrl, body_override: replayBody }),
    });
    const data = await res.json();
    setReplayResult(data);
    loadAttempts(detail.id);
    setReplaying(false);
  };

  const deleteEndpoint = async (id: string) => {
    await apiFetch(`/api/endpoints/${id}`, { method: "DELETE" });
    setEndpoints(prev => prev.filter(ep => ep.id !== id));
    if (selected?.id === id) { setSelected(null); setRequests([]); setDetail(null); }
  };

  const deleteRequest = async (id: string) => {
    await apiFetch(`/api/requests/${id}`, { method: "DELETE" });
    setRequests(prev => prev.filter(r => r.id !== id));
    if (detail?.id === id) setDetail(null);
  };

  return (
    <div className="layout">
      <nav className="dashboard-nav">
        <span className="dashboard-nav-logo">Webhook Inspector</span>
        <button className="dashboard-nav-back" onClick={onBack}>← Back to home</button>
      </nav>

      <div className="dashboard-body">
        <div className="sidebar" style={{ width: sidebarWidth }}>
          <div className="sidebar-header">
            <div className="logo">Endpoints</div>
            <div className="input-row">
              <input
                className="ep-input"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && createEndpoint()}
                placeholder="New endpoint..."
              />
              <button className="add-btn" onClick={createEndpoint}>+</button>
            </div>
          </div>
          <div className="ep-list">
            {endpoints.length === 0 && (
              <div style={{ fontSize: 11, color: "#222", padding: "8px 10px" }}>No endpoints yet</div>
            )}
            {endpoints.map(ep => (
              <div key={ep.id} className={`ep-item ${selected?.id === ep.id ? "active" : ""}`} onClick={() => setSelected(ep)}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div className="ep-name">{ep.name}</div>
                  <span
                    onClick={e => { e.stopPropagation(); deleteEndpoint(ep.id); }}
                    style={{ color: "#333", fontSize: 14, cursor: "pointer", padding: "0 2px" }}
                    onMouseEnter={e => (e.currentTarget.style.color = "#f87171")}
                    onMouseLeave={e => (e.currentTarget.style.color = "#333")}
                  >×</span>
                </div>
                <div className="ep-id">{ep.id.slice(0, 14)}...</div>
              </div>
            ))}
          </div>
          <div
            className="resize-handle"
            onMouseDown={() => {
              isResizingSidebar.current = true;
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";
            }}
          />
        </div>

        <div className="main">
          {!selected ? (
            <div className="empty-state">
              <div className="empty-state-icon">↪</div>
              <div className="empty-state-text">Create or select an endpoint</div>
            </div>
          ) : (
            <>
              <div className="main-header">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="hook-label">Hook URL</div>
                  <div className="hook-url">{hookUrl}</div>
                  {selected && secrets[selected.id] && (
                    <div style={{ marginTop: 10 }}>
                      <div className="hook-label">
                        Signing Secret
                        <span style={{ color: "#2a2a2a", marginLeft: 6 }}>(shown once)</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                        <div className="hook-url" style={{ color: "#c084fc", fontFamily: "monospace", fontSize: 11 }}>
                          {secrets[selected.id]}
                        </div>
                        <button
                          onClick={copySecret}
                          style={{ height: 22, padding: "0 8px", background: "transparent", border: "1px solid #2a2a2a", borderRadius: 4, color: "#555", fontSize: 10, fontFamily: "Inter, sans-serif", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
                        >
                          {secretCopied ? "✓" : "copy"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <button className="copy-btn" onClick={copyUrl}>{copied ? "✓ Copied" : "Copy URL"}</button>
              </div>

              <div className="content-area">
                <div className="feed" style={{ width: feedWidth }}>
                  <div className="feed-meta">
                    {requests.length} request{requests.length !== 1 ? "s" : ""} — <span style={{ color: "#4ade80" }}>● live</span>
                  </div>
                  {requests.length === 0 ? (
                    <div className="empty">No requests yet. Fire a curl at the URL above.</div>
                  ) : (
                    requests.map(r => (
                      <div
                        key={r.id}
                        className={`req-row ${detail?.id === r.id ? "active" : ""}`}
                        onClick={() => loadDetail(r.id)}
                      >
                        <span className="method" style={{ color: METHOD_COLOR[r.method] || "#888" }}>{r.method}</span>
                        <span className="req-type">{r.content_type || "no content-type"}</span>
                        <span className="req-time">{timeAgo(r.received_at)}</span>
                        <span
                          onClick={e => { e.stopPropagation(); deleteRequest(r.id); }}
                          style={{ color: "#222", fontSize: 14, cursor: "pointer", marginLeft: 4 }}
                          onMouseEnter={e => (e.currentTarget.style.color = "#f87171")}
                          onMouseLeave={e => (e.currentTarget.style.color = "#222")}
                        >×</span>
                      </div>
                    ))
                  )}
                </div>

                <div
                  style={{ width: 4, cursor: "col-resize", flexShrink: 0, background: "transparent", borderRight: "1px solid #111" }}
                  onMouseDown={() => {
                    isResizingFeed.current = true;
                    document.body.style.cursor = "col-resize";
                    document.body.style.userSelect = "none";
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#333")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                />

                <div className="detail">
                  {!detail ? (
                    <div className="detail-empty">← Select a request to inspect</div>
                  ) : (
                    <>
                      <div className="detail-meta-row">
                        <div>
                          <div className="detail-label">Method</div>
                          <div className="detail-meta-val" style={{ color: METHOD_COLOR[detail.method] }}>{detail.method}</div>
                        </div>
                        <div>
                          <div className="detail-label">Source IP</div>
                          <div className="detail-meta-val">{detail.source_ip}</div>
                        </div>
                        <div>
                          <div className="detail-label">Received</div>
                          <div className="detail-meta-val">{timeAgo(detail.received_at)}</div>
                        </div>
                        <div>
                          <div className="detail-label">Content-Type</div>
                          <div className="detail-meta-val">{detail.content_type || "—"}</div>
                        </div>
                      </div>

                      {detail.body && (
                        <div className="detail-section">
                          <div className="detail-label">Body</div>
                          <div className="body-block">{tryFormatJson(detail.body)}</div>
                        </div>
                      )}

                      {Object.keys(detail.query_params || {}).length > 0 && (
                        <div className="detail-section">
                          <div className="detail-label">Query Params</div>
                          <table className="kv-table">
                            {Object.entries(detail.query_params).map(([k, v]) => (
                              <tr key={k}><td>{k}</td><td>{String(v)}</td></tr>
                            ))}
                          </table>
                        </div>
                      )}

                      <div className="detail-section">
                        <div className="detail-label">Headers</div>
                        <table className="kv-table">
                          {Object.entries(detail.headers).map(([k, v]) => (
                            <tr key={k}><td>{k}</td><td>{String(v)}</td></tr>
                          ))}
                        </table>
                      </div>

                      <div className="replay-section">
                        <div className="detail-label" style={{ marginBottom: 12 }}>Replay</div>
                        <input
                          className="replay-input"
                          value={replayUrl}
                          onChange={e => setReplayUrl(e.target.value)}
                          placeholder="Destination URL"
                        />
                        <textarea
                          className="replay-textarea"
                          value={replayBody || ""}
                          onChange={e => setReplayBody(e.target.value)}
                          placeholder="Request body (edit before replaying)"
                        />
                        <button className="replay-btn" onClick={replay} disabled={replaying}>
                          {replaying ? "Sending..." : "↩ Replay"}
                        </button>
                        {replayResult && (
                          <div className={`replay-result ${replayResult.error ? "error" : "success"}`}>
                            {replayResult.error ? (
                              <span style={{ color: "#f87171" }}>Error: {replayResult.error}</span>
                            ) : (
                              <>
                                <span style={{ color: "#4ade80" }}>{replayResult.status_code}</span>
                                <span style={{ color: "#444", margin: "0 8px" }}>·</span>
                                <span style={{ color: "#444" }}>{replayResult.duration_ms}ms</span>
                                <div style={{ marginTop: 8, color: "#555" }}>{replayResult.response_body?.slice(0, 200)}</div>
                              </>
                            )}
                          </div>
                        )}
                      </div>

                      {attempts.length > 0 && (
                        <div className="detail-section">
                          <div className="detail-label">Delivery Attempts</div>
                          <div className="attempts-list">
                            {attempts.map(a => (
                              <div key={a.id} className="attempt-row">
                                <div className="attempt-dot" style={{
                                  background: a.error ? "#f87171" : a.status_code && parseInt(a.status_code) < 300 ? "#4ade80" : "#fb923c"
                                }} />
                                <span style={{ color: a.error ? "#f87171" : a.status_code && parseInt(a.status_code) < 300 ? "#4ade80" : "#fb923c" }}>
                                  {a.error ? "Error" : a.status_code}
                                </span>
                                <span style={{ color: "#444", flex: 1 }}>{a.destination_url}</span>
                                <span style={{ color: "#333" }}>{a.duration_ms ? `${a.duration_ms}ms` : "—"}</span>
                                <span style={{ color: "#333" }}>{timeAgo(a.attempted_at)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
