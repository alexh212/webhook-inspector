import { useState, useEffect, useRef, useCallback } from "react";
import type { Endpoint, DeleteTarget } from "./types";
import { apiFetch, API, copyTextWithFeedback, createEndpoint, GITHUB_PROFILE_URL, type Theme } from "./utils";
import EndpointSidebar from "./EndpointSidebar";
import RequestFeed, { type RequestFeedHandle } from "./RequestFeed";
import DetailPane from "./DetailPane";
import Demo from "./Demo";

export default function App({ theme, toggleTheme }: { theme: Theme; toggleTheme: () => void }) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [selected, setSelected] = useState<Endpoint | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DeleteTarget | null>(null);
  const [loadingEndpoints, setLoadingEndpoints] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [feedWidth, setFeedWidth] = useState(380);
  const [copied, setCopied] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);

  const feedRef = useRef<RequestFeedHandle | null>(null);
  const isResizingSidebar = useRef(false);
  const isResizingFeed = useRef(false);

  const showError = useCallback((msg: string) => {
    setError(msg);
    setTimeout(() => setError(null), 5000);
  }, []);

  const onMouseMoveSidebar = useCallback((e: MouseEvent) => {
    if (isResizingSidebar.current) setSidebarWidth(Math.min(Math.max(e.clientX, 160), 400));
  }, []);

  const onMouseMoveFeed = useCallback((e: MouseEvent) => {
    if (isResizingFeed.current) setFeedWidth(Math.min(Math.max(e.clientX - sidebarWidth, 200), 600));
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
    apiFetch("/api/endpoints")
      .then(r => r.json())
      .then(setEndpoints)
      .catch(e => showError(`Failed to load endpoints: ${e.message}`))
      .finally(() => setLoadingEndpoints(false));
  }, [showError]);

  const hookUrl = selected ? `${API}/hooks/${selected.id}` : "";

  const handleEndpointCreated = (ep: Endpoint, secret: string) => {
    setEndpoints(prev => [ep, ...prev]);
    setSelected(ep);
    setSelectedRequestId(null);
    if (secret) setSecrets(prev => ({ ...prev, [ep.id]: secret }));
  };

  const createDefault = async () => {
    try {
      const created = await createEndpoint("Untitled");
      handleEndpointCreated(created.endpoint, created.secret);
    } catch (e) {
      showError(`Failed to create endpoint: ${e instanceof Error ? e.message : String(e)}`);
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
        if (selected?.id === id) { setSelected(null); setSelectedRequestId(null); }
      } else {
        await apiFetch(`/api/requests/${id}`, { method: "DELETE" });
        feedRef.current?.removeRequest(id);
        if (selectedRequestId === id) setSelectedRequestId(null);
      }
    } catch (e) {
      showError(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const copyHookUrl = () => {
    copyTextWithFeedback(hookUrl, setCopied);
  };

  const copySecret = () => {
    if (!selected || !secrets[selected.id]) return;
    copyTextWithFeedback(secrets[selected.id], setSecretCopied);
  };

  return (
    <div className="layout">
      <nav className="dashboard-nav">
        <div className="nav-left">
          <span className="dashboard-nav-logo">Relay</span>
          <a className="github-nav-link" href={GITHUB_PROFILE_URL} target="_blank" rel="noopener">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            alexh212
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1.5 8.5L8.5 1.5M8.5 1.5H3.5M8.5 1.5V6.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        </div>
        <div className="nav-right">
          <button className="theme-toggle" onClick={toggleTheme} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </nav>

      {error && (
        <div className="error-toast">
          {error}
          <span className="error-toast-close" onClick={() => setError(null)}>×</span>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-title">Confirm delete</div>
            <div className="modal-body">
              Are you sure you want to delete this {confirmDelete.type}? This action cannot be undone.
            </div>
            <div className="modal-actions">
              <button className="modal-cancel" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="modal-delete" onClick={executeDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      <div className="dashboard-body">
        <EndpointSidebar
          endpoints={endpoints}
          selected={selected}
          loading={loadingEndpoints}
          width={sidebarWidth}
          onSelect={ep => { setSelected(ep); setSelectedRequestId(null); }}
          onCreated={handleEndpointCreated}
          onDeleteClick={setConfirmDelete}
          onResizeStart={() => {
            isResizingSidebar.current = true;
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
          onError={showError}
        />

        <div className="main">
          {!selected ? (
            <div className="welcome-state">
              <div className="welcome-inner">
                <p className="welcome-desc">
                  Relay captures every HTTP request sent to your endpoint — headers, body, query params — in real time.
                  Inspect the full payload and replay it to any server.
                </p>
                <button className="welcome-cta" onClick={createDefault}>+ New endpoint</button>
                <Demo />
              </div>
            </div>
          ) : (
            <>
              <div className="main-header">
                <div className="main-header-row">
                  <div className="hook-block">
                    <div className="hook-label">Hook URL</div>
                    <div className="hook-url">{hookUrl}</div>
                  </div>
                  <button className="copy-btn header-copy-btn" onClick={copyHookUrl}>
                    {copied ? "✓ Copied" : "Copy URL"}
                  </button>
                </div>
                {secrets[selected.id] && (
                  <div className="secret-section">
                    <div className="hook-label">
                      Signing Secret<span className="hook-label-note">(shown once)</span>
                    </div>
                    <div className="secret-hint">
                      Sign with HMAC-SHA256, send in the <code>x-webhook-signature</code> header.
                    </div>
                    <div className="secret-row">
                      <div className="hook-url secret-value">{secrets[selected.id]}</div>
                      <button className="secret-copy-btn" onClick={copySecret}>
                        {secretCopied ? "✓" : "copy"}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="content-area">
                <RequestFeed
                  ref={feedRef}
                  endpoint={selected}
                  hookUrl={hookUrl}
                  selectedId={selectedRequestId}
                  feedWidth={feedWidth}
                  onSelect={setSelectedRequestId}
                  onDeleteClick={setConfirmDelete}
                  onResizeStart={() => {
                    isResizingFeed.current = true;
                    document.body.style.cursor = "col-resize";
                    document.body.style.userSelect = "none";
                  }}
                  onError={showError}
                />
                <DetailPane requestId={selectedRequestId} onError={showError} />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="mobile-action-bar">
        <button className="mobile-action-btn mobile-action-btn-secondary" onClick={createDefault}>
          + New endpoint
        </button>
        <button className="mobile-action-btn" onClick={copyHookUrl} disabled={!selected}>
          {copied ? "✓ Copied" : "Copy URL"}
        </button>
      </div>
    </div>
  );
}
