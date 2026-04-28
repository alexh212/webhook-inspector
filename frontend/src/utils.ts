export function timeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date + "Z").getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}


export const GITHUB_PROFILE_URL = "https://github.com/alexh212";

export function formatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function hmacSign(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

export const SESSION_ID = (() => {
  let id = localStorage.getItem("wi_session_id");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("wi_session_id", id); }
  return id;
})();

export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API}${url}`, {
    ...options,
    headers: { ...(options.headers as Record<string, string>), "x-session-id": SESSION_ID },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed (${res.status})`);
  }
  return res;
}

export type Theme = "dark" | "light";

export function getStoredTheme(): Theme {
  return (localStorage.getItem("wi_theme") as Theme) || "dark";
}

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("wi_theme", theme);
}
