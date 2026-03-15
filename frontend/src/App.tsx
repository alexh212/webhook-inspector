import { useState, useEffect } from "react";

const API = "http://localhost:8000";

type Endpoint = { id: string; name: string; created_at: string };
type CapturedRequest = { id: string; method: string; content_type: string; source_ip: string; received_at: string };

function timeAgo(date: string) {
  const seconds = Math.floor((Date.now() - new Date(date + "Z").getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

const METHOD_COLOR: Record<string, string> = {
  GET: "#4ade80", POST: "#60a5fa", PUT: "#fb923c", DELETE: "#f87171", PATCH: "#c084fc"
};

export default function App() {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [selected, setSelected] = useState<Endpoint | null>(null);
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [newName, setNewName] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/endpoints`).then(r => r.json()).then(setEndpoints);
  }, []);

  useEffect(() => {
    if (!selected) return;
    const load = () => fetch(`${API}/api/endpoints/${selected.id}/requests`).then(r => r.json()).then(setRequests);
    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
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
    setNewName("");
  };

  const hookUrl = selected ? `http://localhost:8000/hooks/${selected.id}` : "";

  const copyUrl = () => {
    navigator.clipboard.writeText(hookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0a0a0a; color: #ededed; font-family: 'Inter', sans-serif; -webkit-font-smoothing: antialiased; }

        .layout { display: flex; height: 100vh; }

        .sidebar {
          width: 240px; flex-shrink: 0; border-right: 1px solid #1a1a1a;
          display: flex; flex-direction: column;
        }

        .sidebar-header {
          padding: 20px 16px 16px;
          border-bottom: 1px solid #1a1a1a;
        }

        .logo { font-size: 13px; font-weight: 600; color: #ededed; letter-spacing: -0.3px; margin-bottom: 14px; }

        .input-row { display: flex; gap: 6px; }

        .ep-input {
          flex: 1; height: 32px; background: #111; border: 1px solid #222;
          border-radius: 6px; padding: 0 10px; font-size: 12px;
          font-family: 'Inter', sans-serif; color: #ededed; outline: none;
          transition: border-color 0.15s;
        }
        .ep-input::placeholder { color: #444; }
        .ep-input:focus { border-color: #444; }

        .add-btn {
          height: 32px; width: 32px; background: #ededed; color: #0a0a0a;
          border: none; border-radius: 6px; font-size: 16px; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          font-weight: 500; transition: background 0.15s; flex-shrink: 0;
        }
        .add-btn:hover { background: #d4d4d4; }

        .ep-list { flex: 1; overflow-y: auto; padding: 8px; }

        .ep-item {
          padding: 8px 10px; border-radius: 6px; cursor: pointer;
          border: 1px solid transparent; margin-bottom: 2px; transition: all 0.15s;
        }
        .ep-item:hover { background: #111; }
        .ep-item.active { background: #111; border-color: #333; }
        .ep-name { font-size: 12px; color: #ededed; font-weight: 500; }
        .ep-id { font-size: 10px; color: #444; margin-top: 2px; font-family: monospace; }

        .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

        .main-header {
          padding: 20px 28px; border-bottom: 1px solid #1a1a1a;
          display: flex; align-items: center; justify-content: space-between;
        }

        .hook-label { font-size: 11px; color: #555; margin-bottom: 4px; }
        .hook-url { font-size: 12px; color: #888; font-family: monospace; }

        .copy-btn {
          height: 30px; padding: 0 14px; background: transparent; border: 1px solid #222;
          border-radius: 6px; color: #888; font-size: 11px; font-family: 'Inter', sans-serif;
          cursor: pointer; transition: all 0.15s;
        }
        .copy-btn:hover { border-color: #444; color: #ededed; }

        .feed { flex: 1; overflow-y: auto; padding: 20px 28px; }

        .feed-meta { font-size: 11px; color: #444; margin-bottom: 16px; }

        .empty {
          border: 1px dashed #1a1a1a; border-radius: 8px;
          padding: 40px; text-align: center; color: #333; font-size: 12px;
        }

        .req-row {
          display: flex; align-items: center; gap: 14px;
          padding: 10px 14px; margin-bottom: 6px;
          background: #111; border: 1px solid #1a1a1a;
          border-radius: 8px; transition: border-color 0.15s; cursor: pointer;
        }
        .req-row:hover { border-color: #2a2a2a; }

        .method { font-size: 11px; font-weight: 600; font-family: monospace; min-width: 48px; }
        .req-type { font-size: 12px; color: #555; flex: 1; }
        .req-ip { font-size: 11px; color: #333; }
        .req-time { font-size: 11px; color: #444; }

        .empty-state {
          flex: 1; display: flex; align-items: center; justify-content: center;
          flex-direction: column; gap: 8px; color: #333;
        }
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
                <div className="ep-name">{ep.name}</div>
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
              <div className="feed">
                <div className="feed-meta">{requests.length} request{requests.length !== 1 ? "s" : ""} — polling every 3s</div>
                {requests.length === 0 ? (
                  <div className="empty">No requests yet. Fire a curl at the URL above.</div>
                ) : (
                  requests.map(r => (
                    <div key={r.id} className="req-row">
                      <span className="method" style={{ color: METHOD_COLOR[r.method] || "#888" }}>{r.method}</span>
                      <span className="req-type">{r.content_type || "no content-type"}</span>
                      <span className="req-ip">{r.source_ip}</span>
                      <span className="req-time">{timeAgo(r.received_at)}</span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
