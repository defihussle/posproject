import { useState } from "react";
import { API_URL } from "../config";
import "./StaffManager.css";

const digitsOnly = (v) => v.replace(/\D/g, "").slice(0, 4);

/**
 * Self-service PIN change — Order Entry account dropdown, every role.
 * Hits PUT /api/staff/me/pin (distinct from the Back Office/manager route
 * that resets SOMEONE ELSE's PIN) — current PIN is required and verified
 * server-side, so this can only ever change the account whose current PIN
 * you actually know.
 */
export default function ChangePinModal({ staff, onClose }) {
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const submit = async () => {
    if (saving) return;
    setError(null);

    if (!/^\d{4}$/.test(currentPin)) {
      setError("Enter your current 4-digit PIN");
      return;
    }
    if (!/^\d{4}$/.test(newPin)) {
      setError("New PIN must be exactly 4 digits");
      return;
    }
    if (newPin !== confirmPin) {
      setError("New PIN and confirmation don't match");
      return;
    }
    if (newPin === currentPin) {
      setError("New PIN must be different from your current PIN");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/staff/me/pin`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staffId: staff.id, currentPin, newPin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSuccess(true);
      setTimeout(onClose, 1200);
    } catch (err) {
      setError(err.message || "Failed to change PIN");
      setSaving(false);
    }
  };

  return (
    <div className="staffmgr__overlay" onClick={saving ? undefined : onClose}>
      <div className="staffmgr__modal staffmgr__modal--small" onClick={(e) => e.stopPropagation()}>
        <div className="staffmgr__modal-head">
          <h3 className="staffmgr__modal-title">Change PIN</h3>
          <button
            className="staffmgr__modal-close"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="staffmgr__modal-body">
          {success ? (
            <div className="staffmgr__success">✓ PIN changed successfully</div>
          ) : (
            <>
              {error && <div className="staffmgr__error">{error}</div>}
              <label className="staffmgr__label">
                Current PIN
                <input
                  className="staffmgr__input staffmgr__input--pin"
                  type="password"
                  inputMode="numeric"
                  value={currentPin}
                  onChange={(e) => setCurrentPin(digitsOnly(e.target.value))}
                  placeholder="••••"
                  autoFocus
                />
              </label>
              <label className="staffmgr__label">
                New PIN
                <input
                  className="staffmgr__input staffmgr__input--pin"
                  type="password"
                  inputMode="numeric"
                  value={newPin}
                  onChange={(e) => setNewPin(digitsOnly(e.target.value))}
                  placeholder="••••"
                />
              </label>
              <label className="staffmgr__label">
                Confirm New PIN
                <input
                  className="staffmgr__input staffmgr__input--pin"
                  type="password"
                  inputMode="numeric"
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(digitsOnly(e.target.value))}
                  placeholder="••••"
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                />
              </label>
              <div className="staffmgr__modal-actions">
                <button className="staffmgr__btn" onClick={onClose} disabled={saving}>
                  Cancel
                </button>
                <button className="staffmgr__btn staffmgr__btn--save" onClick={submit} disabled={saving}>
                  {saving ? "Saving…" : "Change PIN"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
