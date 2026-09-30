import { useState } from "react";
import logoImg from "../assets/narcos-tacos-logo.png";
import { API_URL } from "../config";
import { formatDuration } from "../format";
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
//   choice       — owner/admin with a phone on file: SMS code or authenticator
//                  (after login-step1 or setup-complete; P3 Slice 3)
//   sms          — 6-digit code texted to the phone on their staff row
//   forgot       — email input for a reset link, or a texted code instead
//   forgot-sent  — generic confirmation, same regardless of what was typed
//   forgot-sms   — texted code + new password
//   forgot-sms-done — password changed
export default function BackofficeLogin({ onLogin }) {
  const [screen, setScreen] = useState("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Carried between steps
  const [tempToken, setTempToken] = useState(null);
  const [setupName, setSetupName] = useState("");
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState(null);
  const [otpauthUrl, setOtpauthUrl] = useState(null);
  const [choice, setChoice] = useState(null); // { tempToken, phoneHint, totp }
  const [smsMessage, setSmsMessage] = useState("");
  const [forgotEmail, setForgotEmail] = useState("");

  const resetToLogin = () => {
    setScreen("login");
    setError("");
    setTempToken(null);
    setQrCodeDataUrl(null);
    setOtpauthUrl(null);
    setChoice(null);
    setSmsMessage("");
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

  // Routes any second-step response by its stage.
  const handleStage = (data) => {
    setError("");
    if (data.stage === "2fa_setup") return handleTotpSetupResponse(data);
    if (data.stage === "2fa_choice") {
      setChoice(data);
      return setScreen("choice");
    }
    if (data.stage === "2fa_sms") {
      setTempToken(data.tempToken);
      setSmsMessage(data.message);
      return setScreen("sms");
    }
    setTempToken(data.tempToken);
    setScreen("totp");
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
            onStage={handleStage}
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
            onSetupStarted={handleStage}
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

        {screen === "choice" && choice && (
          <ChoiceForm
            choice={choice}
            busy={busy}
            setBusy={setBusy}
            error={error}
            setError={setError}
            onStage={handleStage}
            onCancel={resetToLogin}
          />
        )}

        {screen === "sms" && (
          <SmsCodeForm
            tempToken={tempToken}
            message={smsMessage}
            choice={choice}
            busy={busy}
            setBusy={setBusy}
            error={error}
            setError={setError}
            onStage={handleStage}
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
            onSmsSent={(email, message) => {
              setForgotEmail(email);
              setSmsMessage(message);
              setScreen("forgot-sms");
            }}
            onCancel={resetToLogin}
          />
        )}

        {screen === "forgot-sms" && (
          <ForgotSmsForm
            email={forgotEmail}
            message={smsMessage}
            busy={busy}
            setBusy={setBusy}
            error={error}
            setError={setError}
            onDone={() => setScreen("forgot-sms-done")}
            onCancel={resetToLogin}
          />
        )}

        {screen === "forgot-sms-done" && (
          <div className="bol__panel">
            <p className="bol__notice">Your password has been changed. Log in with it now.</p>
            <button className="bol__link" onClick={resetToLogin}>
              Back to login
            </button>
          </div>
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

function LoginForm({ busy, setBusy, error, setError, onStage, onGoSetup, onGoForgot }) {
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
          setError(data.error || `Too many attempts — try again in ${formatDuration(data.retryAfter || 300)}`);
        } else {
          setError(data.error || "Login failed");
        }
        return;
      }
      onStage(data);
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
          setError(data.error || `Too many attempts — try again in ${formatDuration(data.retryAfter || 300)}`);
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
        {busy ? "Saving…" : "Continue"}
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
          setError(data.error || `Too many attempts — try again in ${formatDuration(data.retryAfter || 300)}`);
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

function ForgotPasswordForm({ busy, setBusy, error, setError, onSent, onSmsSent, onCancel }) {
  const [email, setEmail] = useState("");

  // Texted code instead of the emailed link — owner/admin with a phone on
  // file only; everyone else gets the same generic message and nothing sent.
  const sendSms = async () => {
    if (busy || !email.trim()) return;
    setBusy(true);
    setError("");
    try {
      const data = await postJson("/api/backoffice/auth/forgot-password-sms", { email });
      onSmsSent(email, data.message);
    } catch (e) {
      setError(e.message || "Connection error");
    } finally {
      setBusy(false);
    }
  };

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
        setError(data.error || `Too many attempts — try again in ${formatDuration(data.retryAfter || 300)}`);
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
        {busy ? "Sending…" : "Email me a reset link"}
      </button>
      <button
        type="button"
        className="bol__submit bol__submit--secondary"
        onClick={sendSms}
        disabled={busy || !email.trim()}
      >
        Text me a code instead
      </button>
      <button type="button" className="bol__link" onClick={onCancel}>
        Back to login
      </button>
    </form>
  );
}

async function postJson(path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Owner/admin with a phone on file: pick how to prove it's you. Never both.
function ChoiceForm({ choice, busy, setBusy, error, setError, onStage, onCancel }) {
  const choose = async (method) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      onStage(await postJson("/api/backoffice/auth/2fa/choose", { tempToken: choice.tempToken, method }));
    } catch (e) {
      setError(e.message || "Connection error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bol__panel">
      <div className="bol__panel-title">How do you want to verify?</div>
      <ErrorBanner error={error} />
      <button className="bol__submit" onClick={() => choose("sms")} disabled={busy}>
        Text a code to {choice.phoneHint}
      </button>
      <button className="bol__submit bol__submit--secondary" onClick={() => choose("totp")} disabled={busy}>
        {choice.totp === "verify" ? "Authenticator app" : "Set up an authenticator app"}
      </button>
      <button type="button" className="bol__link" onClick={onCancel}>
        Back to login
      </button>
    </div>
  );
}

function SmsCodeForm({ tempToken, message, choice, busy, setBusy, error, setError, onStage, onSuccess, onCancel }) {
  const [code, setCode] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      onSuccess(await postJson("/api/backoffice/auth/2fa/sms/verify", { tempToken, code }));
    } catch (err) {
      setError(err.message || "Incorrect code");
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  // Resend = choose SMS again. The server keeps the last live code if a
  // resend is refused by the send limit.
  const resend = async () => {
    if (busy || !choice) return;
    setBusy(true);
    try {
      onStage(await postJson("/api/backoffice/auth/2fa/choose", { tempToken: choice.tempToken, method: "sms" }));
    } catch (err) {
      setError(err.message || "Connection error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="bol__panel" onSubmit={submit}>
      <div className="bol__panel-title">Enter the code we texted you</div>
      <p className="bol__notice">{message}</p>
      <ErrorBanner error={error} />
      <input
        className="bol__input bol__input--totp"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        placeholder="000000"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        required
      />
      <button className="bol__submit" type="submit" disabled={busy || code.length !== 6}>
        {busy ? "Verifying…" : "Log In"}
      </button>
      <div className="bol__links">
        <button type="button" className="bol__link" onClick={resend} disabled={busy}>
          Resend code
        </button>
        {choice && (
          <button type="button" className="bol__link" onClick={() => onStage(choice)} disabled={busy}>
            Use a different method
          </button>
        )}
        <button type="button" className="bol__link" onClick={onCancel}>
          Back to login
        </button>
      </div>
    </form>
  );
}

function ForgotSmsForm({ email, message, busy, setBusy, error, setError, onDone, onCancel }) {
  const [code, setCode] = useState("");
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
      await postJson("/api/backoffice/auth/reset-password-sms", { email, code, newPassword: password });
      onDone();
    } catch (err) {
      setError(err.message || "Failed to reset password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="bol__panel" onSubmit={submit}>
      <div className="bol__panel-title">Reset your password</div>
      <p className="bol__notice">{message}</p>
      <ErrorBanner error={error} />
      <label className="bol__label-field">
        Code
        <input
          className="bol__input bol__input--totp"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="000000"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          required
        />
      </label>
      <label className="bol__label-field">
        New password
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
      <button className="bol__submit" type="submit" disabled={busy || code.length !== 6}>
        {busy ? "Saving…" : "Set new password"}
      </button>
      <button type="button" className="bol__link" onClick={onCancel}>
        Back to login
      </button>
    </form>
  );
}
