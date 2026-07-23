import { useState, useEffect, useCallback } from "react";
import { API_URL } from "../config";
import "./StaffManager.css";
import "./ClockCard.css";

function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

const ACTION_LABELS = {
  start_shift: "Start Shift",
  end_shift: "End Shift",
  take_break: "Take Break",
  end_break: "End Break",
};

const ACTION_ENDPOINTS = {
  start_shift: "clock-in",
  end_shift: "clock-out",
  take_break: "break-start",
  end_break: "break-end",
};

/**
 * Contextual clock in/out card — Order Entry account dropdown, every role.
 * One entry point, state-driven contents (fetched fresh via clock-status
 * every time the card opens):
 *   not_clocked_in -> Start Shift
 *   working        -> running shift timer, End Shift / Take Break
 *   on_break       -> running break timer, End Break / End Shift (can end
 *                     a shift directly from a break — e.g. an emergency —
 *                     the clock-out route auto-closes the open break)
 * Every action requires a PIN, entered inline in this same card, before
 * it's submitted — the card never closes itself on success, it just
 * transitions to whatever the new state is so multiple actions (e.g.
 * Start Shift, then immediately Take Break) can be chained in one visit.
 */
export default function ClockCard({ staff, onClose }) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null); // 'not_clocked_in' | 'working' | 'on_break'
  const [clockIn, setClockIn] = useState(null);
  const [breakStart, setBreakStart] = useState(null);
  const [breakSeconds, setBreakSeconds] = useState(0); // completed break time this shift
  const [loadError, setLoadError] = useState(null);
  // Set when a shift is just ended, to show a one-line summary + Start/Close
  // in the (now not_clocked_in) card. Cleared when any other action runs.
  const [endedSummary, setEndedSummary] = useState(null);

  const [pendingAction, setPendingAction] = useState(null); // key into ACTION_LABELS, or null
  const [pin, setPin] = useState("");
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Live-ticking timer — same 1s pattern KDS uses for its elapsed timers.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/staff/me/clock-status?staffId=${staff.id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus(data.status);
      setClockIn(data.clockIn || null);
      setBreakStart(data.breakStart || null);
      setBreakSeconds(data.breakSeconds || 0);
      setLoadError(null);
    } catch (err) {
      setLoadError(err.message || "Failed to load clock status");
    } finally {
      setLoading(false);
    }
  }, [staff.id]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const startAction = (action) => {
    setPendingAction(action);
    setPin("");
    setActionError(null);
  };

  const cancelAction = () => {
    setPendingAction(null);
    setPin("");
    setActionError(null);
  };

  const confirmAction = async () => {
    if (busy || !pendingAction) return;
    if (!/^\d{4}$/.test(pin)) {
      setActionError("Enter your 4-digit PIN");
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const endpoint = ACTION_ENDPOINTS[pendingAction];
      const res = await fetch(`${API_URL}/api/staff/me/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staffId: staff.id, pin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // Capture the ended-shift summary; any other action clears it.
      const endedShift = pendingAction === "end_shift" ? data.shift || null : null;
      setPendingAction(null);
      setPin("");
      setEndedSummary(endedShift);
      await loadStatus();
    } catch (err) {
      setActionError(err.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const renderPinPrompt = () => (
    <div className="clockcard__pin-prompt">
      {actionError && <div className="staffmgr__error">{actionError}</div>}
      <label className="staffmgr__label">
        Enter your PIN to {ACTION_LABELS[pendingAction].toLowerCase()}
        <input
          className="staffmgr__input staffmgr__input--pin"
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="••••"
          autoFocus
          onKeyDown={(e) => e.key === "Enter" && confirmAction()}
        />
      </label>
      <div className="staffmgr__modal-actions">
        <button className="staffmgr__btn" onClick={cancelAction} disabled={busy}>
          Cancel
        </button>
        <button className="staffmgr__btn staffmgr__btn--save" onClick={confirmAction} disabled={busy}>
          {busy ? "Confirming…" : ACTION_LABELS[pendingAction]}
        </button>
      </div>
    </div>
  );

  const renderBody = () => {
    if (loading) return <div className="staffmgr__notice">Loading…</div>;
    if (loadError) return <div className="staffmgr__error">{loadError}</div>;
    if (pendingAction) return renderPinPrompt();

    if (status === "not_clocked_in") {
      return (
        <>
          {endedSummary && (
            <div className="clockcard__summary">
              Hours worked: <strong>{fmtDuration(endedSummary.workedSeconds)}</strong>
              {" · "}
              Break time: <strong>{fmtDuration(endedSummary.breakSeconds)}</strong>
            </div>
          )}
          <div className="clockcard__action-row">
            <button
              className="clockcard__action-btn clockcard__action-btn--start"
              onClick={() => {
                setEndedSummary(null);
                startAction("start_shift");
              }}
            >
              Start Shift
            </button>
            <button className="clockcard__action-btn" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      );
    }

    if (status === "working") {
      // Worked time = elapsed since clock-in MINUS completed breaks, so the
      // number reflects actual time on the clock, not raw elapsed.
      const worked = (nowMs - new Date(clockIn).getTime()) / 1000 - breakSeconds;
      return (
        <>
          <div className="clockcard__timer">
            Worked
            <strong>{fmtDuration(worked)}</strong>
          </div>
          <div className="clockcard__action-row">
            <button className="clockcard__action-btn" onClick={() => startAction("take_break")}>
              Take Break
            </button>
            <button
              className="clockcard__action-btn clockcard__action-btn--end"
              onClick={() => startAction("end_shift")}
            >
              End Shift
            </button>
          </div>
        </>
      );
    }

    if (status === "on_break") {
      const seconds = (nowMs - new Date(breakStart).getTime()) / 1000;
      return (
        <>
          <div className="clockcard__timer clockcard__timer--break">
            On break for
            <strong>{fmtDuration(seconds)}</strong>
          </div>
          <div className="clockcard__action-row">
            <button className="clockcard__action-btn" onClick={() => startAction("end_break")}>
              End Break
            </button>
            <button
              className="clockcard__action-btn clockcard__action-btn--end"
              onClick={() => startAction("end_shift")}
            >
              End Shift
            </button>
          </div>
        </>
      );
    }

    return null;
  };

  return (
    <div className="staffmgr__overlay" onClick={busy ? undefined : onClose}>
      <div className="staffmgr__modal clockcard__modal" onClick={(e) => e.stopPropagation()}>
        <div className="staffmgr__modal-head">
          <h3 className="staffmgr__modal-title">Clock In/Out</h3>
          <button
            className="staffmgr__modal-close clockcard__close"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="staffmgr__modal-body clockcard__body">{renderBody()}</div>
      </div>
    </div>
  );
}
