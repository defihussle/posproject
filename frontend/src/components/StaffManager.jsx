import { useState, useEffect, useCallback } from "react";
import { API_URL } from "../config";
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
 * ManageMenu. List + add + inline edit + deactivate/reactivate + PIN
 * reset. Every control is hidden when the logged-in role lacks hierarchy
 * permission over that row (backend enforces the same rules).
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

  if (loading) return <div className="staffmgr__notice">Loading staff…</div>;

  return (
    <div className="staffmgr">
      {error && <div className="staffmgr__error">{error}</div>}

      <div className="staffmgr__toolbar">
        <h2 className="staffmgr__title">Staff</h2>
        <button className="staffmgr__add-btn" onClick={() => setShowAdd(true)}>
          + Add Staff
        </button>
      </div>

      <div className="staffmgr__table">
        <div className="staffmgr-row staffmgr-row--head" aria-hidden="true">
          <span>Name</span>
          <span>Role</span>
          <span>Hourly rate</span>
          <span>Status</span>
          <span />
        </div>
        {rows.map((row) => (
          <StaffRow
            key={row.id}
            row={row}
            me={staff}
            onSaved={applyRow}
            onError={setError}
            live={showLiveStatus ? liveStatus[row.id] : undefined}
          />
        ))}
      </div>

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

function StaffRow({ row, me, onSaved, onError, live }) {
  const [editing, setEditing] = useState(false);
  const [pinPrompt, setPinPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  const manageable = canManageTarget(me.role, row.role);

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

  const toggleActive = async () => {
    if (busy) return;
    setBusy(true);
    try {
      onSaved(await put({ active: !row.active }));
      onError(null);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`staffmgr-row${row.active ? "" : " staffmgr-row--inactive"}`}>
      <span className="staffmgr-row__name">
        {row.name}
        {row.id === me.id && <span className="staffmgr-row__you">you</span>}
        {live && (
          <span className={`staffmgr-row__live staffmgr-row__live--${live.status}`}>
            {live.status === "on_break" ? "On Break" : "Working"} · {fmtSince(live.since, Date.now())}
          </span>
        )}
      </span>

      {editing ? (
        <RowEditForm
          row={row}
          me={me}
          onSaved={(u) => {
            onSaved(u);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
          onError={onError}
        />
      ) : (
        <>
          <span className={`staffmgr-row__role staffmgr-row__role--${row.role}`}>
            {row.role}
          </span>
          <span className="staffmgr-row__rate">{fmtRate(row.hourly_rate)}</span>
          <span className={`staffmgr-row__status${row.active ? "" : " staffmgr-row__status--off"}`}>
            {row.active ? "ACTIVE" : "INACTIVE"}
          </span>
          <div className="staffmgr-row__actions">
            {/* Controls hidden entirely when hierarchy says hands-off */}
            {manageable && (
              <>
                <button className="staffmgr__btn" onClick={() => setEditing(true)}>
                  Edit
                </button>
                <button className="staffmgr__btn" onClick={() => setPinPrompt(true)}>
                  Reset PIN
                </button>
                <button
                  className={`staffmgr__btn ${row.active ? "staffmgr__btn--danger" : "staffmgr__btn--green"}`}
                  onClick={toggleActive}
                  disabled={busy}
                >
                  {busy ? "…" : row.active ? "Deactivate" : "Reactivate"}
                </button>
              </>
            )}
          </div>
        </>
      )}

      {pinPrompt && (
        <PinResetPrompt
          row={row}
          me={me}
          onDone={() => setPinPrompt(false)}
          onError={onError}
        />
      )}
    </div>
  );
}

function RowEditForm({ row, me, onSaved, onCancel, onError }) {
  const [role, setRole] = useState(row.role);
  const [rate, setRate] = useState(row.hourly_rate == null ? "" : String(row.hourly_rate));
  const [email, setEmail] = useState(row.email || "");
  const [saving, setSaving] = useState(false);
  const roles = assignableRoles(me.role);
  // Keep the target's current role selectable even if not assignable by me
  // (e.g. admin editing an admin's rate without changing role).
  const options = roles.includes(row.role) ? roles : [row.role, ...roles];
  // Email is only ever meaningful for owner/admin (the only roles with
  // Back Office login) — shown/sent based on the SELECTED role, so
  // switching a row to owner/admin reveals it immediately, and switching
  // away hides it again without needing a second save.
  const isBackofficeRole = role === "owner" || role === "admin";

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const body = { staffId: me.id, hourly_rate: Number(rate) };
      if (role !== row.role) body.role = role;
      if (isBackofficeRole) body.email = email.trim() || null;
      const res = await fetch(`${API_URL}/api/backoffice/staff/${row.id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onError(null);
      onSaved(data);
    } catch (err) {
      onError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="staffmgr-row__editform">
      <select className="staffmgr__input" value={role} onChange={(e) => setRole(e.target.value)}>
        {options.map((r) => (
          <option key={r} value={r} disabled={!roles.includes(r)}>
            {r}
          </option>
        ))}
      </select>
      <input
        className="staffmgr__input staffmgr__input--rate"
        value={rate}
        onChange={(e) => setRate(e.target.value)}
        inputMode="decimal"
        placeholder="0.00"
      />
      {isBackofficeRole && (
        <input
          className="staffmgr__input staffmgr__input--email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Back Office email"
        />
      )}
      <button className="staffmgr__btn staffmgr__btn--save" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
      <button className="staffmgr__btn" onClick={onCancel} disabled={saving}>
        Cancel
      </button>
    </div>
  );
}

// Tiny 4-digit-only prompt, deliberately separate from the general edit form
// so a PIN can't be reset by accident.
function PinResetPrompt({ row, me, onDone, onError }) {
  const [pin, setPin] = useState("");
  const [saving, setSaving] = useState(false);
  const [localErr, setLocalErr] = useState(null);

  const save = async () => {
    if (saving) return;
    if (!/^\d{4}$/.test(pin)) {
      setLocalErr("PIN must be exactly 4 digits");
      return;
    }
    setSaving(true);
    setLocalErr(null);
    try {
      const res = await fetch(`${API_URL}/api/backoffice/staff/${row.id}/pin`, {
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
    }
  };

  return (
    <div className="staffmgr__overlay" onClick={onDone}>
      <div className="staffmgr__modal staffmgr__modal--small" onClick={(e) => e.stopPropagation()}>
        <div className="staffmgr__modal-head">
          <h3 className="staffmgr__modal-title">Reset PIN — {row.name}</h3>
        </div>
        <div className="staffmgr__modal-body">
          {localErr && <div className="staffmgr__error">{localErr}</div>}
          <input
            className="staffmgr__input staffmgr__input--pin"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder="New 4-digit PIN"
            inputMode="numeric"
            autoFocus
          />
          <div className="staffmgr__modal-actions">
            <button className="staffmgr__btn" onClick={onDone} disabled={saving}>
              Cancel
            </button>
            <button className="staffmgr__btn staffmgr__btn--save" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Set PIN"}
            </button>
          </div>
        </div>
      </div>
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
