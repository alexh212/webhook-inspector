import { useState, useEffect } from "react";

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

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

export default function App() {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [selected, setSelected] = useState<Endpoint | null>(null);
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [newName, setNewName] = useState("");
  const [copied, setCopied] = useState(false);
  const [replayUrl, setReplayUrl] = useState("http://localhost:9000");
  const [replayBody, setReplayBody] = useState<string | null>(null);
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [attempts, setAttempts] = useState<DeliveryAttempt[]>([]);

  useEffect(() => {
    fetch(`${API}/api/endpoints`).then(r => r.json()).then(setEndpoints);
  }, []);

  useEffect(() => {
    if (!selected) return;
    setDetail(null);
    fetch(`${API}/api/endpoints/${selected.id}/requests`)
      .then(r => r.json()).then(setRequests);
    const ws = new WebSocket(`${API.replace("http", "ws")}/ws/endpoints/${selected.id}`);
    ws.onmessage = (event) => {
      const newRequest = JSON.parse(event.data);
      setRequests(prev => [newRequest, ...prev]);
    };
    return () => ws.close();
  }, [selected]);

  const createEndpoint = async () => {
    const res = await fetch(`${API}/api/endpoints`, {
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
  };

const loadDetail = async (id: string) => {
    const res = await fetch(`${API}/api/requests/${id}`);
    const data = await res.json();
    setDetail(data);
    setReplayBody(data.body);
    setReplayResult(null);
    loadAttempts(id);
  };

  const hookUrl = selected ? `http://localhost:8000/hooks/${selected.id}` : "";

  const copyUrl = () => {
    navigator.clipboard.writeText(hookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

const replay = async () => {
    if (!detail) return;
    setReplaying(true);
    setReplayResult(null);
    const res = await fetch(`${API}/api/requests/${detail.id}/replay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destination_url: replayUrl, body_override: replayBody }),
    });
    const data = await res.json();
    setReplayResult(data);
    loadAttempts(detail.id);  // reload attempts after replay
    setReplaying(false);
  };

  const deleteEndpoint = async (id: string) => {
  await fetch(`${API}/api/endpoints/${id}`, { method: "DELETE" });
  setEndpoints(prev => prev.filter(ep => ep.id !== id));
  if (selected?.id === id) { setSelected(null); setRequests([]); setDetail(null); }
};

  const deleteRequest = async (id: string) => {
    await fetch(`${API}/api/requests/${id}`, { method: "DELETE" });
    setRequests(prev => prev.filter(r => r.id !== id));
    if (detail?.id === id) setDetail(null);
  };

  const loadAttempts = async (id: string) => {
  const res = await fetch(`${API}/api/requests/${id}/attempts`);
  const data = await res.json();
  setAttempts(data);
};

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0a0a0a; color: #ededed; font-family: 'Inter', sans-serif; -webkit-font-smoothing: antialiased; }
        .attempts-list { margin-top: 12px; }
        .attempt-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid #1a1a1a; font-size: 12px; font-family: monospace; }
        .attempt-row:last-child { border-bottom: none; }
        .attempt-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
        .layout { display: flex; height: 100vh; }
        .sidebar { width: 240px; flex-shrink: 0; border-right: 1px solid #1a1a1a; display: flex; flex-direction: column; }
        .sidebar-header { padding: 20px 16px 16px; border-bottom: 1px solid #1a1a1a; }
        .logo { font-size: 13px; font-weight: 600; color: #ededed; letter-spacing: -0.3px; margin-bottom: 14px; }
        .input-row { display: flex; gap: 6px; }
        .ep-input { flex: 1; height: 32px; background: #111; border: 1px solid #222; border-radius: 6px; padding: 0 10px; font-size: 12px; font-family: 'Inter', sans-serif; color: #ededed; outline: none; transition: border-color 0.15s; }
        .ep-input::placeholder { color: #444; }
        .ep-input:focus { border-color: #444; }
        .add-btn { height: 32px; width: 32px; background: #ededed; color: #0a0a0a; border: none; border-radius: 6px; font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-weight: 500; transition: background 0.15s; flex-shrink: 0; }
        .add-btn:hover { background: #d4d4d4; }
        .ep-list { flex: 1; overflow-y: auto; padding: 8px; }
        .ep-item { padding: 8px 10px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; margin-bottom: 2px; transition: all 0.15s; }
        .ep-item:hover { background: #111; }
        .ep-item.active { background: #111; border-color: #333; }
        .ep-name { font-size: 12px; color: #ededed; font-weight: 500; }
        .ep-id { font-size: 10px; color: #444; margin-top: 2px; font-family: monospace; }
        .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
        .main-header { padding: 16px 24px; border-bottom: 1px solid #1a1a1a; display: flex; align-items: center; justify-content: space-between; }
        .hook-label { font-size: 11px; color: #555; margin-bottom: 4px; }
        .hook-url { font-size: 12px; color: #888; font-family: monospace; }
        .copy-btn { height: 30px; padding: 0 14px; background: transparent; border: 1px solid #222; border-radius: 6px; color: #888; font-size: 11px; font-family: 'Inter', sans-serif; cursor: pointer; transition: all 0.15s; white-space: nowrap; }
        .copy-btn:hover { border-color: #444; color: #ededed; }
        .content-area { flex: 1; display: flex; overflow: hidden; }
        .feed { width: 380px; flex-shrink: 0; border-right: 1px solid #1a1a1a; overflow-y: auto; padding: 16px; }
        .feed-meta { font-size: 11px; color: #444; margin-bottom: 12px; }
        .empty { border: 1px dashed #1a1a1a; border-radius: 8px; padding: 32px; text-align: center; color: #333; font-size: 12px; }
        .req-row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; margin-bottom: 4px; background: #111; border: 1px solid #1a1a1a; border-radius: 8px; cursor: pointer; transition: border-color 0.15s; }
        .req-row:hover { border-color: #333; }
        .req-row.active { border-color: #444; background: #161616; }
        .method { font-size: 11px; font-weight: 600; font-family: monospace; min-width: 44px; }
        .req-type { font-size: 11px; color: #555; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .req-time { font-size: 11px; color: #444; white-space: nowrap; }
        .detail { flex: 1; overflow-y: auto; padding: 24px; }
        .detail-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: #333; font-size: 12px; }
        .detail-section { margin-bottom: 28px; }
        .detail-label { font-size: 10px; color: #555; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 10px; font-weight: 500; }
        .detail-meta-row { display: flex; gap: 24px; margin-bottom: 28px; flex-wrap: wrap; }
        .detail-meta-val { font-size: 13px; color: #ededed; font-family: monospace; margin-top: 4px; }
        .kv-table { width: 100%; border-collapse: collapse; }
        .kv-table tr { border-bottom: 1px solid #1a1a1a; }
        .kv-table tr:last-child { border-bottom: none; }
        .kv-table td { padding: 6px 0; font-size: 12px; font-family: monospace; vertical-align: top; }
        .kv-table td:first-child { color: #555; width: 40%; padding-right: 16px; }
        .kv-table td:last-child { color: #ededed; word-break: break-all; }
        .body-block { background: #111; border: 1px solid #1a1a1a; border-radius: 6px; padding: 14px; font-size: 12px; font-family: monospace; color: #ededed; white-space: pre-wrap; word-break: break-all; line-height: 1.6; }
        .replay-section { margin-top: 28px; padding-top: 28px; border-top: 1px solid #1a1a1a; }
        .replay-input { width: 100%; height: 32px; background: #111; border: 1px solid #222; border-radius: 6px; padding: 0 10px; font-size: 12px; font-family: monospace; color: #ededed; outline: none; margin-bottom: 8px; }
        .replay-input:focus { border-color: #444; }
        .replay-textarea { width: 100%; background: #111; border: 1px solid #222; border-radius: 6px; padding: 10px; font-size: 12px; font-family: monospace; color: #ededed; outline: none; resize: vertical; min-height: 80px; margin-bottom: 8px; }
        .replay-textarea:focus { border-color: #444; }
        .replay-btn { height: 32px; padding: 0 16px; background: #ededed; color: #0a0a0a; border: none; border-radius: 6px; font-size: 12px; font-weight: 600; font-family: 'Inter', sans-serif; cursor: pointer; transition: background 0.15s; }
        .replay-btn:hover { background: #d4d4d4; }
        .replay-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .replay-result { margin-top: 12px; padding: 12px; background: #111; border: 1px solid #1a1a1a; border-radius: 6px; font-size: 12px; font-family: monospace; }
        .replay-result.success { border-color: #1a3a2a; }
        .replay-result.error { border-color: #3a1a1a; }
        .empty-state { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 8px; color: #333; }
        .empty-state-icon { font-size: 28px; }
        .empty-state-text { font-size: 13px; }
      `}</style>

      <div className="layout">
        <div className="sidebar">
          <div className="sidebar-header">
            <div className="logo">Webhook Inspector</div>
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
              <div style={{ fontSize: 11, color: "#333", padding: "8px 10px" }}>No endpoints yet</div>
            )}
            {endpoints.map(ep => (
              <div key={ep.id} className={`ep-item ${selected?.id === ep.id ? "active" : ""}`} onClick={() => setSelected(ep)}>
                <div style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                  <div className="ep-name">{ep.name}</div>
                  <span onClick={e => { e.stopPropagation(); deleteEndpoint(ep.id); }}
                    style={{color:"#444", fontSize:14, cursor:"pointer", padding:"0 2px"}}
                    onMouseEnter={e => (e.currentTarget.style.color="#f87171")}
                    onMouseLeave={e => (e.currentTarget.style.color="#444")}>×</span>
                </div>
                <div className="ep-id">{ep.id.slice(0, 14)}...</div>
              </div>
            ))}
          </div>
        </div>

        <div className="main">
          {!selected ? (
            <div className="empty-state">
              <div className="empty-state-icon">⚡</div>
              <div className="empty-state-text">Create or select an endpoint</div>
            </div>
          ) : (
            <>
              <div className="main-header">
                <div>
                  <div className="hook-label">Hook URL</div>
                  <div className="hook-url">{hookUrl}</div>
                </div>
                <button className="copy-btn" onClick={copyUrl}>{copied ? "✓ Copied" : "Copy URL"}</button>
              </div>
              <div className="content-area">
                <div className="feed">
                  <div className="feed-meta">
                    {requests.length} request{requests.length !== 1 ? "s" : ""} — <span style={{color: "#4ade80"}}>● live</span>
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
  <span onClick={e => { e.stopPropagation(); deleteRequest(r.id); }}
    style={{color:"#333", fontSize:14, cursor:"pointer", marginLeft:4}}
    onMouseEnter={e => (e.currentTarget.style.color="#f87171")}
    onMouseLeave={e => (e.currentTarget.style.color="#333")}>×</span>
                        </div>
                      ))
                  )}
                </div>

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

                      {attempts.length > 0 && (
                        <div className="detail-section">
                          <div className="detail-label">Delivery Attempts</div>
                          <div className="attempts-list">
                            {attempts.map(a => (
                              <div key={a.id} className="attempt-row">
                                <div className="attempt-dot" style={{
                                  background: a.error ? "#f87171" : a.status_code && parseInt(a.status_code) < 300 ? "#4ade80" : "#fb923c"
                                }} />
                                <span style={{color: a.error ? "#f87171" : a.status_code && parseInt(a.status_code) < 300 ? "#4ade80" : "#fb923c"}}>
                                  {a.error ? "Error" : a.status_code}
                                </span>
                                <span style={{color: "#555", flex: 1}} >{a.destination_url}</span>
                                <span style={{color: "#444"}}>{a.duration_ms ? `${a.duration_ms}ms` : "—"}</span>
                                <span style={{color: "#444"}}>{timeAgo(a.attempted_at)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="replay-section">
                        <div className="detail-label" style={{marginBottom: 12}}>Replay</div>
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
                              <span style={{color: "#f87171"}}>Error: {replayResult.error}</span>
                            ) : (
                              <>
                                <span style={{color: "#4ade80"}}>{replayResult.status_code}</span>
                                <span style={{color: "#555", margin: "0 8px"}}>·</span>
                                <span style={{color: "#555"}}>{replayResult.duration_ms}ms</span>
                                <div style={{marginTop: 8, color: "#888"}}>{replayResult.response_body?.slice(0, 200)}</div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
