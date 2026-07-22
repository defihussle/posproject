import { useState, useEffect, useCallback } from "react";
import { API_URL } from "../config";
import { formatDuration } from "../format";
import ConfirmDialog from "./ConfirmDialog";
import "./StaffManager.css";
import "./DeviceManager.css";

function fmtDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtRelative(iso) {
  if (!iso) return "Never";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Back Office → Devices tab (device-pairing-plan.md). Same Shopify-
 * inspired pattern as StaffManager/MenuManager: a browsable list, tap a
 * row to open a focused detail modal (rename + revoke), plus a floating
 * "Generate Pairing Code" action for the one thing that isn't about an
 * existing row. Reuses StaffManager.css's generic overlay/modal/button/
 * input/status-pill classes directly (same convention StaffManagementModal
 * already established) — DeviceManager.css holds only what's specific to
 * this list's shape (date columns, the FAB, the code-display panel).
 *
 * Only PAIRED devices (paired_at IS NOT NULL) ever appear here — a
 * generated-but-not-yet-redeemed code isn't a "device" yet, see
 * GET /api/backoffice/devices on the backend. Revoked devices stay
 * visible (status pill flips to "Revoked") as audit history, same
 * "never hard-delete" spirit as Staff Management.
 */
export default function DeviceManager() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  // null | { state: "generating" } | { state: "ready", code, expiresAt } | { state: "error", message }
  // Owned here (not inside GenerateCodeModal) and triggered directly from
  // the FAB's onClick — deliberately NOT fetched from a mount effect
  // inside the modal. A POST that creates a server-side row is not
  // idempotent, and React 18 StrictMode double-invokes effects in dev;
  // an effect-triggered fetch here silently generated TWO codes per
  // click during testing (confirmed against the database), one shown to
  // the user and one orphaned forever. Event handlers are never double-
  // invoked by StrictMode, so tying this to the actual click sidesteps
  // the problem instead of working around it with cancellation flags.
  const [generateModal, setGenerateModal] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/backoffice/devices`, { credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setRows(data);
      setError(null);
    } catch (err) {
      setError(err.message || "Failed to load devices");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const applyRow = useCallback((updated) => {
    setRows((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
  }, []);

  const generateCode = useCallback(async () => {
    setGenerateModal({ state: "generating" });
    try {
      const res = await fetch(`${API_URL}/api/backoffice/devices/generate-code`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setGenerateModal({ state: "ready", code: data.code, expiresAt: data.expiresAt });
    } catch (err) {
      setGenerateModal({ state: "error", message: err.message || "Failed to generate code" });
    }
  }, []);

  if (loading) return <div className="staffmgr__notice">Loading devices…</div>;

  const selectedRow = rows.find((r) => r.id === selectedId) || null;

  return (
    <div className="staffmgr devices">
      {error && <div className="staffmgr__error">{error}</div>}

      <div className="staffmgr__toolbar">
        <h2 className="staffmgr__title">Devices</h2>
      </div>

      {rows.length === 0 ? (
        <div className="devices__empty">
          No devices paired yet. Tap "+ Generate Pairing Code" below, then enter the code on the new
          device's Order Entry or KDS screen.
        </div>
      ) : (
        <>
          <div className="devices-header" aria-hidden="true">
            <span className="devices-header__name">Name</span>
            <span className="devices-header__date">Last Seen</span>
            <span className="devices-header__status">Status</span>
          </div>
          <div className="staffmgr__list">
            {rows.map((row) => (
              <button
                key={row.id}
                className={`devices-row${row.revoked_at ? " devices-row--revoked" : ""}`}
                onClick={() => setSelectedId(row.id)}
              >
                <span className="devices-row__name">{row.device_name}</span>
                <span className="devices-row__date">{fmtRelative(row.last_seen_at)}</span>
                <span className={`staffmgr__status-pill devices-row__pill${row.revoked_at ? " staffmgr__status-pill--off" : ""}`}>
                  {row.revoked_at ? "Revoked" : "Paired"}
                </span>
                <ChevronIcon />
              </button>
            ))}
          </div>
        </>
      )}

      <button className="devices__fab" onClick={generateCode}>
        + Generate Pairing Code
      </button>

      {selectedRow && (
        <DeviceDetailModal
          row={selectedRow}
          onSaved={applyRow}
          onRevoked={load}
          onError={setError}
          onClose={() => setSelectedId(null)}
        />
      )}

      {generateModal && (
        <GenerateCodeModal
          modal={generateModal}
          onGenerateAnother={generateCode}
          onClose={() => {
            setGenerateModal(null);
            load(); // picks up a device that got paired while this was open
          }}
        />
      )}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg className="staffmgr-row__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6"></polyline>
    </svg>
  );
}

// Rename + revoke, everything about one already-paired device. No
// hierarchy concept here (unlike StaffDetailModal) — every owner/admin
// can manage every device equally, matching the plan's clarified scope
// (owner + admin, same as every other Back Office capability).
function DeviceDetailModal({ row, onSaved, onRevoked, onError, onClose }) {
  const [name, setName] = useState(row.device_name || "");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const isRevoked = !!row.revoked_at;

  const dirty = name !== (row.device_name || "");

  // Leave edit mode without persisting — restores the original name so a
  // reopened editor doesn't start from an abandoned draft.
  const handleCancel = () => {
    setName(row.device_name || "");
    setEditing(false);
    onError(null);
  };

  const performSave = async () => {
    if (saving || !dirty) return;
    if (!name.trim()) {
      onError("Device name can't be empty");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/backoffice/devices/${row.id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_name: name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onError(null);
      onSaved(data);
      setEditing(false);
    } catch (err) {
      onError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const performRevoke = async () => {
    if (revoking) return;
    setRevoking(true);
    try {
      const res = await fetch(`${API_URL}/api/backoffice/devices/${row.id}/revoke`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onError(null);
      onRevoked(); // full re-fetch — the revoke response is minimal (no revoked_at/revoked_by_name to merge)
      onClose();
    } catch (err) {
      onError(err.message);
    } finally {
      setRevoking(false);
      setConfirmingRevoke(false);
    }
  };

  return (
    <div className="staffmgr__overlay" onClick={onClose}>
      <div className="staffmgr__modal" onClick={(e) => e.stopPropagation()}>
        <div className="staffmgr__modal-head">
          <h3 className="staffmgr__modal-title">{row.device_name}</h3>
          <button className="staffmgr__modal-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="staffmgr__modal-body">
          <span className={`staffmgr__status-pill${isRevoked ? " staffmgr__status-pill--off" : ""}`}>
            {isRevoked ? "Revoked" : "Paired"}
          </span>

          <div className="devices__name-block">
            <span className="devices__field-label">Name</span>
            {editing ? (
              <div className="devices__name-edit">
                <input
                  className="staffmgr__input"
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, 60))}
                  disabled={saving}
                  autoFocus
                />
                <div className="staffmgr__modal-actions">
                  <button className="staffmgr__btn" onClick={handleCancel} disabled={saving}>
                    Cancel
                  </button>
                  <button
                    className="staffmgr__btn staffmgr__btn--save"
                    onClick={performSave}
                    disabled={saving || !dirty || !name.trim()}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="devices__name-view">
                <span className="devices__name-text">{row.device_name}</span>
                <button className="devices__edit-btn" onClick={() => setEditing(true)}>
                  Edit
                </button>
              </div>
            )}
          </div>

          <div className="staffmgr__modal-divider" />

          <div className="devices__detail-row">
            <span className="devices__detail-label">Paired</span>
            <span className="devices__detail-value">
              {fmtDateTime(row.paired_at)}
              {row.created_by_name ? ` · by ${row.created_by_name}` : ""}
            </span>
          </div>
          <div className="devices__detail-row">
            <span className="devices__detail-label">Last seen</span>
            <span className="devices__detail-value">{fmtDateTime(row.last_seen_at)}</span>
          </div>
          {isRevoked && (
            <div className="devices__detail-row">
              <span className="devices__detail-label">Revoked</span>
              <span className="devices__detail-value">
                {fmtDateTime(row.revoked_at)}
                {row.revoked_by_name ? ` · by ${row.revoked_by_name}` : ""}
              </span>
            </div>
          )}

          {!isRevoked && (
            <>
              <div className="staffmgr__modal-divider" />
              <button
                className="staffmgr__btn staffmgr__btn--danger"
                onClick={() => setConfirmingRevoke(true)}
                disabled={revoking}
              >
                {revoking ? "…" : "Revoke Device"}
              </button>
            </>
          )}
        </div>
      </div>

      {confirmingRevoke && (
        <ConfirmDialog
          title="Revoke this device?"
          message={`Revoke "${row.device_name}"? It will immediately lose access to Order Entry and KDS — whoever's using it will be sent back to the pairing screen mid-shift. A brand-new pairing code is required to use it again.`}
          confirmLabel="Revoke"
          danger
          busy={revoking}
          onConfirm={performRevoke}
          onCancel={() => setConfirmingRevoke(false)}
        />
      )}
    </div>
  );
}

