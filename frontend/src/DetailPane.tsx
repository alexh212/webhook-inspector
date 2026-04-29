import { useState, useEffect, useCallback } from "react";
import type { RequestDetail, ReplayResult, DeliveryAttempt } from "./types";
import { apiFetch, timeAgo, formatJson, isValidUrl } from "./utils";
import { DEFAULT_REPLAY_URL, parseReplayError, REPLAY_405_HINT, REPLAY_PRESETS } from "./onboardingCopy";

interface Props {
  requestId: string | null;
  onError: (msg: string) => void;
}

type Tab = "overview" | "headers" | "replay" | "history";

export default function DetailPane({ requestId, onError }: Props) {
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [replayUrl, setReplayUrl] = useState(DEFAULT_REPLAY_URL);
  const [replayBody, setReplayBody] = useState<string | null>(null);
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [attempts, setAttempts] = useState<DeliveryAttempt[]>([]);

  const loadAttempts = useCallback((id: string) => {
    apiFetch(`/api/requests/${id}/attempts`)
      .then(r => r.json())
      .then(setAttempts)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!requestId) { setDetail(null); return; }
    setLoading(true);
    setDetail(null);
    setTab("overview");
    setReplayResult(null);
    setAttempts([]);
    apiFetch(`/api/requests/${requestId}`)
      .then(r => r.json())
      .then(data => { setDetail(data); setReplayBody(data.body); })
      .catch(e => onError(`Failed to load request: ${e.message}`))
      .finally(() => setLoading(false));
  }, [requestId, onError]);

  useEffect(() => {
    if (!requestId) return;
    loadAttempts(requestId);
    const interval = setInterval(() => loadAttempts(requestId), 5000);
    return () => clearInterval(interval);
  }, [requestId, loadAttempts]);

  const replay = async () => {
    if (!detail) return;
    if (!isValidUrl(replayUrl)) {
      onError("Invalid replay URL. Must be a valid http:// or https:// URL.");
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
    } catch (e) {
      onError(`Replay failed: ${parseReplayError(e instanceof Error ? e.message : String(e))}`);
    } finally {
      setReplaying(false);
    }
  };

  if (!requestId) return <div className="detail-empty">Select a request to inspect</div>;
  if (loading) return <div className="detail-empty">Loading...</div>;
  if (!detail) return <div className="detail-empty">Failed to load</div>;

  const replayUrlValid = isValidUrl(replayUrl);

  return (
    <div className="detail">
      <div className="detail-tabs-bar">
        {(["overview", "headers", "replay", "history"] as Tab[]).map(t => (
          <button
            key={t}
            className={`detail-tab ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "history" && attempts.length > 0 ? `History (${attempts.length})` : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className="detail-scroll">
        {tab === "overview" && (
          <>
            <div className="detail-meta-row">
              <div>
                <div className="detail-label">Method</div>
                <span className={`method method-${detail.method}`}>{detail.method}</span>
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
          </>
        )}

        {tab === "headers" && (
          <div className="detail-section">
            <table className="kv-table">
              <tbody>
                {Object.entries(detail.headers).map(([k, v]) => (
                  <tr key={k}><td>{k}</td><td>{String(v)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "replay" && (
          <>
            <div className="replay-hint">
              Sends with the original method ({detail.method}). Localhost is blocked — use a public URL or tunnel.
            </div>
            <div className="preset-row">
              {REPLAY_PRESETS.map(p => (
                <button key={p.url} className="preset-chip" onClick={() => setReplayUrl(p.url)} title={p.hint}>
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
              <div className="replay-url-error">Enter a valid http:// or https:// URL</div>
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
                  <span className="replay-error-text">Error: {replayResult.error}</span>
                ) : (
                  <>
                    <span className={parseInt(replayResult.status_code, 10) < 400 ? "status-ok" : "status-bad"}>
                      {replayResult.status_code}
                    </span>
                    <span className="replay-sep">·</span>
                    <span className="replay-dur">{replayResult.duration_ms}ms</span>
                    {replayResult.status_code === "405" && (
                      <div className="replay-405-hint">{REPLAY_405_HINT}</div>
                    )}
                    <div className="replay-response-body">{replayResult.response_body?.slice(0, 200)}</div>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {tab === "history" && (
          attempts.length === 0 ? (
            <div className="attempts-empty">No delivery attempts yet.</div>
          ) : (
            <div className="attempts-list">
              {attempts.map(a => {
                const s = a.error ? "error" : a.status_code && parseInt(a.status_code) < 300 ? "ok" : "warn";
                return (
                  <div key={a.id} className="attempt-row">
                    <div className={`attempt-dot attempt-dot-${s}`} />
                    <span className={`attempt-text-${s}`}>{a.error ? "Error" : a.status_code}</span>
                    <span className="attempt-url">{a.destination_url}</span>
                    <span className="attempt-faint">{a.duration_ms ? `${a.duration_ms}ms` : "—"}</span>
                    <span className="attempt-faint">{timeAgo(a.attempted_at)}</span>
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>
    </div>
  );
}
