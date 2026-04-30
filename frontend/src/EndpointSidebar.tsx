import { useState } from "react";
import type { Endpoint, DeleteTarget } from "./types";
import { createEndpoint } from "./utils";

interface Props {
  endpoints: Endpoint[];
  selected: Endpoint | null;
  loading: boolean;
  width: number;
  onSelect: (ep: Endpoint) => void;
  onCreated: (ep: Endpoint, secret: string) => void;
  onDeleteClick: (target: DeleteTarget) => void;
  onDeleteAllClick: () => void;
  onResizeStart: () => void;
  onError: (msg: string) => void;
}

export default function EndpointSidebar({
  endpoints, selected, loading, width,
  onSelect, onCreated, onDeleteClick, onDeleteAllClick, onResizeStart, onError,
}: Props) {
  const [newName, setNewName] = useState("");
  const [requireSignature, setRequireSignature] = useState(false);

  const create = async () => {
    try {
      const created = await createEndpoint(newName, requireSignature);
      onCreated(created.endpoint, created.secret);
      setNewName("");
    } catch (e) {
      onError(`Failed to create endpoint: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="sidebar" style={{ width }}>
      <div className="sidebar-header">
        <div className="sidebar-tools">
          <div className="logo">Endpoints</div>
          <button
            className="delete-all-btn"
            onClick={onDeleteAllClick}
            disabled={endpoints.length === 0}
            title={endpoints.length === 0 ? "No endpoints to delete" : "Delete all endpoints"}
          >
            Delete all
          </button>
        </div>
        <div className="input-row">
          <input
            className="ep-input"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && create()}
            placeholder="New endpoint..."
          />
          <button className="add-btn" onClick={create}>+</button>
        </div>
        <label className="signature-toggle">
          <input
            type="checkbox"
            checked={requireSignature}
            onChange={e => setRequireSignature(e.target.checked)}
          />
          Require signature
        </label>
      </div>
      <div className="ep-list">
        {loading && <div className="ep-list-loading">Loading...</div>}
        {!loading && endpoints.length === 0 && <div className="ep-list-empty">No endpoints yet</div>}
        {endpoints.map(ep => (
          <div
            key={ep.id}
            className={`ep-item ${selected?.id === ep.id ? "active" : ""}`}
            onClick={() => onSelect(ep)}
          >
            <div className="ep-item-row">
              <div className="ep-name">{ep.name}</div>
              <span
                className="item-delete"
                onClick={e => { e.stopPropagation(); onDeleteClick({ type: "endpoint", id: ep.id }); }}
              >×</span>
            </div>
          </div>
        ))}
      </div>
      <div className="resize-handle" onMouseDown={onResizeStart} />
    </div>
  );
}