// Purely presentational — the actual POST /generate-code call happens in
// DeviceManager, triggered directly by the FAB's onClick (see the long
// comment on `generateModal` there for why this can't be a mount effect
// in here instead). This component only owns the countdown timer, which
// is safe as an effect: re-running a setInterval/clearInterval pair
// under StrictMode's double-invoke has no server-side side effect to
// duplicate. Once the countdown hits zero the display flips to an
// "Expired" state with a one-tap "Generate Another" (re-invokes the
// parent's generateCode) rather than auto-closing out from under an
// admin who's mid-read.
function GenerateCodeModal({ modal, onGenerateAnother, onClose }) {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    modal.state === "ready" ? Math.max(0, Math.round((new Date(modal.expiresAt).getTime() - Date.now()) / 1000)) : 0
  );

  // A fresh code from "Generate Another" needs its own fresh countdown.
  useEffect(() => {
    if (modal.state !== "ready") return;
    setSecondsLeft(Math.max(0, Math.round((new Date(modal.expiresAt).getTime() - Date.now()) / 1000)));
  }, [modal.state, modal.expiresAt]);

  const expired = modal.state === "ready" && secondsLeft <= 0;

  useEffect(() => {
    if (modal.state !== "ready" || expired) return;
    const id = setInterval(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearInterval(id);
  }, [modal.state, expired]);

  return (
    <div className="staffmgr__overlay" onClick={onClose}>
      <div className="staffmgr__modal" onClick={(e) => e.stopPropagation()}>
        <div className="staffmgr__modal-head">
          <h3 className="staffmgr__modal-title">Pairing Code</h3>
          <button className="staffmgr__modal-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="staffmgr__modal-body">
          {modal.state === "generating" && <div className="staffmgr__notice">Generating…</div>}
          {modal.state === "error" && <div className="staffmgr__error">{modal.message}</div>}

          {modal.state === "ready" && (
            <>
              <p className="devices__code-notice">Enter this code on the new device's pairing screen.</p>
              <div className={`devices__code-display${expired ? " devices__code-display--expired" : ""}`}>
                {modal.code}
              </div>
              <div className="devices__code-status">
                {expired ? "Expired" : `Expires in ${formatDuration(secondsLeft)}`}
              </div>
            </>
          )}

          <div className="staffmgr__modal-actions">
            {expired || modal.state === "error" ? (
              <button className="staffmgr__btn staffmgr__btn--save" onClick={onGenerateAnother}>
                Generate Another
              </button>
            ) : (
              <button className="staffmgr__btn" onClick={onClose} disabled={modal.state === "generating"}>
                Done
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
