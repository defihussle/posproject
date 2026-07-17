import { useState } from "react";
import logoImg from "../assets/narcos-tacos-logo.png";
import { API_URL } from "../config";
import "./PinLogin.css";
import "./BackofficeLogin.css";

// Back Office's login — email + password + TOTP 2FA, owner/admin only.
// Completely separate from Order Entry/KDS's PIN login (PinLogin.jsx),
// which this never touches or calls into. Shares PinLogin.css's
// .login-screen/.login-card/.brand-logo/.login-footer shell for a
// consistent look, everything below that is form-specific (BackofficeLogin.css).
//
// Screens:
//   login        — email + password (the normal returning-user path)
//   setup-pin    — one-time: existing PIN proves identity for an
//                  owner/admin who has no email/password yet
//   setup-account— one-time: pick the email + password to log in with
//   setup-totp   — QR code + confirm code (first-time, or a resumed/
//                  interrupted setup — login-step1 lands here too if
//                  totp_enabled is still false)
//   totp         — 6-digit code (returning login, TOTP already enabled)
//   forgot       — email input for a reset link
//   forgot-sent  — generic confirmation, same regardless of what was typed
export default function BackofficeLogin({ onLogin }) {
  const [screen, setScreen] = useState("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Carried between steps
  const [tempToken, setTempToken] = useState(null);
  const [setupName, setSetupName] = useState("");
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState(null);
  const [otpauthUrl, setOtpauthUrl] = useState(null);

  const resetToLogin = () => {
    setScreen("login");
    setError("");
    setTempToken(null);
    setQrCodeDataUrl(null);
    setOtpauthUrl(null);
  };

  const handleTotpSetupResponse = (data) => {
    // Shared shape returned by both login-step1 (resumed setup) and
    // setup-complete (first-time) — { stage: "2fa_setup", tempToken,
    // otpauthUrl, qrCodeDataUrl }.
    setTempToken(data.tempToken);
    setOtpauthUrl(data.otpauthUrl);
    setQrCodeDataUrl(data.qrCodeDataUrl);
    setScreen("setup-totp");
  };

  return (
    <div className="login-screen">
      <div className="login-card bol">
        <div className="brand-logo">
          <img src={logoImg} alt="NARCOS TACOS" className="brand-logo__img" />
        </div>
        <div className="bol__label">Back Office</div>

        {screen === "login" && (
          <LoginForm
            busy={busy}
            setBusy={setBusy}
            error={error}
            setError={setError}
            onNeedTotp={(tt) => {
              setTempToken(tt);
              setScreen("totp");
            }}
            onNeedTotpSetup={handleTotpSetupResponse}
            onGoSetup={() => {
              setError("");
              setScreen("setup-pin");
            }}
            onGoForgot={() => {
              setError("");
              setScreen("forgot");
            }}
          />
        )}

        {screen === "setup-pin" && (
          <SetupPinForm
            busy={busy}
            setBusy={setBusy}
            error={error}
            setError={setError}
            onVerified={(tt, name) => {
              setTempToken(tt);
              setSetupName(name);
              setError("");
              setScreen("setup-account");
            }}
            onCancel={resetToLogin}
          />
        )}

        {screen === "setup-account" && (
          <SetupAccountForm
            name={setupName}
            tempToken={tempToken}
            busy={busy}
            setBusy={setBusy}
            error={error}
            setError={setError}
            onSetupStarted={handleTotpSetupResponse}
            onCancel={resetToLogin}
          />
        )}

        {screen === "setup-totp" && (
          <TotpForm
            mode="setup"
            tempToken={tempToken}
            qrCodeDataUrl={qrCodeDataUrl}
            otpauthUrl={otpauthUrl}
            busy={busy}
            setBusy={setBusy}
            error={error}
            setError={setError}
            onSuccess={onLogin}
            onCancel={resetToLogin}
          />
        )}

        {screen === "totp" && (
          <TotpForm
            mode="login"
            tempToken={tempToken}
            busy={busy}
            setBusy={setBusy}
            error={error}
            setError={setError}
            onSuccess={onLogin}
            onCancel={resetToLogin}
          />
        )}

        {screen === "forgot" && (
          <ForgotPasswordForm
            busy={busy}
            setBusy={setBusy}
            error={error}
            setError={setError}
            onSent={() => setScreen("forgot-sent")}
            onCancel={resetToLogin}
          />
        )}

        {screen === "forgot-sent" && (
          <div className="bol__panel">
            <p className="bol__notice">
              If that email has a Back Office account, a reset link has been sent. It expires in 1 hour.
            </p>
            <button className="bol__link" onClick={resetToLogin}>
              Back to login
            </button>
          </div>
        )}

        <div className="login-footer">Narcos Tacos POS v1.0</div>
      </div>
    </div>
  );
}

function ErrorBanner({ error }) {
  if (!error) return null;
  return <div className="bol__error">{error}</div>;
}

function LoginForm({ busy, setBusy, error, setError, onNeedTotp, onNeedTotpSetup, onGoSetup, onGoForgot }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/api/backoffice/auth/login-step1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 429) {
          setError(`Too many attempts — try again in ${data.retryAfter || 30}s`);
        } else {
          setError(data.error || "Login failed");
        }
        return;
      }
      if (data.stage === "2fa_setup") {
        onNeedTotpSetup(data);
      } else {
        onNeedTotp(data.tempToken);
      }
    } catch {
      setError("Connection error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="bol__panel" onSubmit={submit}>
      <ErrorBanner error={error} />
      <label className="bol__label-field">
        Email
        <input
          className="bol__input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          autoFocus
          required
        />
      </label>
      <label className="bol__label-field">
        Password
        <input
          className="bol__input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <button className="bol__submit" type="submit" disabled={busy}>
        {busy ? "Checking…" : "Log In"}
      </button>
      <div className="bol__links">
        <button type="button" className="bol__link" onClick={onGoForgot}>
          Forgot password?
        </button>
        <button type="button" className="bol__link" onClick={onGoSetup}>
          First time? Set up your Back Office login
        </button>
      </div>
    </form>
  );
}

