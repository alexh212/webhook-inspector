import { useState, useEffect, useRef } from "react";
import { API, timeAgo, formatJson, hmacSign } from "./utils";

const DEMO_SESSION = "demo-session-webhookinspector-public";

const DEMO_PAYLOADS = [
  { method: "POST", body: { event: "payment.succeeded", amount: 9900, currency: "usd", customer: "cus_stripe123" } },
  { method: "POST", body: { event: "push", repository: { name: "my-repo" }, ref: "refs/heads/main", pusher: { name: "octocat" } } },
  { method: "POST", body: { event: "customer.created", id: "cus_456", email: "alex@example.com" } },
  { method: "GET", body: null },
  { method: "POST", body: { event: "invoice.paid", amount_due: 19900, status: "paid" } },
  { method: "DELETE", body: { action: "item.removed", item_id: "item_890" } },
  { method: "POST", body: { event: "pull_request", action: "opened", number: 42, title: "Fix bug" } },
  { method: "POST", body: { event: "charge.failed", code: "insufficient_funds", amount: 4900 } },
];

type DemoRequest = { id: string; method: string; received_at: string; body?: string };

export default function Demo() {
  const [requests, setRequests] = useState<DemoRequest[]>([]);
  const [latestBody, setLatestBody] = useState<string | null>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");
  const endpointIdRef = useRef<string | null>(null);
  const secretRef = useRef<string>("");
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
        if (!res.ok) { setStatus("error"); return; }
        const ep = await res.json();
        endpointIdRef.current = ep.id;
        if (ep.secret) secretRef.current = ep.secret;

        const ws = new WebSocket(`${API.replace("http", "ws")}/ws/endpoints/${ep.id}?session_id=${DEMO_SESSION}`);
        wsRef.current = ws;
        ws.onopen = () => setStatus("live");
        ws.onmessage = (event) => {
          try {
            const req = JSON.parse(event.data);
            setRequests(prev => [req, ...prev].slice(0, 8));
            fetch(`${API}/api/requests/${req.id}`, {
              headers: { "x-session-id": DEMO_SESSION },
            })
              .then(res => (res.ok ? res.json() : null))
              .then(detail => {
                if (detail && typeof detail.body === "string") setLatestBody(detail.body);
              })
              .catch(() => {});
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
    if (status !== "live" || !endpointIdRef.current) return;
    const fire = async () => {
      const payload = DEMO_PAYLOADS[payloadIdx.current % DEMO_PAYLOADS.length];
      payloadIdx.current++;
      const bodyStr = payload.body ? JSON.stringify(payload.body) : "";
      const headers: Record<string, string> = {};
      if (payload.body) headers["Content-Type"] = "application/json";
      if (secretRef.current) headers["x-webhook-signature"] = await hmacSign(secretRef.current, bodyStr);
      try {
        await fetch(`${API}/hooks/${endpointIdRef.current}`, {
          method: payload.method,
          headers,
          body: payload.body ? bodyStr : undefined,
        });
      } catch { /* ignore */ }
    };
    fire();
    const interval = setInterval(fire, 3500);
    return () => clearInterval(interval);
  }, [status]);

  return (
    <div className="demo-panel">
      <div className="demo-label">
        Live demo —{" "}
        <span className={status === "live" ? "ws-live" : "ws-offline"}>
          ● {status === "live" ? "connected" : status}
        </span>
      </div>
      <div className="demo-explainer">
        <div className="demo-diagram" aria-label="Webhook flow diagram">
          <div className="demo-step">
            <div className="demo-step-title">Webhook source</div>
            <div className="demo-step-text">Stripe, GitHub, Shopify sends an event</div>
          </div>
          <div className="demo-arrow">→</div>
          <div className="demo-step">
            <div className="demo-step-title">Relay capture</div>
            <div className="demo-step-text">Store headers + body instantly</div>
          </div>
          <div className="demo-arrow">→</div>
          <div className="demo-step">
            <div className="demo-step-title">Debug fast</div>
            <div className="demo-step-text">Inspect payload and replay safely</div>
          </div>
        </div>
        <div className="demo-use-case">
          <span className="demo-use-case-label">Use case</span>
          <span>
            A payment webhook fails in production. You compare the exact payload and signature in seconds,
            then replay it to verify your fix before customers are impacted.
          </span>
        </div>
        <div className="demo-cta-line">
          Auto-updating live sample. Create endpoint to try this with your own webhook source.
        </div>
      </div>
      <div className="demo-body">
        <div className="demo-feed">
          {requests.length === 0 ? (
            <div className="demo-feed-empty">
              {status === "connecting" ? "Connecting..." : "Waiting..."}
            </div>
          ) : (
            requests.map((r, idx) => (
              <div
                key={r.id}
                className={`demo-req ${idx === 0 ? "active" : ""}`}
              >
                <span className={`method method-${r.method}`}>{r.method}</span>
                <span className="demo-time">{timeAgo(r.received_at)}</span>
              </div>
            ))
          )}
        </div>
        <div className="demo-detail">
          {!latestBody ? (
            <div className="demo-detail-empty">Latest payload appears here</div>
          ) : (
            <pre className="demo-body-pre">{formatJson(latestBody)}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
