/** Default replay destination: accepts any HTTP method (good for trying the feature). */
export const DEFAULT_REPLAY_URL = "https://httpbin.org/anything";

export const WEBHOOK_ONELINER =
  "A webhook is an HTTP request a service sends to your URL when something happens.";

export const WEBHOOK_EXPLAINER_SHORT =
  "Point Stripe, GitHub, or any provider at your hook URL below. Relay captures each request so you can inspect headers and body, then replay it to another server for testing.";

export const WEBHOOK_EXPLAINER =
  "When an external service has an event for you—payment succeeded, repo pushed, form submitted—it sends an HTTP request to a URL you configure. Relay gives you that URL, stores every delivery, and lets you forward (replay) a copy elsewhere for debugging.";

export const REPLAY_TIPS: string[] = [
  "Replay uses the same HTTP method as the captured request (GET stays GET, POST stays POST). Pick a destination that allows that method.",
  "Do not use localhost as the replay URL—Relay blocks private addresses for security. Use a public URL, or expose your machine with a tunnel (ngrok, Cloudflare Tunnel) and paste that HTTPS URL.",
];

export type ReplayPreset = { label: string; url: string; hint?: string };

export const REPLAY_PRESETS: ReplayPreset[] = [
  {
    label: "httpbin /anything",
    url: "https://httpbin.org/anything",
    hint: "Echoes any method—easiest way to try replay.",
  },
  {
    label: "httpbin /get",
    url: "https://httpbin.org/get",
    hint: "For GET captures only.",
  },
  {
    label: "httpbin /post",
    url: "https://httpbin.org/post",
    hint: "For POST captures only.",
  },
];

export const REPLAY_405_HINT =
  "This status often means the destination does not allow this request’s HTTP method (e.g. GET to a POST-only URL). Try https://httpbin.org/anything or match method to the path.";

const BLOCKED_HINT =
  "Private addresses (like localhost) are blocked. Use a public URL or a tunnel URL (ngrok, Cloudflare Tunnel).";

/** Turn fetch error bodies like `{"detail":"..."}` into readable toasts. */
export function parseReplayError(message: string): string {
  const trimmed = message.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { detail?: unknown };
      const detail = parsed.detail;
      const text =
        typeof detail === "string"
          ? detail
          : Array.isArray(detail)
            ? detail.map((d) => (typeof d === "object" && d && "msg" in d ? String((d as { msg: string }).msg) : String(d))).join("; ")
            : null;
      if (text) {
        if (/blocked address|private|127\.|::1/i.test(text)) return BLOCKED_HINT;
        if (/Cannot resolve hostname/i.test(text)) return `${text} Check the URL or your network.`;
        return text;
      }
    } catch {
      /* fall through */
    }
  }
  if (/blocked address|Destination resolves to blocked/i.test(message)) return BLOCKED_HINT;
  return message;
}
