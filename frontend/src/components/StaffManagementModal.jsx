import { useState, useEffect, useCallback } from "react";
import { API_URL } from "../config";
import { canManageTarget, StaffAddForm } from "./StaffManager";
import ConfirmDialog from "./ConfirmDialog";
import "./StaffManager.css";
import "./StaffManagementModal.css";

const LIVE_STATUS_POLL_MS = 5000; // same cadence as Back Office Home's Live Status card

function fmtSince(iso, nowMs) {
  const seconds = Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/**
 * Order Entry's "Staff Management" popup — owner/admin only. Self-
 * contained: hits the POS-specific /api/staff/* routes (roster,
 * :id/status, :id/reset-pin, quick-add), which all follow the SAME
 * trusted-staffId pattern as the rest of Order Entry — staffId comes from
 * the client, the server re-derives that staffId's real role from the DB
 * server-side. No Back Office session cookie involved anywhere in this
 * file, and therefore no dependency on ever having logged into Back
 * Office on this device (that was the bug in the previous version, which
 * reused /api/backoffice/staff* and silently required a separate
 * email+password+TOTP login on the same browser).
 *
 * Shopify-inspired browsable list, same as Back Office's StaffManager and
 * MenuManager: name/role/status at a glance, tap a row to open a focused
 * detail sheet (a modal nested on top of this one, same pattern already
 * used for "Add Staff" below) with view + Reset PIN + Deactivate/
 * Reactivate. Replaces a prior 4-column row with inline action buttons
 * that ran off the edge of the screen on mobile (confirmed via real
 * device testing).
 *
 * Deliberately smaller scope than Back Office's own StaffManager.jsx
 * (unchanged, untouched by this file): view + add + deactivate/
 * reactivate + reset PIN. No role/hourly-rate editing here — that stays
 * Back-Office-only, a "quick troubleshooting on the counter tablet" tool
 * rather than a duplicate of full HR editing.
 */
export default function StaffManagementModal({ staff, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/staff/roster?staffId=${staff.id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setRows(data);
      setError(null);
    } catch (err) {
      setError(err.message || "Failed to load staff");
    } finally {
      setLoading(false);
    }
  }, [staff.id]);

  // Poll so live status stays live. Safe to refresh the whole roster on an
  // interval — rows are keyed by id, so a row mid-action (PIN prompt open,
  // deactivate in flight) keeps its own local state across the re-fetch;
  // React just re-renders the existing row instances with fresh props.
  useEffect(() => {
    load();
    const id = setInterval(load, LIVE_STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const applyRow = useCallback((updated) => {
    setRows((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
  }, []);

  // Distinct from applyRow: a smart-delete that actually hard-deleted the
  // row (see DELETE /api/staff/:id) means it no longer exists server-
  // side, so it must be filtered out entirely rather than updated.
  const removeRow = useCallback((id) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const selectedRow = rows.find((r) => r.id === selectedId) || null;

  return (
    <div className="staffmgr__overlay" onClick={onClose}>
      <div className="staffmgr__modal staffmgr__modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="staffmgr__modal-head">
          <h3 className="staffmgr__modal-title">Staff Management</h3>
          <button className="staffmgr__modal-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="staffmgr__modal-body staffroster">
          {error && <div className="staffmgr__error">{error}</div>}

          <div className="staffroster__toolbar">
            <h2 className="staffmgr__title">Staff</h2>
            <button className="staffmgr__add-btn" onClick={() => setShowAdd(true)}>
              + Add Staff
            </button>
          </div>

          {loading ? (
            <div className="staffmgr__notice">Loading staff…</div>
          ) : (
            <div className="staffroster__list">
              {rows.map((row) => (
                <button
                  key={row.id}
                  className={`staffroster-row${row.active ? "" : " staffroster-row--inactive"}`}
                  onClick={() => setSelectedId(row.id)}
                >
                  <span className="staffroster-row__name">
                    {row.name}
                    {row.id === staff.id && <span className="staffroster-row__you">you</span>}
                    {row.live && (
                      <span className={`staffroster-row__live staffroster-row__live--${row.live.status}`}>
                        {row.live.status === "on_break" ? "On Break" : "Working"} ·{" "}
                        {fmtSince(row.live.since, Date.now())}
                      </span>
                    )}
                  </span>
                  <span className={`staffroster-row__role staffroster-row__role--${row.role}`}>{row.role}</span>
                  <span className={`staffroster-row__status${row.active ? "" : " staffroster-row__status--off"}`}>
                    {row.active ? "ACTIVE" : "INACTIVE"}
                  </span>
                  <ChevronIcon />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {selectedRow && (
        <StaffDetailSheet
          row={selectedRow}
          me={staff}
          onSaved={applyRow}
          onRemoved={removeRow}
          onError={setError}
          onClose={() => setSelectedId(null)}
        />
      )}

      {showAdd && (
        <div className="staffmgr__overlay" onClick={(e) => { e.stopPropagation(); setShowAdd(false); }}>
          <div className="staffmgr__modal" onClick={(e) => e.stopPropagation()}>
            <div className="staffmgr__modal-head">
              <h3 className="staffmgr__modal-title">Add Staff</h3>
              <button className="staffmgr__modal-close" onClick={() => setShowAdd(false)} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <StaffAddForm
              staff={staff}
              endpoint="/api/staff/quick-add"
              onCreated={(created) => {
                setRows((prev) => [...prev, { ...created, live: null }]);
                setShowAdd(false);
              }}
              onCancel={() => setShowAdd(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg className="staffroster-row__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6"></polyline>
    </svg>
  );
}

// Nested modal (on top of the roster modal, same "stack another overlay"
// pattern already used for Add Staff above) — view details, live status,
// Reset PIN, Deactivate/Reactivate. No role/hourly-rate editing: that's
// deliberately out of scope here, unlike Back Office's StaffManager.
// Hierarchy protection mirrors the server-side canManageTarget check
// exactly — an unmanageable row (e.g. an owner viewed by an admin) opens
// the same sheet but with no write controls, view-only.
function StaffDetailSheet({ row, me, onSaved, onRemoved, onError, onClose }) {
  const manageable = canManageTarget(me.role, row.role);
  const [busy, setBusy] = useState(false);
  const [pinPrompt, setPinPrompt] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const reactivate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/staff/${row.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staffId: me.id, active: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onSaved(data);
      onError(null);
      onClose();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Smart delete (see DELETE /api/staff/:id): hard-deletes if this staff
  // member has zero order/shift history, otherwise force-deactivates —
  // same server-side decision either way, `row.has_history` is only used
  // here to word the confirmation dialog ahead of time.
  const performRemove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/staff/${row.id}?staffId=${me.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onError(null);
      if (data.action === "deleted") {
        onRemoved(row.id);
      } else {
        onSaved({ ...row, active: false });
      }
      onClose();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
      setConfirmingRemove(false);
    }
  };

  return (
    <div className="staffmgr__overlay" onClick={onClose}>
      <div className="staffmgr__modal" onClick={(e) => e.stopPropagation()}>
        <div className="staffmgr__modal-head">
          <h3 className="staffmgr__modal-title">{row.name}</h3>
          <button className="staffmgr__modal-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="staffmgr__modal-body">
          <span className={`staffmgr__status-pill${row.active ? "" : " staffmgr__status-pill--off"}`}>
            {row.active ? "Active" : "Inactive"}
          </span>

          <div className={`staffroster-row__role staffroster-row__role--${row.role}`}>{row.role}</div>

          {row.live && (
            <span className={`staffroster-row__live staffroster-row__live--${row.live.status}`}>
              {row.live.status === "on_break" ? "On Break" : "Working"} · {fmtSince(row.live.since, Date.now())}
            </span>
          )}

          {manageable && (
            <>
              <div className="staffmgr__modal-divider" />

              {pinPrompt ? (
                <InlinePinReset
                  staffId={row.id}
                  staffName={row.name}
                  me={me}
                  onDone={() => setPinPrompt(false)}
                  onError={onError}
                />
              ) : (
                <button className="staffmgr__btn" onClick={() => setPinPrompt(true)}>
                  Reset PIN
                </button>
              )}

              {row.active ? (
                <button
                  className="staffmgr__btn staffmgr__btn--danger"
                  onClick={() => setConfirmingRemove(true)}
                  disabled={busy}
                >
                  {busy ? "…" : row.has_history ? "Deactivate" : "Delete"}
                </button>
              ) : (
                <>
                  <button className="staffmgr__btn staffmgr__btn--green" onClick={reactivate} disabled={busy}>
                    {busy ? "…" : "Reactivate"}
                  </button>
                  {!row.has_history && (
                    <button
                      className="staffmgr__btn staffmgr__btn--danger"
                      onClick={() => setConfirmingRemove(true)}
                      disabled={busy}
                    >
                      {busy ? "…" : "Delete"}
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {confirmingRemove && (
        <ConfirmDialog
          title={row.has_history ? "Deactivate staff member?" : "Delete staff member?"}
          message={
            row.has_history
              ? `Deactivate ${row.name}? They will no longer be able to log in. (They have order/shift history, so they can't be permanently deleted.)`
              : `Permanently delete ${row.name}? This cannot be undone.`
          }
          confirmLabel={row.has_history ? "Deactivate" : "Delete"}
          danger
          busy={busy}
          onConfirm={performRemove}
          onCancel={() => setConfirmingRemove(false)}
        />
      )}
    </div>
  );
}

// Same shape as StaffManager.jsx's inline PIN reset, but posts to the
// trusted-staffId route instead of the Back Office session-cookie one.
// Same New + Confirm (no old PIN) shape — the person resetting someone
// else's PIN doesn't know their old one.
function InlinePinReset({ staffId, staffName, me, onDone, onError }) {
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [saving, setSaving] = useState(false);
  const [localErr, setLocalErr] = useState(null);
  const [confirming, setConfirming] = useState(false);

  const requestSave = () => {
    if (saving) return;
    if (!/^\d{4}$/.test(pin)) {
      setLocalErr("PIN must be exactly 4 digits");
      return;
    }
    if (pin !== confirmPin) {
      setLocalErr("PINs don't match");
      return;
    }
    setLocalErr(null);
    setConfirming(true);
  };

  const performSave = async () => {
    if (saving) return;
    setSaving(true);
    setLocalErr(null);
    try {
      const res = await fetch(`${API_URL}/api/staff/${staffId}/reset-pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staffId: me.id, pin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onError(null);
      onDone();
    } catch (err) {
      setLocalErr(err.message);
      setSaving(false);
      setConfirming(false);
    }
  };

  return (
    <div className="staffmgr__inline-pin">
      {localErr && <div className="staffmgr__error">{localErr}</div>}
      <input
        className="staffmgr__input staffmgr__input--pin"
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
        placeholder="New 4-digit PIN"
        inputMode="numeric"
        autoFocus
      />
      <input
        className="staffmgr__input staffmgr__input--pin"
        value={confirmPin}
        onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
        placeholder="Confirm new PIN"
        inputMode="numeric"
      />
      <div className="staffmgr__modal-actions">
        <button className="staffmgr__btn" onClick={onDone} disabled={saving}>
          Cancel
        </button>
        <button className="staffmgr__btn staffmgr__btn--save" onClick={requestSave} disabled={saving}>
          {saving ? "Saving…" : "Set PIN"}
        </button>
      </div>

      {confirming && (
        <ConfirmDialog
          title="Reset PIN?"
          message={`Reset ${staffName}'s PIN? The old PIN will stop working immediately — they'll need the new one to log in.`}
          confirmLabel="Reset PIN"
          danger
          busy={saving}
          onConfirm={performSave}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
