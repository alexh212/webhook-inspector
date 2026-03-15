import { useState, useEffect, useRef } from "react";

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
  {
    method: "POST",
    body: {
      event: "sms.received",
      from: "+1234567890",
      to: "+0987654321",
      body: "Hello from Twilio!",
      message_sid: "SM123abc",
      num_media: "0"
    }
  },
  {
    method: "POST",
    body: {
      event: "push",
      repository: { name: "my-repo", owner: "octocat" },
      ref: "refs/heads/main",
      commits: [
        { id: "abc123", message: "Update README", author: { name: "octocat", email: "octocat@github.com" } }
      ],
      pusher: { name: "octocat" }
    }
  },
  {
    method: "POST",
    body: {
      event: "error.occurred",
      service: "auth",
      error_code: "INVALID_TOKEN",
      message: "JWT expired",
      timestamp: "2025-03-16T12:34:56Z"
    }
  },
  { method: "GET", body: null },
  {
    method: "POST",
    body: { event: "customer.created", id: "cus_456", email: "alex@example.com" }
  },
  {
    method: "POST",
    body: {
      action: "user.created",
      user: { id: 1001, name: "John Doe", email: "john@example.com", role: "member" }
    }
  },
  {
    method: "POST",
    body: { action: "ping", timestamp: "2025-03-16T10:00:00Z" }
  },
  {
    method: "POST",
    body: {
      event: "payment_intent.succeeded",
      id: "pi_123abc",
      amount: 2500,
      currency: "eur",
      customer: "cus_xyz789",
      payment_method: "pm_card_visa"
    }
  },
  {
    method: "DELETE",
    body: {
      action: "item.removed",
      item_id: "item_890",
      reason: "out_of_stock"
    }
  },
  {
    method: "POST",
    body: { event: "payment.succeeded", amount: 9900, customer: "cus_stripe123", currency: "usd" }
  },
  {
    method: "POST",
    body: {
      event: "invoice.payment_failed",
      invoice_id: "in_789ghi",
      customer: "cus_xyz789",
      attempt_count: 3,
      next_payment_attempt: "2025-03-17T10:00:00Z"
    }
  },
  {
    method: "POST",
    body: { event: "charge.failed", code: "insufficient_funds", amount: 4900 }
  },
  {
    method: "POST",
    body: { event: "invoice.paid", amount_due: 19900, status: "paid" }
  },
  {
    method: "PUT",
    body: {
      action: "product.updated",
      product_id: "prod_567",
      changes: { price: 2999, stock: 50 }
    }
  },
  {
    method: "PATCH",
    body: { id: 99, fields: { email: "new@example.com" } }
  },
  {
    method: "POST",
    body: {
      event: "customer.subscription.deleted",
      subscription_id: "sub_456def",
      customer: "cus_abc123",
      plan: "premium",
      cancel_at_period_end: true
    }
  },
  {
    method: "PUT",
    body: { id: 42, status: "active" }
  },
  {
    method: "POST",
    body: {
      event: "order.created",
      order_id: "ORD-12345",
      customer: { id: "cus_001", email: "buyer@example.com" },
      items: [
        { sku: "SKU123", name: "Widget", quantity: 2, price: 1500 },
        { sku: "SKU456", name: "Gadget", quantity: 1, price: 4900 }
      ],
      total: 7900,
      shipping_address: {
        line1: "123 Main St",
        city: "Anytown",
        country: "US"
      }
    }
  },
  {
    method: "POST",
    body: {
      event: "pull_request",
      action: "opened",
      pull_request: { number: 42, title: "Fix bug", state: "open" },
      repository: { name: "my-repo", owner: "octocat" },
      sender: { login: "contributor" }
    }
  },
  { method: "GET", body: null },
  {
    method: "DELETE",
    body: null
  },
  {
    method: "PUT",
    body: { event: "subscription.updated", plan: "pro", interval: "monthly" }
  },
  {
    method: "POST",
    body: {
      event: "message",
      type: "message",
      channel: "C123456",
      user: "U789",
      text: "Hello, world!",
      ts: "1678901234.567"
    }
  }
];

const METHOD_COLOR: Record<string, string> = {
  GET: "#4ade80", POST: "#60a5fa", PUT: "#fb923c", DELETE: "#f87171", PATCH: "#c084fc"
};

