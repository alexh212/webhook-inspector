import { useState, useEffect, useRef } from "react";

import { timeAgo, METHOD_COLOR, formatJson, hmacSign, GITHUB_PROFILE_URL, type Theme } from "./utils";
import {
  DEFAULT_REPLAY_URL,
  REPLAY_405_HINT,
  REPLAY_PRESETS,
  WEBHOOK_EXPLAINER,
  WEBHOOK_ONELINER,
} from "./onboardingCopy";

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";
const DEMO_SESSION = "demo-session-webhookinspector-public";

type LiveRequest = {
  id: string;
  method: string;
  content_type: string;
  source_ip: string;
  received_at: string;
  body?: string;
  headers?: Record<string, string>;
};

const DEMO_PAYLOADS = [
  { method: "POST", body: { event: "sms.received", from: "+1234567890", to: "+0987654321", body: "Hello from Twilio!", message_sid: "SM123abc", num_media: "0" } },
  { method: "POST", body: { event: "push", repository: { name: "my-repo", owner: "octocat" }, ref: "refs/heads/main", commits: [{ id: "abc123", message: "Update README", author: { name: "octocat" } }], pusher: { name: "octocat" } } },
  { method: "POST", body: { event: "error.occurred", service: "auth", error_code: "INVALID_TOKEN", message: "JWT expired", timestamp: "2025-03-16T12:34:56Z" } },
  { method: "GET", body: null },
  { method: "POST", body: { event: "customer.created", id: "cus_456", email: "alex@example.com" } },
  { method: "POST", body: { action: "user.created", user: { id: 1001, name: "John Doe", email: "john@example.com", role: "member" } } },
  { method: "POST", body: { action: "ping", timestamp: "2025-03-16T10:00:00Z" } },
  { method: "POST", body: { event: "payment_intent.succeeded", id: "pi_123abc", amount: 2500, currency: "eur", customer: "cus_xyz789", payment_method: "pm_card_visa" } },
  { method: "DELETE", body: { action: "item.removed", item_id: "item_890", reason: "out_of_stock" } },
  { method: "POST", body: { event: "payment.succeeded", amount: 9900, customer: "cus_stripe123", currency: "usd" } },
  { method: "POST", body: { event: "invoice.payment_failed", invoice_id: "in_789ghi", customer: "cus_xyz789", attempt_count: 3, next_payment_attempt: "2025-03-17T10:00:00Z" } },
  { method: "POST", body: { event: "charge.failed", code: "insufficient_funds", amount: 4900 } },
  { method: "POST", body: { event: "invoice.paid", amount_due: 19900, status: "paid" } },
  { method: "PUT", body: { action: "product.updated", product_id: "prod_567", changes: { price: 2999, stock: 50 } } },
  { method: "PATCH", body: { id: 99, fields: { email: "new@example.com" } } },
  { method: "POST", body: { event: "customer.subscription.deleted", subscription_id: "sub_456def", customer: "cus_abc123", plan: "premium", cancel_at_period_end: true } },
  { method: "PUT", body: { id: 42, status: "active" } },
  { method: "POST", body: { event: "order.created", order_id: "ORD-12345", customer: { id: "cus_001", email: "buyer@example.com" }, items: [{ sku: "SKU123", name: "Widget", quantity: 2, price: 1500 }], total: 7900 } },
  { method: "POST", body: { event: "pull_request", action: "opened", pull_request: { number: 42, title: "Fix bug", state: "open" }, repository: { name: "my-repo" }, sender: { login: "contributor" } } },
  { method: "GET", body: null },
  { method: "DELETE", body: null },
  { method: "PUT", body: { event: "subscription.updated", plan: "pro", interval: "monthly" } },
  { method: "POST", body: { event: "message", type: "message", channel: "C123456", user: "U789", text: "Hello, world!", ts: "1678901234.567" } },
];