function SetupPinForm({ busy, setBusy, error, setError, onVerified, onCancel }) {
  const [pin, setPin] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/api/backoffice/auth/setup-start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ pin }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 429) {
          setError(`Too many attempts — try again in ${data.retryAfter || 30}s`);
        } else {
          setError(data.error || "PIN not recognized");
        }
        return;
      }
      onVerified(data.tempToken, data.name);
    } catch {
      setError("Connection error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="bol__panel" onSubmit={submit}>
      <div className="bol__panel-title">First-time setup</div>
      <p className="bol__notice">Enter your existing 4-digit PIN to confirm it's you.</p>
      <ErrorBanner error={error} />
      <input
        className="bol__input bol__input--pin"
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
        placeholder="••••"
        inputMode="numeric"
        autoFocus
        required
      />
      <button className="bol__submit" type="submit" disabled={busy || pin.length !== 4}>
        {busy ? "Checking…" : "Continue"}
      </button>
      <button type="button" className="bol__link" onClick={onCancel}>
        Back to login
      </button>
    </form>
  );
}

function SetupAccountForm({ name, tempToken, busy, setBusy, error, setError, onSetupStarted, onCancel }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/api/backoffice/auth/setup-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tempToken, email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to set up account");
        return;
      }
      onSetupStarted(data);
    } catch {
      setError("Connection error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="bol__panel" onSubmit={submit}>
      <div className="bol__panel-title">Setting up Back Office login{name ? ` — ${name}` : ""}</div>
      <ErrorBanner error={error} />
      <label className="bol__label-field">
        Email
        <input
          className="bol__input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          autoFocus
          required
        />
      </label>
      <label className="bol__label-field">
        Password
        <input
          className="bol__input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={10}
          required
        />
      </label>
      <label className="bol__label-field">
        Confirm password
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
      <button className="bol__submit" type="submit" disabled={busy}>
        {busy ? "Saving…" : "Continue to 2FA setup"}
      </button>
      <button type="button" className="bol__link" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

// Handles BOTH the first-time/resumed QR setup (mode="setup", hits
// setup-confirm) and the returning-login code entry (mode="login", hits
// login-step2) — same 6-digit-code UI, just a different endpoint and an
// extra QR block when mode="setup".
function TotpForm({ mode, tempToken, qrCodeDataUrl, otpauthUrl, busy, setBusy, error, setError, onSuccess, onCancel }) {
  const [code, setCode] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const endpoint = mode === "setup" ? "setup-confirm" : "login-step2";
      const res = await fetch(`${API_URL}/api/backoffice/auth/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tempToken, totpCode: code }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 429) {
          setError(`Too many attempts — try again in ${data.retryAfter || 30}s`);
        } else {
          setError(data.error || "Incorrect code");
        }
        setCode("");
        return;
      }
      onSuccess(data);
    } catch {
      setError("Connection error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="bol__panel" onSubmit={submit}>
      {mode === "setup" && (
        <>
          <div className="bol__panel-title">Set up two-factor authentication</div>
          <p className="bol__notice">
            Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.).
          </p>
          {qrCodeDataUrl && (
            <img className="bol__qr" src={qrCodeDataUrl} alt="TOTP QR code" width={180} height={180} />
          )}
          {otpauthUrl && (
            <details className="bol__manual">
              <summary>Can't scan? Enter manually</summary>
              <code className="bol__manual-code">
                {new URL(otpauthUrl).searchParams.get("secret")}
              </code>
            </details>
          )}
          <p className="bol__hint">Then enter the 6-digit code it generates to confirm setup.</p>
        </>
      )}
      {mode === "login" && (
        <>
          <div className="bol__panel-title">Enter your 2FA code</div>
          <p className="bol__notice">Open your authenticator app for the current 6-digit code.</p>
        </>
      )}
      <ErrorBanner error={error} />
      <input
        className="bol__input bol__input--totp"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        placeholder="000000"
        inputMode="numeric"
        autoFocus
        required
      />
      <button className="bol__submit" type="submit" disabled={busy || code.length !== 6}>
        {busy ? "Verifying…" : mode === "setup" ? "Confirm & Finish Setup" : "Log In"}
      </button>
      <button type="button" className="bol__link" onClick={onCancel}>
        Back to login
      </button>
    </form>
  );
}

function ForgotPasswordForm({ busy, setBusy, error, setError, onSent, onCancel }) {
  const [email, setEmail] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/api/backoffice/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email }),
      });
      if (res.status === 429) {
        const data = await res.json();
        setError(`Too many attempts — try again in ${data.retryAfter || 30}s`);
        return;
      }
      onSent();
    } catch {
      setError("Connection error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="bol__panel" onSubmit={submit}>
      <div className="bol__panel-title">Reset your password</div>
      <ErrorBanner error={error} />
      <label className="bol__label-field">
        Email
        <input
          className="bol__input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          autoFocus
          required
        />
      </label>
      <button className="bol__submit" type="submit" disabled={busy}>
        {busy ? "Sending…" : "Send Reset Link"}
      </button>
      <button type="button" className="bol__link" onClick={onCancel}>
        Back to login
      </button>
    </form>
  );
}
