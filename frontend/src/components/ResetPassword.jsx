import { useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import logoImg from "../assets/narcos-tacos-logo.png";
import { API_URL } from "../config";
import "./PinLogin.css";
import "./BackofficeLogin.css";

// Reached via the link emailed by POST /api/backoffice/auth/forgot-password
// — /backoffice/reset-password?token=... . No auth required to VIEW this
// page (the token itself, checked server-side, is the proof); it's a
// standalone route, not nested inside BackOffice.jsx's staff/session state.
export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!token) {
      setError("This reset link is missing its token — request a new one from the Back Office login screen.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/api/backoffice/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to reset password");
        return;
      }
      setDone(true);
    } catch {
      setError("Connection error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card bol">
        <div className="brand-logo">
          <img src={logoImg} alt="NARCOS TACOS" className="brand-logo__img" />
        </div>
        <div className="bol__label">Back Office</div>

        {done ? (
          <div className="bol__panel">
            <div className="bol__panel-title">Password reset</div>
            <p className="bol__notice">Your password has been changed. You can now log in with it.</p>
            <Link className="bol__submit" to="/backoffice" style={{ textAlign: "center", textDecoration: "none" }}>
              Back to Login
            </Link>
          </div>
        ) : (
          <form className="bol__panel" onSubmit={submit}>
            <div className="bol__panel-title">Set a new password</div>
            {!token && (
              <p className="bol__notice">
                No reset token found in this link. Request a new one from the Back Office login screen.
              </p>
            )}
            {error && <div className="bol__error">{error}</div>}
            <label className="bol__label-field">
              New password
              <input
                className="bol__input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                minLength={10}
                autoFocus
                required
              />
            </label>
            <label className="bol__label-field">
              Confirm new password
              <input
                className="bol__input"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                minLength={10}
                required
              />
            </label>
            <p className="bol__hint">At least 10 characters.</p>
            <button className="bol__submit" type="submit" disabled={busy || !token}>
              {busy ? "Saving…" : "Reset Password"}
            </button>
          </form>
        )}

        <div className="login-footer">Narcos Tacos POS v1.0</div>
      </div>
    </div>
  );
}