export default function Landing({ onEnter, theme, toggleTheme }: { onEnter: () => void; theme: Theme; toggleTheme: () => void }) {
  const [requests, setRequests] = useState<LiveRequest[]>([]);
  const [endpointId, setEndpointId] = useState<string | null>(null);
  const [selected, setSelected] = useState<LiveRequest | null>(null);
  const [curlCopied, setCurlCopied] = useState(false);
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");
  const [replayUrl, setReplayUrl] = useState(DEFAULT_REPLAY_URL);
  const [replayResult, setReplayResult] = useState<{ status_code: string; duration_ms: string; response_body?: string; error: string | null } | null>(null);
  const [replaying, setReplaying] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const secretRef = useRef<string>("");
  const endpointIdRef = useRef<string | null>(null);
  const payloadIdx = useRef(0);

  useEffect(() => {
    const init = async () => {
      try {
        const res = await fetch(`${API}/api/endpoints`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-session-id": DEMO_SESSION },
          body: JSON.stringify({ name: "live-demo" }),
        });
        if (!res.ok) { setStatus("error"); return; }
        const ep = await res.json();
        setEndpointId(ep.id);
        endpointIdRef.current = ep.id;
        if (ep.secret) secretRef.current = ep.secret;
        const ws = new WebSocket(`${API.replace("http", "ws")}/ws/endpoints/${ep.id}?session_id=${DEMO_SESSION}`);
        wsRef.current = ws;
        ws.onopen = () => setStatus("live");
        ws.onmessage = (event) => {
          try {
            const req = JSON.parse(event.data);
            setRequests(prev => [req, ...prev]);
          } catch { /* ignore */ }
        };
        ws.onerror = () => setStatus("error");
      } catch { setStatus("error"); }
    };
    init();
    return () => {
      wsRef.current?.close();
      if (endpointIdRef.current) {
        fetch(`${API}/api/endpoints/${endpointIdRef.current}`, {
          method: "DELETE",
          headers: { "x-session-id": DEMO_SESSION },
        }).catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    if (!endpointId || status !== "live") return;
    const fire = async () => {
      const payload = DEMO_PAYLOADS[payloadIdx.current % DEMO_PAYLOADS.length];
      payloadIdx.current++;
      const bodyStr = payload.body ? JSON.stringify(payload.body) : "";
      const headers: Record<string, string> = {};
      if (payload.body) headers["Content-Type"] = "application/json";
      if (secretRef.current) {
        headers["x-webhook-signature"] = await hmacSign(secretRef.current, bodyStr);
      }
      try {
        await fetch(`${API}/hooks/${endpointId}`, {
          method: payload.method,
          headers,
          body: payload.body ? bodyStr : undefined,
        });
      } catch { /* ignore on demo */ }
    };
    fire();
    const interval = setInterval(fire, 3500);
    return () => clearInterval(interval);
  }, [endpointId, status]);

  const selectRequest = async (r: LiveRequest) => {
    try {
      const res = await fetch(`${API}/api/requests/${r.id}`, { headers: { "x-session-id": DEMO_SESSION } });
      if (!res.ok) return;
      const detail = await res.json();
      setSelected({ ...r, body: detail.body, headers: detail.headers });
      setReplayResult(null);
    } catch { /* ignore */ }
  };

  const replay = async () => {
    if (!selected) return;
    setReplaying(true);
    setReplayResult(null);
    try {
      const res = await fetch(`${API}/api/requests/${selected.id}/replay`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-session-id": DEMO_SESSION },
        body: JSON.stringify({ destination_url: replayUrl }),
      });
      const data = await res.json();
      setReplayResult(data);
    } catch { setReplayResult({ status_code: "", duration_ms: "", error: "Failed" }); }
    setReplaying(false);
  };

  const curlCommand = endpointId
    ? `curl -X POST ${API}/hooks/${endpointId} \\\n  -H "Content-Type: application/json" \\\n  -d '{"event": "test"}'`
    : "";

  return (
    <>
      <div className="mobile-block">
        <div className="mobile-icon">↪</div>
        <div className="mobile-title">Relay</div>
        <div className="mobile-desc">
          This tool is designed for desktop. Open it on a larger screen to see the live demo and dashboard.
        </div>
      </div>

      <div className="desktop-only landing-page">
        <nav className="l-nav">
          <div className="nav-left">
            <span className="l-nav-logo">Relay</span>
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
          <div className="l-nav-right">
            <button className="theme-toggle" onClick={toggleTheme} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <button className="nav-btn" onClick={onEnter}>Open dashboard →</button>
          </div>
        </nav>

        <div className="l-hero">
          <div className="l-hero-inner">
            <div className="l-hero-copy">
              <h1 className="l-h1">Inspect, replay,<br />and debug<br />webhooks.</h1>
              <p className="l-sub">Point any webhook at your endpoint. See every request instantly, inspect the full payload, and replay it to your server whenever you need.</p>
              <div className="l-webhook-intro">
                <div className="l-webhook-intro-title">What&apos;s a webhook?</div>
                        <div className="l-webhook-intro-body">
                          <strong className="l-webhook-intro-strong">{WEBHOOK_ONELINER}</strong>{" "}
                          {WEBHOOK_EXPLAINER}
                        </div>
              </div>
              <button className="l-cta" onClick={onEnter}>Get started →</button>
              <div className="l-features">
                {[
                  { title: "Real-time feed", desc: "Requests appear instantly via WebSocket. No polling, no refresh." },
                  { title: "Full inspection", desc: "Headers, body, query params, source IP — everything captured and stored." },
                  { title: "Replay & retry", desc: "Re-fire any request to your server. Edit the body first. Auto-retry on failure with exponential backoff." },
                ].map(f => (
                  <div key={f.title}>
                    <div className="l-feature-title">{f.title}</div>
                    <div className="l-feature-desc">{f.desc}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="l-demo">
              <div className="l-demo-window">
                <div className="l-demo-bar">
                  <span className="l-demo-count">
                    {requests.length} request{requests.length !== 1 ? "s" : ""} — <span className={status === "live" ? "ws-live" : "ws-offline"}>● live</span>
                  </span>
                </div>

                <div className="l-demo-body">
                  <div className="l-feed">
                    <div className="l-feed-header">Incoming requests</div>
                    <div className="l-feed-list">
                      {requests.length === 0 && (
                        <div className="l-feed-connecting">
                          {status === "connecting" ? "Connecting..." : "Starting..."}
                        </div>
                      )}
                      {requests.map(r => (
                        <div
                          key={r.id}
                          className={`l-req req-item ${selected?.id === r.id ? "active" : ""}`}
                          onClick={() => selectRequest(r)}
                        >
                          <span className="l-method" style={{ color: METHOD_COLOR[r.method] || "var(--text-secondary)" }}>{r.method}</span>
                          <span className="l-time">{timeAgo(r.received_at)}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="l-detail">
                    {!selected ? (
                      <div className="l-detail-empty">← select a request</div>
                    ) : (
                      <>
                        <div className="l-meta-row">
                          <div>
                            <div className="l-meta-label">Method</div>
                            <div className="l-meta-val" style={{ color: METHOD_COLOR[selected.method] }}>{selected.method}</div>
                          </div>
                          <div>
                            <div className="l-meta-label">Received</div>
                            <div className="l-meta-val">{timeAgo(selected.received_at)}</div>
                          </div>
                          <div>
                            <div className="l-meta-label">Source IP</div>
                            <div className="l-meta-val">{selected.source_ip || "—"}</div>
                          </div>
                        </div>

                        {selected.body && (
                          <>
                            <div className="l-section-label">Body</div>
                            <div className="l-body-block">{formatJson(selected.body)}</div>
                          </>
                        )}

                        <div className="l-section-label">Replay to</div>
                        <div className="l-preset-row">
                          {REPLAY_PRESETS.map(p => (
                            <button
                              key={p.url}
                              type="button"
                              className="l-preset-chip"
                              title={p.hint}
                              onClick={() => setReplayUrl(p.url)}
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                        <div className="l-replay-row">
                          <input
                            className="l-replay-input"
                            value={replayUrl}
                            onChange={e => setReplayUrl(e.target.value)}
                            placeholder="https://your-server.com/webhook"
                          />
                          <button className="l-replay-btn" onClick={replay} disabled={replaying}>
                            {replaying ? "..." : "↩ Replay"}
                          </button>
                        </div>
                        <div className="l-replay-method-hint">
                          Replay sends the same HTTP method as this request ({selected.method}). Use /anything for any method, or match /get vs /post.
                        </div>
                        {replayResult && (
                          <div className="l-replay-result">
                            {replayResult.error ? (
                              <span className="replay-error-text">Error: {replayResult.error}</span>
                            ) : (
                              <>
                                <span className={parseInt(replayResult.status_code) < 400 ? "status-ok" : "status-bad"}>
                                  {replayResult.status_code} · {replayResult.duration_ms}ms
                                </span>
                                {replayResult.status_code === "405" && (
                                  <div className="l-replay-method-hint">
                                    {REPLAY_405_HINT}
                                  </div>
                                )}
                                {replayResult.response_body && (
                                  <div className="l-replay-response-body">
                                    {(() => { try { return JSON.stringify(JSON.parse(replayResult.response_body), null, 2); } catch { return replayResult.response_body; } })()}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {endpointId && (
                <div className="l-curl-box">
                  <div className="l-curl-header">
                    <span className="l-curl-label">Try it — fire a request at this live endpoint:</span>
                    <button className="l-curl-copy" onClick={() => { navigator.clipboard.writeText(curlCommand); setCurlCopied(true); setTimeout(() => setCurlCopied(false), 2000); }}>
                      {curlCopied ? "✓ copied" : "copy"}
                    </button>
                  </div>
                  <pre className="l-curl-code">{curlCommand}</pre>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="l-how">
          <div className="l-how-title">How it works</div>
          <div className="l-how-steps">
            {[
              { num: "01", title: "Create an endpoint", desc: "Relay gives you a unique public URL — no account, no login required." },
              { num: "02", title: "Point your webhook at it", desc: "Configure Stripe, GitHub, Shopify, or any service to send events to your URL." },
              { num: "03", title: "Inspect and replay", desc: "Every request appears instantly. See full headers, body, and query params. Replay to your server whenever you need." },
            ].map(s => (
              <div key={s.num} className="l-how-step">
                <div className="l-how-step-num">{s.num}</div>
                <div className="l-how-step-title">{s.title}</div>
                <div className="l-how-step-desc">{s.desc}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="l-usecases">
          <div className="l-usecases-title">Use cases</div>
          <div className="l-usecases-grid">
            {[
              { title: "Payment webhooks", desc: "Stripe, Paddle, or Braintree firing events to your server. See exactly what payload arrived, replay it against your local handler to debug edge cases." },
              { title: "CI/CD pipelines", desc: "GitHub, GitLab, or Bitbucket sending push events. Inspect the full payload structure before writing your integration code." },
              { title: "E-commerce events", desc: "Shopify order.created or fulfillment.updated webhooks. Capture them all, replay the tricky ones against your processing logic." },
              { title: "Alerting systems", desc: "PagerDuty, Datadog, or custom alerting pipelines. See every alert payload in real time and test your response handlers safely." },
              { title: "Local development", desc: "Your server is running locally and can't receive webhooks directly. Point the webhook at Relay and replay it to localhost." },
              { title: "Debugging failures", desc: "A webhook fired at 3am and your server was down. The request is saved. Replay it once your server is back up — no data lost." },
            ].map(u => (
              <div key={u.title} className="l-usecase">
                <div className="l-usecase-title">{u.title}</div>
                <div className="l-usecase-desc">{u.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