function timeAgo(date: string) {
  const seconds = Math.floor((Date.now() - new Date(date + "Z").getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function formatJson(str: string) {
  try { return JSON.stringify(JSON.parse(str), null, 2); }
  catch { return str; }
}

export default function Landing({ onEnter }: { onEnter: () => void }) {
  const [requests, setRequests] = useState<LiveRequest[]>([]);
  const [endpointId, setEndpointId] = useState<string | null>(null);
  const [selected, setSelected] = useState<LiveRequest | null>(null);
  const [curlCopied, setCurlCopied] = useState(false);
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");
  const [replayUrl, setReplayUrl] = useState("https://httpbin.org/post");
  const [replayResult, setReplayResult] = useState<{status_code: string; duration_ms: string; response_body?: string; error: string | null} | null>(null);
  const [replaying, setReplaying] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const payloadIdx = useRef(0);

  useEffect(() => {
    const init = async () => {
      try {
        const res = await fetch(`${API}/api/endpoints`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-session-id": DEMO_SESSION },
          body: JSON.stringify({ name: "live-demo" }),
        });
        const ep = await res.json();
        setEndpointId(ep.id);
        const ws = new WebSocket(`${API.replace("http", "ws")}/ws/endpoints/${ep.id}?session_id=${DEMO_SESSION}`);
        wsRef.current = ws;
        ws.onopen = () => setStatus("live");
        ws.onmessage = (event) => {
          const req = JSON.parse(event.data);
          setRequests(prev => [req, ...prev]);
        };
        ws.onerror = () => setStatus("error");
      } catch { setStatus("error"); }
    };
    init();
    return () => wsRef.current?.close();
  }, []);

  useEffect(() => {
    if (!endpointId || status !== "live") return;
    const fire = async () => {
      const payload = DEMO_PAYLOADS[payloadIdx.current % DEMO_PAYLOADS.length];
      payloadIdx.current++;
      await fetch(`${API}/hooks/${endpointId}`, {
        method: payload.method,
        headers: payload.body ? { "Content-Type": "application/json" } : {},
        body: payload.body ? JSON.stringify(payload.body) : undefined,
      });
    };
    fire();
    const interval = setInterval(fire, 3500);
    return () => clearInterval(interval);
  }, [endpointId, status]);

  const selectRequest = async (r: LiveRequest) => {
    const res = await fetch(`${API}/api/requests/${r.id}`, {
      headers: { "x-session-id": DEMO_SESSION }
    });
    const detail = await res.json();
    setSelected({ ...r, body: detail.body, headers: detail.headers });
    setReplayResult(null);
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
    ? `curl -X POST ${API}/hooks/${endpointId} \\\n  -H "Content-Type: application/json" \\\n  -d '{"event": "test", "from": "you"}'`
    : "";

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0a0a0a; }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.4} }
        .req-item { animation: fadeUp 0.25s ease forwards; }
        .live-pulse { animation: pulse 2s infinite; }
        .landing-page { background: #0a0a0a; color: #ededed; min-height: 100vh; font-family: 'Inter', sans-serif; -webkit-font-smoothing: antialiased; }

        .l-nav { position: sticky; top: 0; z-index: 100; border-bottom: 1px solid #1a1a1a; padding: 0 32px; height: 52px; display: flex; align-items: center; justify-content: space-between; background: rgba(10,10,10,0.9); backdrop-filter: blur(12px); }
        .l-nav-logo { font-size: 13px; font-weight: 600; letter-spacing: -0.3px; color: #ededed; }
        .l-nav-btn { height: 30px; padding: 0 14px; background: transparent; border: 1px solid #222; border-radius: 6px; color: #888; font-size: 11px; font-family: 'Inter', sans-serif; cursor: pointer; transition: all 0.15s; }
        .l-nav-btn:hover { border-color: #444; color: #ededed; }

        .l-hero { max-width: 1100px; margin: 0 auto; padding: 80px 32px 60px; }
        .l-hero-inner { display: flex; align-items: flex-start; gap: 80px; }
        .l-hero-copy { flex: 0 0 360px; padding-top: 8px; }
        .l-badge { display: inline-block; font-size: 11px; color: #444; border: 1px solid #1a1a1a; border-radius: 20px; padding: 3px 12px; margin-bottom: 20px; letter-spacing: 0.04em; }
        .l-h1 { font-size: 40px; font-weight: 600; letter-spacing: -1.2px; line-height: 1.1; color: #ededed; margin-bottom: 16px; }
        .l-sub { font-size: 14px; color: #555; line-height: 1.7; margin-bottom: 28px; }
        .l-cta { height: 38px; padding: 0 20px; background: #ededed; color: #0a0a0a; border: none; border-radius: 7px; font-size: 13px; font-weight: 600; font-family: 'Inter', sans-serif; cursor: pointer; transition: background 0.15s; margin-bottom: 44px; }
        .l-cta:hover { background: #d4d4d4; }
        .l-features { display: flex; flex-direction: column; gap: 18px; }
        .l-feature-title { font-size: 12px; font-weight: 500; color: #888; margin-bottom: 2px; }
        .l-feature-desc { font-size: 11px; color: #333; line-height: 1.6; }

        .l-demo { flex: 1; min-width: 0; }
        .l-demo-window { background: #0d0d0d; border: 1px solid #1a1a1a; border-radius: 10px; overflow: hidden; }
        .l-demo-bar { padding: 10px 14px; border-bottom: 1px solid #1a1a1a; display: flex; align-items: center; gap: 10px; }
        .l-demo-dots { display: flex; gap: 5px; }
        .l-demo-dot { width: 9px; height: 9px; border-radius: 50%; background: #222; }
        .l-demo-title { flex: 1; font-size: 10px; color: #333; font-family: monospace; text-align: center; }
        .l-status { display: flex; align-items: center; gap: 5px; font-size: 10px; }

        .l-demo-body { display: flex; height: 380px; }
        .l-feed { width: 220px; flex-shrink: 0; border-right: 1px solid #1a1a1a; display: flex; flex-direction: column; }
        .l-feed-header { padding: 10px 12px 8px; font-size: 9px; color: #333; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1px solid #111; }
        .l-feed-list { flex: 1; overflow-y: auto; padding: 8px; max-height: 320px; }
        .l-req { display: flex; align-items: center; gap: 8px; padding: 6px 8px; margin-bottom: 2px; border-radius: 5px; cursor: pointer; border: 1px solid transparent; transition: all 0.12s; }
        .l-req:hover { background: #111; }
        .l-req.active { background: #111; border-color: #222; }
        .l-method { font-size: 10px; font-weight: 600; font-family: monospace; min-width: 30px; }
        .l-time { font-size: 10px; color: #333; }

        .l-detail { flex: 1; overflow-y: auto; padding: 14px; min-width: 0; height: 100%; }
        .l-detail-empty { height: 100%; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #222; }
        .l-meta-row { display: flex; gap: 16px; margin-bottom: 14px; flex-wrap: wrap; }
        .l-meta-label { font-size: 9px; color: "#333"; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 3px; color: #333; }
        .l-meta-val { font-size: 11px; font-family: monospace; color: #ededed; }
        .l-section-label { font-size: 9px; color: #333; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; }
        .l-body-block { background: #111; border: 1px solid #1a1a1a; border-radius: 4px; padding: 10px; font-size: 10px; font-family: monospace; color: #888; white-space: pre-wrap; line-height: 1.6; max-height: 100px; overflow-y: auto; margin-bottom: 12px; }
        .l-replay-row { display: flex; gap: 6px; align-items: center; }
        .l-replay-input { flex: 1; height: 26px; background: #111; border: 1px solid #1a1a1a; border-radius: 4px; padding: 0 8px; font-size: 10px; font-family: monospace; color: #888; outline: none; min-width: 0; }
        .l-replay-input:focus { border-color: #333; }
        .l-replay-btn { height: 26px; padding: 0 10px; background: #ededed; color: #0a0a0a; border: none; border-radius: 4px; font-size: 10px; font-weight: 600; font-family: 'Inter', sans-serif; cursor: pointer; white-space: nowrap; transition: background 0.15s; flex-shrink: 0; }
        .l-replay-btn:hover { background: #d4d4d4; }
        .l-replay-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .l-replay-result { margin-top: 8px; font-size: 10px; font-family: monospace; }

        .l-curl-box { margin-top: 10px; background: #0d0d0d; border: 1px solid #1a1a1a; border-radius: 8px; padding: 12px 14px; }
        .l-curl-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        .l-curl-label { font-size: 11px; color: #444; }
        .l-curl-copy { height: 22px; padding: 0 8px; background: transparent; border: 1px solid #1a1a1a; border-radius: 4px; color: #444; font-size: 10px; font-family: 'Inter', sans-serif; cursor: pointer; transition: all 0.15s; }
        .l-curl-copy:hover { border-color: #333; color: #888; }
        .l-curl-code { font-size: 11px; font-family: monospace; color: #555; white-space: pre-wrap; line-height: 1.6; }

        .l-usecases { max-width: 1100px; margin: 0 auto; padding: 60px 32px 80px; border-top: 1px solid #111; }
        .l-usecases-title { font-size: 11px; color: #333; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 32px; }
        .l-usecases-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: #111; border: 1px solid #111; border-radius: 8px; overflow: hidden; }
        .l-usecase { background: #0a0a0a; padding: 24px; }
        .l-usecase-icon { font-size: 18px; margin-bottom: 10px; }
        .l-usecase-title { font-size: 13px; font-weight: 500; color: #888; margin-bottom: 6px; }
        .l-usecase-desc { font-size: 12px; color: #333; line-height: 1.6; }
      `}</style>

      <div className="landing-page">
        <nav className="l-nav">
          <span className="l-nav-logo">Webhook Inspector</span>
          <button className="l-nav-btn" onClick={onEnter}>Open dashboard →</button>
        </nav>

        <div className="l-hero">
          <div className="l-hero-inner">
            {/* Copy */}
            <div className="l-hero-copy">
              <h1 className="l-h1">Inspect, replay,<br />and debug<br />webhooks.</h1>
              <p className="l-sub">Point any webhook at your endpoint. See every request instantly, inspect the full payload, and replay it to your server whenever you need.</p>
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

            {/* Live demo */}
            <div className="l-demo">
              <div className="l-demo-window">
                <div className="l-demo-bar">
                  <span style={{ fontSize: 11, color: "#444" }}>
                    {requests.length} request{requests.length !== 1 ? "s" : ""} — <span style={{ color: status === "live" ? "#4ade80" : "#555" }}>● live</span>
                  </span>
                </div>

                <div className="l-demo-body">
                  <div className="l-feed">
                    <div className="l-feed-header">Incoming requests</div>
                    <div className="l-feed-list">
                      {requests.length === 0 && (
                        <div style={{ fontSize: 10, color: "#222", textAlign: "center", marginTop: 32 }}>
                          {status === "connecting" ? "Connecting..." : "Starting..."}
                        </div>
                      )}
                      {requests.map(r => (
                        <div
                          key={r.id}
                          className={`l-req req-item ${selected?.id === r.id ? "active" : ""}`}
                          onClick={() => selectRequest(r)}
                        >
                          <span className="l-method" style={{ color: METHOD_COLOR[r.method] || "#888" }}>{r.method}</span>
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
                        {replayResult && (
                          <div className="l-replay-result">
                            {replayResult.error ? (
                              <span style={{ color: "#f87171" }}>Error: {replayResult.error}</span>
                            ) : (
                              <>
                                <span style={{ color: parseInt(replayResult.status_code) < 400 ? "#4ade80" : "#f87171" }}>
                                  {replayResult.status_code} · {replayResult.duration_ms}ms
                                </span>
                                {replayResult.response_body && (
                                  <div style={{
                                    marginTop: 6, background: "#111", border: "1px solid #1a1a1a",
                                    borderRadius: 4, padding: "8px 10px", fontSize: 10, fontFamily: "monospace",
                                    color: "#555", whiteSpace: "pre-wrap", maxHeight: 100, overflowY: "auto"
                                  }}>
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

              {/* Try it yourself */}
              {endpointId && (
                <div className="l-curl-box">
                  <div className="l-curl-header">
                    <span className="l-curl-label">Fire your own request at this live endpoint:</span>
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

        {/* Use cases */}
        <div className="l-usecases">
          <div className="l-usecases-title">Use cases</div>
          <div className="l-usecases-grid">
            {[
              { icon: "💳", title: "Payment webhooks", desc: "Stripe, Paddle, or Braintree firing events to your server. See exactly what payload arrived, replay it against your local handler to debug edge cases." },
              { icon: "🔁", title: "CI/CD pipelines", desc: "GitHub, GitLab, or Bitbucket sending push events. Inspect the full payload structure before writing your integration code." },
              { icon: "📦", title: "E-commerce events", desc: "Shopify order.created or fulfillment.updated webhooks. Capture them all, replay the tricky ones against your processing logic." },
              { icon: "🔔", title: "Alerting systems", desc: "PagerDuty, Datadog, or custom alerting pipelines. See every alert payload in real time and test your response handlers safely." },
              { icon: "🔧", title: "Local development", desc: "Your server is running locally and can't receive webhooks directly. Point the webhook at WebhookInspector and replay it to localhost." },
              { icon: "🐛", title: "Debugging failures", desc: "A webhook fired at 3am and your server was down. The request is saved. Replay it once your server is back up — no data lost." },
            ].map(u => (
              <div key={u.title} className="l-usecase">
                <div className="l-usecase-icon">{u.icon}</div>
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
