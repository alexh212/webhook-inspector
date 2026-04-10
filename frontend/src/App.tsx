import { useState, useEffect, useRef, useCallback } from "react";

import { timeAgo, METHOD_COLOR, formatJson, isValidUrl, GITHUB_PROFILE_URL, type Theme } from "./utils";
import {
  DEFAULT_REPLAY_URL,
  parseReplayError,
  REPLAY_405_HINT,
  REPLAY_PRESETS,
  REPLAY_TIPS,
  WEBHOOK_EXPLAINER_SHORT,
  WEBHOOK_ONELINER,
} from "./onboardingCopy";

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

const apiFetch = async (url: string, options: RequestInit = {}) => {
  const res = await fetch(`${API}${url}`, {
    ...options,
    headers: { ...(options.headers as Record<string, string>), "x-session-id": SESSION_ID },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed (${res.status})`);
  }
  return res;
};

type Endpoint = { id: string; name: string; created_at: string };
type CapturedRequest = { id: string; method: string; content_type: string; source_ip: string; received_at: string };
type RequestDetail = {
  id: string; method: string; headers: Record<string, string>;
  body: string; query_params: Record<string, string>;
  source_ip: string; content_type: string; received_at: string;
};
type ReplayResult = { status_code: string; response_body: string; duration_ms: string; error: string | null };
type DeliveryAttempt = { id: string; destination_url: string; status_code: string | null; duration_ms: string | null; error: string | null; attempted_at: string };

export default function App({ onBack, theme, toggleTheme }: { onBack: () => void; theme: Theme; toggleTheme: () => void }) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [selected, setSelected] = useState<Endpoint | null>(null);
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [newName, setNewName] = useState("");
  const [copied, setCopied] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);
  const [replayUrl, setReplayUrl] = useState(DEFAULT_REPLAY_URL);
  const [replayBody, setReplayBody] = useState<string | null>(null);
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [attempts, setAttempts] = useState<DeliveryAttempt[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [feedWidth, setFeedWidth] = useState(380);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loadingEndpoints, setLoadingEndpoints] = useState(true);
  const [loadingRequests, setLoadingRequests] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [wsStatus, setWsStatus] = useState<"disconnected" | "connected" | "reconnecting">("disconnected");
  const [confirmDelete, setConfirmDelete] = useState<{ type: "endpoint" | "request"; id: string } | null>(null);
  const [gettingStartedDismissed, setGettingStartedDismissed] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem("wi_dismiss_getting_started") === "1"
  );
  const isResizingSidebar = useRef(false);
  const isResizingFeed = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(1000);

  const showError = useCallback((msg: string) => {
    setError(msg);
    setTimeout(() => setError(null), 5000);
  }, []);

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
    setLoadingEndpoints(true);
    apiFetch("/api/endpoints")
      .then(r => r.json())
      .then(setEndpoints)
      .catch(e => showError(`Failed to load endpoints: ${e.message}`))
      .finally(() => setLoadingEndpoints(false));
  }, [showError]);

  const connectWebSocket = useCallback((endpointId: string) => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }

    const ws = new WebSocket(`${API.replace("http", "ws")}/ws/endpoints/${endpointId}?session_id=${SESSION_ID}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus("connected");
      reconnectDelay.current = 1000;
    };

    ws.onmessage = (event) => {
      try {
        const newRequest = JSON.parse(event.data);
        setRequests(prev => [newRequest, ...prev]);
      } catch {
        /* ignore malformed messages */
      }
    };

    ws.onerror = () => {
      setWsStatus("reconnecting");
    };

    ws.onclose = () => {
      setWsStatus("reconnecting");
      const delay = Math.min(reconnectDelay.current, 30000);
      reconnectTimer.current = setTimeout(() => {
        reconnectDelay.current = delay * 2;
        connectWebSocket(endpointId);
      }, delay);
    };
  }, []);

  useEffect(() => {
    if (!selected) {
      setWsStatus("disconnected");
      return;
    }
    setDetail(null);
    setRequests([]);
    setAttempts([]);
    setLoadingRequests(true);
    apiFetch(`/api/endpoints/${selected.id}/requests`)
      .then(r => r.json())
      .then(setRequests)
      .catch(e => showError(`Failed to load requests: ${e.message}`))
      .finally(() => setLoadingRequests(false));

    connectWebSocket(selected.id);

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    };
  }, [selected?.id, connectWebSocket, showError]);

  const loadAttempts = useCallback(async (id: string) => {
    try {
      const res = await apiFetch(`/api/requests/${id}/attempts`);
      const data = await res.json();
      setAttempts(data);
    } catch {
      /* silently fail on attempt polling */
    }
  }, []);

  useEffect(() => {
    if (!detail) return;
    const interval = setInterval(() => loadAttempts(detail.id), 5000);
    return () => clearInterval(interval);
  }, [detail?.id, loadAttempts]);

  const loadDetail = async (id: string) => {
    setLoadingDetail(true);
    try {
      const res = await apiFetch(`/api/requests/${id}`);
      const data = await res.json();
      setDetail(data);
      setReplayBody(data.body);
      setReplayResult(null);
      setAttempts([]);
      loadAttempts(id);
    } catch (e: unknown) {
      showError(`Failed to load request detail: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoadingDetail(false);
    }
  };

  const createEndpoint = async () => {
    try {
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
    } catch (e: unknown) {
      showError(`Failed to create endpoint: ${e instanceof Error ? e.message : e}`);
    }
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
    if (!isValidUrl(replayUrl)) {
      showError("Invalid replay URL. Must be a valid http:// or https:// URL.");
      return;
    }
    setReplaying(true);
    setReplayResult(null);
    try {
      const res = await apiFetch(`/api/requests/${detail.id}/replay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destination_url: replayUrl, body_override: replayBody }),
      });
      const data = await res.json();
      setReplayResult(data);
      loadAttempts(detail.id);
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      showError(`Replay failed: ${parseReplayError(raw)}`);
    } finally {
      setReplaying(false);
    }
  };

  const executeDelete = async () => {
    if (!confirmDelete) return;
    const { type, id } = confirmDelete;
    setConfirmDelete(null);
    try {
      if (type === "endpoint") {
        await apiFetch(`/api/endpoints/${id}`, { method: "DELETE" });
        setEndpoints(prev => prev.filter(ep => ep.id !== id));
        if (selected?.id === id) { setSelected(null); setRequests([]); setDetail(null); }
      } else {
        await apiFetch(`/api/requests/${id}`, { method: "DELETE" });
        setRequests(prev => prev.filter(r => r.id !== id));
        if (detail?.id === id) setDetail(null);
      }
    } catch (e: unknown) {
      showError(`Delete failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const replayUrlValid = isValidUrl(replayUrl);

  return (
    <div className="layout">
      <nav className="dashboard-nav">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="dashboard-nav-logo">Relay</span>
          <span style={{ color: "var(--border-hover)" }}>·</span>
          <a
            className="github-nav-link"
            href={GITHUB_PROFILE_URL}
            target="_blank"
            rel="noopener"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            alexh212
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1.5 8.5L8.5 1.5M8.5 1.5H3.5M8.5 1.5V6.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="theme-toggle" onClick={toggleTheme} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <button className="nav-btn" onClick={onBack}>← Home</button>
        </div>
      </nav>

      {error && (
        <div style={{
          position: "fixed", top: 56, left: "50%", transform: "translateX(-50%)", zIndex: 1000,
          background: "var(--error-bg)", border: "1px solid var(--error-border)", borderRadius: 8, padding: "10px 20px",
          color: "var(--error)", fontSize: 12, fontFamily: "Inter, sans-serif", maxWidth: 500,
        }}>
          {error}
          <span onClick={() => setError(null)} style={{ marginLeft: 12, cursor: "pointer", color: "var(--text-muted)" }}>×</span>
        </div>
      )}

      {confirmDelete && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 1000,
          background: "var(--modal-overlay)", display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            background: "var(--modal-bg)", border: "1px solid var(--border-active)", borderRadius: 10, padding: "24px 28px",
            maxWidth: 360, fontFamily: "Inter, sans-serif",
          }}>
            <div style={{ fontSize: 14, color: "var(--text)", marginBottom: 6 }}>Confirm delete</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 20, lineHeight: 1.5 }}>
              Are you sure you want to delete this {confirmDelete.type}? This action cannot be undone.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setConfirmDelete(null)}
                style={{ height: 30, padding: "0 14px", background: "transparent", border: "1px solid var(--border-active)", borderRadius: 6, color: "var(--text-secondary)", fontSize: 12, fontFamily: "Inter, sans-serif", cursor: "pointer" }}
              >Cancel</button>
              <button
                onClick={executeDelete}
                style={{ height: 30, padding: "0 14px", background: "var(--error)", border: "none", borderRadius: 6, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "Inter, sans-serif", cursor: "pointer" }}
              >Delete</button>
            </div>
          </div>
        </div>
      )}

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
            {loadingEndpoints && (
              <div style={{ fontSize: 11, color: "var(--text-faint)", padding: "8px 10px" }}>Loading...</div>
            )}
            {!loadingEndpoints && endpoints.length === 0 && (
              <div style={{ fontSize: 11, color: "var(--text-ghost)", padding: "8px 10px" }}>No endpoints yet</div>
            )}
            {endpoints.map(ep => (
              <div key={ep.id} className={`ep-item ${selected?.id === ep.id ? "active" : ""}`} onClick={() => setSelected(ep)}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div className="ep-name">{ep.name}</div>
                  <span
                    onClick={e => { e.stopPropagation(); setConfirmDelete({ type: "endpoint", id: ep.id }); }}
                    style={{ color: "var(--text-faint)", fontSize: 14, cursor: "pointer", padding: "0 2px" }}
                    onMouseEnter={e => (e.currentTarget.style.color = "var(--error)")}
                    onMouseLeave={e => (e.currentTarget.style.color = "var(--text-faint)")}
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
                        <span style={{ color: "var(--text-ghost)", marginLeft: 6 }}>(shown once)</span>
                      </div>
                      <div style={{ fontSize: 10, color: "var(--text-faint)", marginBottom: 6, lineHeight: 1.5 }}>
                        Sign requests with this secret using HMAC-SHA256 and send the result in the <span style={{ color: "var(--text-muted)", fontFamily: "monospace" }}>x-webhook-signature</span> header.
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div className="hook-url" style={{ color: "var(--purple)" }}>
                          {secrets[selected.id]}
                        </div>
                        <button
                          onClick={copySecret}
                          style={{ height: 22, padding: "0 8px", background: "transparent", border: "1px solid var(--border-active)", borderRadius: 4, color: "var(--text-muted)", fontSize: 10, fontFamily: "Inter, sans-serif", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
                        >
                          {secretCopied ? "✓" : "copy"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <button className="copy-btn" onClick={copyUrl}>{copied ? "✓ Copied" : "Copy URL"}</button>
              </div>

              {selected && !gettingStartedDismissed && (
                <div
                  style={{
                    margin: "0 22px 12px",
                    padding: "12px 14px",
                    background: "var(--bg-surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 12,
                    lineHeight: 1.55,
                    color: "var(--text-muted)",
                    position: "relative",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      localStorage.setItem("wi_dismiss_getting_started", "1");
                      setGettingStartedDismissed(true);
                    }}
                    style={{
                      position: "absolute",
                      top: 8,
                      right: 10,
                      background: "transparent",
                      border: "none",
                      color: "var(--text-faint)",
                      cursor: "pointer",
                      fontSize: 16,
                      lineHeight: 1,
                      padding: 4,
                    }}
                    aria-label="Dismiss getting started"
                  >
                    ×
                  </button>
                  <div style={{ fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Getting started
                  </div>
                  <p style={{ marginBottom: 10 }}>
                    <strong style={{ color: "var(--text)" }}>{WEBHOOK_ONELINER}</strong>{" "}
                    {WEBHOOK_EXPLAINER_SHORT}
                  </p>
                  <ul style={{ margin: "0 0 12px 18px", padding: 0 }}>
                    {REPLAY_TIPS.map((tip, i) => (
                      <li key={i} style={{ marginBottom: 6 }}>{tip}</li>
                    ))}
                  </ul>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 6 }}>Try replay to (test endpoints):</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                    {REPLAY_PRESETS.map((p) => (
                      <button
                        key={p.url}
                        type="button"
                        onClick={() => setReplayUrl(p.url)}
                        title={p.hint}
                        style={{
                          height: 26,
                          padding: "0 10px",
                          background: "var(--bg-raised)",
                          border: "1px solid var(--border-active)",
                          borderRadius: 6,
                          fontSize: 10,
                          fontFamily: "Inter, sans-serif",
                          color: "var(--text-secondary)",
                          cursor: "pointer",
                        }}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-faint)" }}>
                    Docs:{" "}
                    <a href="https://httpbin.org/anything" target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-muted)" }}>httpbin.org/anything</a>
                    {" · "}
                    <a href="https://httpbin.org/get" target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-muted)" }}>/get</a>
                    {" · "}
                    <a href="https://httpbin.org/post" target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-muted)" }}>/post</a>
                  </div>
                </div>
              )}

              <div className="content-area">
                <div className="feed" style={{ width: feedWidth }}>
                  <div className="feed-meta">
                    {requests.length} request{requests.length !== 1 ? "s" : ""} —{" "}
                    <span style={{ color: wsStatus === "connected" ? "var(--success)" : wsStatus === "reconnecting" ? "var(--warning)" : "var(--text-muted)" }}>
                      ● {wsStatus === "connected" ? "live" : wsStatus === "reconnecting" ? "reconnecting" : "offline"}
                    </span>
                  </div>
                  {loadingRequests ? (
                    <div className="empty">Loading requests...</div>
                  ) : requests.length === 0 ? (
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
                          onClick={e => { e.stopPropagation(); setConfirmDelete({ type: "request", id: r.id }); }}
                          style={{ color: "var(--text-ghost)", fontSize: 14, cursor: "pointer", marginLeft: 4 }}
                          onMouseEnter={e => (e.currentTarget.style.color = "var(--error)")}
                          onMouseLeave={e => (e.currentTarget.style.color = "var(--text-ghost)")}
                        >×</span>
                      </div>
                    ))
                  )}
                </div>

                <div
                  style={{ width: 4, cursor: "col-resize", flexShrink: 0, background: "transparent", borderRight: "1px solid var(--bg-raised)" }}
                  onMouseDown={() => {
                    isResizingFeed.current = true;
                    document.body.style.cursor = "col-resize";
                    document.body.style.userSelect = "none";
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = "var(--resize-hover)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                />

                <div className="detail">
                  {loadingDetail ? (
                    <div className="detail-empty">Loading...</div>
                  ) : !detail ? (
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
                          <div className="body-block">{formatJson(detail.body)}</div>
                        </div>
                      )}

                      {Object.keys(detail.query_params || {}).length > 0 && (
                        <div className="detail-section">
                          <div className="detail-label">Query Params</div>
                          <table className="kv-table">
                            <tbody>
                            {Object.entries(detail.query_params).map(([k, v]) => (
                              <tr key={k}><td>{k}</td><td>{String(v)}</td></tr>
                            ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      <div className="detail-section">
                        <div className="detail-label">Headers</div>
                        <table className="kv-table">
                          <tbody>
                          {Object.entries(detail.headers).map(([k, v]) => (
                            <tr key={k}><td>{k}</td><td>{String(v)}</td></tr>
                          ))}
                          </tbody>
                        </table>
                      </div>

                      <div className="replay-section">
                        <div className="detail-label" style={{ marginBottom: 12 }}>Replay</div>
                        <div style={{ fontSize: 10, color: "var(--text-faint)", marginBottom: 8, lineHeight: 1.5 }}>
                          Same method as this request ({detail.method}). Use a URL that accepts {detail.method}; localhost is blocked—use a public URL or a tunnel.
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                          {REPLAY_PRESETS.map((p) => (
                            <button
                              key={p.url}
                              type="button"
                              onClick={() => setReplayUrl(p.url)}
                              title={p.hint}
                              style={{
                                height: 24,
                                padding: "0 8px",
                                background: "var(--bg-raised)",
                                border: "1px solid var(--border-active)",
                                borderRadius: 4,
                                fontSize: 10,
                                fontFamily: "Inter, sans-serif",
                                color: "var(--text-muted)",
                                cursor: "pointer",
                              }}
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                        <input
                          className="replay-input"
                          value={replayUrl}
                          onChange={e => setReplayUrl(e.target.value)}
                          placeholder="Destination URL"
                          style={!replayUrlValid && replayUrl ? { borderColor: "var(--error)" } : {}}
                        />
                        {!replayUrlValid && replayUrl && (
                          <div style={{ fontSize: 10, color: "var(--error)", marginBottom: 6, marginTop: -4 }}>
                            Enter a valid http:// or https:// URL
                          </div>
                        )}
                        <textarea
                          className="replay-textarea"
                          value={replayBody || ""}
                          onChange={e => setReplayBody(e.target.value)}
                          placeholder="Request body (edit before replaying)"
                        />
                        <button className="replay-btn" onClick={replay} disabled={replaying || !replayUrlValid}>
                          {replaying ? "Sending..." : "↩ Replay"}
                        </button>
                        {replayResult && (
                          <div className={`replay-result ${replayResult.error ? "error" : "success"}`}>
                            {replayResult.error ? (
                              <span style={{ color: "var(--error)" }}>Error: {replayResult.error}</span>
                            ) : (
                              <>
                                <span style={{ color: parseInt(replayResult.status_code, 10) < 400 ? "var(--success)" : "var(--error)" }}>{replayResult.status_code}</span>
                                <span style={{ color: "var(--text-dim)", margin: "0 8px" }}>·</span>
                                <span style={{ color: "var(--text-dim)" }}>{replayResult.duration_ms}ms</span>
                                {replayResult.status_code === "405" && (
                                  <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
                                    {REPLAY_405_HINT}
                                  </div>
                                )}
                                <div style={{ marginTop: 8, color: "var(--text-muted)" }}>{replayResult.response_body?.slice(0, 200)}</div>
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
                                  background: a.error ? "var(--error)" : a.status_code && parseInt(a.status_code) < 300 ? "var(--success)" : "var(--warning)"
                                }} />
                                <span style={{ color: a.error ? "var(--error)" : a.status_code && parseInt(a.status_code) < 300 ? "var(--success)" : "var(--warning)" }}>
                                  {a.error ? "Error" : a.status_code}
                                </span>
                                <span style={{ color: "var(--text-dim)", flex: 1 }}>{a.destination_url}</span>
                                <span style={{ color: "var(--text-faint)" }}>{a.duration_ms ? `${a.duration_ms}ms` : "—"}</span>
                                <span style={{ color: "var(--text-faint)" }}>{timeAgo(a.attempted_at)}</span>
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
