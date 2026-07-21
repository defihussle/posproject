import { useState, useEffect, useCallback } from "react";
import { API_URL } from "../config";
import ConfirmDialog from "./ConfirmDialog";
import "./StaffManager.css";

const ALL_ROLES = ["owner", "admin", "manager", "cashier", "kitchen"];

// Mirrors the backend rules so the UI never offers an action the server
// would reject (the server still re-checks everything).
export function assignableRoles(requesterRole) {
  return requesterRole === "owner"
    ? ALL_ROLES
    : ALL_ROLES.filter((r) => r !== "owner" && r !== "admin");
}

export function canManageTarget(requesterRole, targetRole) {
  if (targetRole === "owner") return requesterRole === "owner";
  if (targetRole === "admin") return requesterRole === "owner" || requesterRole === "admin";
  return true;
}

const fmtRate = (r) => (r == null ? "—" : `$${parseFloat(r).toFixed(2)}/hr`);

const LIVE_STATUS_POLL_MS = 5000; // same cadence as Back Office Home's Live Status card

function fmtSince(iso, nowMs) {
  const seconds = Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/**
 * Back Office → Staff tab, AND the POS-reachable full Staff Management
 * popup for owner/admin (StaffManagementModal.jsx) — one component, two
 * entry points, same pattern already established for MenuManager/
 * ManageMenu. Shopify-inspired: a browsable list (name/role/status at a
 * glance, no inline action buttons), tap/click a row to open a focused
 * MODAL with everything about that person — edit (role, hourly rate),
 * Reset PIN, Deactivate/Reactivate, all in one place. Replaces a prior
 * wide-table-with-inline-buttons layout whose action buttons ran off
 * the edge of the screen on mobile, confirmed via real device testing.
 * Every control is hidden when the logged-in role lacks hierarchy
 * permission over that row (backend enforces the same rules) — this is a
 * layout/interaction change only, the permission logic itself (
 * `canManageTarget`) is untouched.
 *
 * `showLiveStatus` is opt-in (default false) so Back Office's existing
 * usage here is completely unaffected — no extra fetch, no polling, no
 * visual change. Only StaffManagementModal passes it, which is where the
 * task asked for per-row clock-in/break state.
 */
export default function StaffManager({ staff, showLiveStatus = false }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [liveStatus, setLiveStatus] = useState({}); // staffId -> { status, since }

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/backoffice/staff?staffId=${staff.id}`, { credentials: "include" });
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

  useEffect(() => {
    load();
  }, [load]);

  // Reuses the same read-only route Back Office Home's Live Status card
  // polls — no new backend surface, and the clock-in/out actions
  // themselves stay Order-Entry-only regardless of where this table is
  // shown.
  const loadLiveStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/backoffice/staff/live-status`, {
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const byId = {};
      for (const s of data) byId[s.staffId] = { status: s.status, since: s.since };
      setLiveStatus(byId);
    } catch {
      // Non-critical — the table itself still works without it; the next
      // poll retries.
    }
  }, []);

  useEffect(() => {
    if (!showLiveStatus) return;
    loadLiveStatus();
    const id = setInterval(loadLiveStatus, LIVE_STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [showLiveStatus, loadLiveStatus]);

  const applyRow = useCallback((updated) => {
    setRows((prev) =>
      prev.some((r) => r.id === updated.id)
        ? prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r))
        : [...prev, updated]
    );
  }, []);

  // Distinct from applyRow: a smart-delete that actually hard-deleted the
  // row (see DELETE /api/backoffice/staff/:id) means it no longer exists
  // server-side, so it must be filtered out entirely rather than updated.
  const removeRow = useCallback((id) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  if (loading) return <div className="staffmgr__notice">Loading staff…</div>;

  const selectedRow = rows.find((r) => r.id === selectedId) || null;

  return (
    <div className="staffmgr">
      {error && <div className="staffmgr__error">{error}</div>}

      <div className="staffmgr__toolbar">
        <h2 className="staffmgr__title">Staff</h2>
        <button className="staffmgr__add-btn" onClick={() => setShowAdd(true)}>
          + Add Staff
        </button>
      </div>

      <div className="staffmgr__list">
        {rows.map((row) => (
          <button
            key={row.id}
            className={`staffmgr-row${row.active ? "" : " staffmgr-row--inactive"}`}
            onClick={() => setSelectedId(row.id)}
          >
            <span className="staffmgr-row__name">
              {row.name}
              {row.id === staff.id && <span className="staffmgr-row__you">you</span>}
              {showLiveStatus && liveStatus[row.id] && (
                <span className={`staffmgr-row__live staffmgr-row__live--${liveStatus[row.id].status}`}>
                  {liveStatus[row.id].status === "on_break" ? "On Break" : "Working"} ·{" "}
                  {fmtSince(liveStatus[row.id].since, Date.now())}
                </span>
              )}
            </span>
            <span className={`staffmgr-row__role staffmgr-row__role--${row.role}`}>{row.role}</span>
            <span className={`staffmgr-row__status${row.active ? "" : " staffmgr-row__status--off"}`}>
              {row.active ? "ACTIVE" : "INACTIVE"}
            </span>
            <ChevronIcon />
          </button>
        ))}
      </div>

      {selectedRow && (
        <StaffDetailModal
          row={selectedRow}
          me={staff}
          onSaved={applyRow}
          onRemoved={removeRow}
          onError={setError}
          onClose={() => setSelectedId(null)}
        />
      )}

      {showAdd && (
        <div className="staffmgr__overlay" onClick={() => setShowAdd(false)}>
          <div className="staffmgr__modal" onClick={(e) => e.stopPropagation()}>
            <div className="staffmgr__modal-head">
              <h3 className="staffmgr__modal-title">Add Staff</h3>
              <button
                className="staffmgr__modal-close"
                onClick={() => setShowAdd(false)}
                aria-label="Close"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <StaffAddForm
              staff={staff}
              onCreated={(created) => {
                applyRow(created);
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
    <svg className="staffmgr-row__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6"></polyline>
    </svg>
  );
}

// The ONE focused modal for a staff member — edit (role, hourly rate),
// Reset PIN, Deactivate/Reactivate, all together rather than a wide table
// row's worth of separate inline controls. Hierarchy protection
// (`canManageTarget`) still gates whether the write controls even render;
// an unmanageable row (e.g. an owner viewed by an admin) opens the same
// modal but read-only — view access always available, edit conditionally.
function StaffDetailModal({ row, me, onSaved, onRemoved, onError, onClose }) {
  const manageable = canManageTarget(me.role, row.role);
  const [role, setRole] = useState(row.role);
  const [rate, setRate] = useState(row.hourly_rate == null ? "" : String(row.hourly_rate));
  const [email, setEmail] = useState(row.email || "");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pinPrompt, setPinPrompt] = useState(false);
  const [confirmingRole, setConfirmingRole] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const roles = assignableRoles(me.role);
  const options = roles.includes(row.role) ? roles : [row.role, ...roles];
  const isBackofficeRole = role === "owner" || role === "admin";

  const dirty =
    role !== row.role ||
    rate !== (row.hourly_rate == null ? "" : String(row.hourly_rate)) ||
    (isBackofficeRole && email !== (row.email || ""));

  const put = async (body) => {
    const res = await fetch(`${API_URL}/api/backoffice/staff/${row.id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ staffId: me.id, ...body }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  const performSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const body = { hourly_rate: Number(rate) };
      if (role !== row.role) body.role = role;
      if (isBackofficeRole) body.email = email.trim() || null;
      const data = await put(body);
      onError(null);
      onSaved(data);
    } catch (err) {
      onError(err.message);
    } finally {
      setSaving(false);
      setConfirmingRole(false);
    }
  };

  // Role changes get their own confirmation showing the specific
  // from/to values (per task); rate/email edits are low-stakes and save
  // immediately, unchanged from before.
  const requestSave = () => {
    if (saving || !dirty) return;
    if (role !== row.role) {
      setConfirmingRole(true);
      return;
    }
    performSave();
  };

  // Smart delete (see DELETE /api/backoffice/staff/:id): hard-deletes if
  // this staff member has zero order/shift history, otherwise force-
  // deactivates — same server-side decision either way, `row.has_history`
  // is only used here to word the confirmation dialog ahead of time.
  const performRemove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/backoffice/staff/${row.id}`, {
        method: "DELETE",
        credentials: "include",
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

  const reactivate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const data = await put({ active: true });
      onError(null);
      onSaved(data);
      onClose();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
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

          {manageable ? (
            <>
              <label className="staffmgr__label">
                Role
                <select className="staffmgr__input" value={role} onChange={(e) => setRole(e.target.value)}>
                  {options.map((r) => (
                    <option key={r} value={r} disabled={!roles.includes(r)}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <label className="staffmgr__label">
                Hourly rate
                <input
                  className="staffmgr__input staffmgr__input--rate"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  inputMode="decimal"
                  placeholder="0.00"
                />
              </label>
              {isBackofficeRole && (
                <label className="staffmgr__label">
                  Back Office email
                  <input
                    className="staffmgr__input staffmgr__input--email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@narcostacos.ca"
                  />
                </label>
              )}
              {dirty && (
                <div className="staffmgr__modal-actions">
                  <button
                    className="staffmgr__btn"
                    onClick={() => {
                      setRole(row.role);
                      setRate(row.hourly_rate == null ? "" : String(row.hourly_rate));
                      setEmail(row.email || "");
                    }}
                    disabled={saving}
                  >
                    Discard
                  </button>
                  <button className="staffmgr__btn staffmgr__btn--save" onClick={requestSave} disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              )}

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
          ) : (
            <>
              <label className="staffmgr__label">
                Role
                <div className={`staffmgr-row__role staffmgr-row__role--${row.role}`}>{row.role}</div>
              </label>
              <label className="staffmgr__label">
                Hourly rate
                <div className="staffmgr-row__rate">{fmtRate(row.hourly_rate)}</div>
              </label>
            </>
          )}
        </div>
      </div>

      {confirmingRole && (
        <ConfirmDialog
          title="Change role?"
          message={`Change ${row.name}'s role from ${row.role} to ${role}?`}
          confirmLabel="Change Role"
          busy={saving}
          onConfirm={performSave}
          onCancel={() => setConfirmingRole(false)}
        />
      )}

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

// Inline (not a nested modal) — sits within the staff detail modal's own
// body, so resetting a PIN doesn't require stacking a second overlay on
// top of the first.
// Admin/owner resetting SOMEONE ELSE's PIN — deliberately just New +
// Confirm, no "current PIN" field, since the person resetting it doesn't
// (and shouldn't need to) know the old one. Distinct from the self-
// service Change PIN flow elsewhere (old + new + confirm), untouched by
// this component.
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
      const res = await fetch(`${API_URL}/api/backoffice/staff/${staffId}/pin`, {
        method: "PUT",
        credentials: "include",
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

/**
 * Add-staff form — shared by the Back Office Staff tab (full CRUD, owner/
 * admin only) and the Order Entry quick-add modal (owner/admin/manager).
 * Those two surfaces now hit DIFFERENT backend routes (Back Office access
 * was revoked from Manager, but Manager keeps this one add-only POS
 * action) — pass `endpoint` to target the right one; defaults to the
 * Back Office route. Role options are restricted client-side to what the
 * logged-in role may assign (backend re-checks regardless).
 */
export function StaffAddForm({ staff, onCreated, onCancel, endpoint = "/api/backoffice/staff" }) {
  const roles = assignableRoles(staff.role);
  const [name, setName] = useState("");
  const [role, setRole] = useState("cashier");
  const [rate, setRate] = useState("");
  const [pin, setPin] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  // Email is only ever meaningful for owner/admin (the only roles with
  // Back Office login) — manager/cashier/kitchen never see this field at
  // all. From the POS quick-add modal (endpoint="/api/staff/quick-add"),
  // a manager's `roles` list never includes owner/admin in the first
  // place (assignableRoles), so this condition can never be true there —
  // the field is unreachable for manager, not just hidden.
  const isBackofficeRole = role === "owner" || role === "admin";

  const save = async () => {
    if (saving) return;
    if (!/^\d{4}$/.test(pin)) {
      setErr("PIN must be exactly 4 digits");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`${API_URL}${endpoint}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: staff.id,
          name,
          role,
          hourly_rate: Number(rate),
          pin,
          ...(isBackofficeRole ? { email: email.trim() || undefined } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onCreated(data);
    } catch (e) {
      setErr(e.message || "Failed to create staff member");
      setSaving(false);
    }
  };

  return (
    <div className="staffmgr__modal-body">
      {err && <div className="staffmgr__error">{err}</div>}
      <label className="staffmgr__label">
        Name
        <input
          className="staffmgr__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Full name"
        />
      </label>
      <label className="staffmgr__label">
        Role
        <select className="staffmgr__input" value={role} onChange={(e) => setRole(e.target.value)}>
          {roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      {isBackofficeRole && (
        <label className="staffmgr__label">
          Back Office email
          <input
            className="staffmgr__input staffmgr__input--email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@narcostacos.ca"
          />
        </label>
      )}
      <label className="staffmgr__label">
        Hourly rate
        <input
          className="staffmgr__input staffmgr__input--rate"
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
        />
      </label>
      <label className="staffmgr__label">
        PIN (4 digits)
        <input
          className="staffmgr__input staffmgr__input--pin"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="••••"
          inputMode="numeric"
        />
      </label>
      <div className="staffmgr__modal-actions">
        <button className="staffmgr__btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button className="staffmgr__btn staffmgr__btn--save" onClick={save} disabled={saving}>
          {saving ? "Adding…" : "Add Staff"}
        </button>
      </div>
    </div>
  );
}
