import { useState } from "react";
import logoImg from "../assets/narcos-tacos-logo.png";
import { API_URL } from "../config";
import { formatDuration } from "../format";
import "./PinLogin.css";
import "./DevicePairingScreen.css";

// Best-effort label parsed from the browser's user-agent — shown as a
// pre-filled starting point, never presented as authoritative. There is
// no web API that can read a device's actual OS-level name (e.g. the
// "Omer's iPhone" shown in iOS Settings/Bluetooth) — that's native-app-
// only. Square/Toast/Clover/Shopify POS all solve this the same way:
// a human types the real terminal name once, at setup.
function guessDeviceName() {
  const ua = navigator.userAgent || "";

  let device = "Device";
  if (/iPad/.test(ua)) device = "iPad";
  else if (/iPhone/.test(ua)) device = "iPhone";
  else if (/Android/.test(ua)) device = /Mobile/.test(ua) ? "Android Phone" : "Android Tablet";
  else if (/Macintosh/.test(ua)) device = "Mac";
  else if (/Windows/.test(ua)) device = "Windows PC";
  else if (/Linux/.test(ua)) device = "Linux PC";

  let browser = "";
  if (/CriOS/.test(ua)) browser = "Chrome";
  else if (/EdgiOS|Edg\//.test(ua)) browser = "Edge";
  else if (/FxiOS|Firefox/.test(ua)) browser = "Firefox";
  else if (/Chrome/.test(ua) && !/Chromium/.test(ua)) browser = "Chrome";
  else if (/Safari/.test(ua) && !/Chrome/.test(ua)) browser = "Safari";

  return browser ? `${device} · ${browser}` : device;
}

/**
 * Full-screen form shown by RequireDevicePairing whenever the current
 * device has no valid, unrevoked pairing — replaces the PIN pad (Order
 * Entry) or the board (KDS) entirely until pairing succeeds. Shares the
 * .login-screen/.login-card/.brand-logo/.login-footer shell with
 * PinLogin/BackofficeLogin (see PinLogin.css) for a consistent look;
 * DevicePairingScreen.css holds only the form-specific pieces.
 *
 * On success, calls onPaired() rather than reloading the page — the
 * device cookie was just set by the server response, so the parent
 * (RequireDevicePairing) just needs to flip its own state to render the
 * real screen next.
 */
export default function DevicePairingScreen({ onPaired }) {
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState(guessDeviceName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [lockoutSeconds, setLockoutSeconds] = useState(0);

  const disabled = submitting || lockoutSeconds > 0;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (disabled) return;
    if (!code.trim()) {
      setError("Enter the pairing code shown in Back Office");
      return;
    }
    if (!deviceName.trim()) {
      setError("Give this device a name");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/api/devices/pair`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim(), deviceName: deviceName.trim() }),
      });
      const data = await res.json();

      if (res.ok && data.success) {
        onPaired();
        return;
      }

      if (res.status === 429) {
        setLockoutSeconds(data.retryAfter || 300);
        setError(data.error || "Too many attempts");
        return;
      }

      setError(data.error || "Failed to pair device");
    } catch {
      setError("Connection error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card devicepair">
        <div className="brand-logo">
          <img src={logoImg} alt="NARCOS TACOS" className="brand-logo__img" />
        </div>

        <div className="devicepair__panel">
          <div className="devicepair__title">Pair This Device</div>
          <p className="devicepair__notice">
            Ask an owner or admin to generate a pairing code in Back Office, then enter it below.
          </p>

          {error && <div className="devicepair__error">{error}</div>}
          {lockoutSeconds > 0 && (
            <div className="devicepair__error devicepair__error--lockout">
              Locked out — try again in {formatDuration(lockoutSeconds)}
            </div>
          )}

          <form className="devicepair__form" onSubmit={handleSubmit}>
            <label className="devicepair__label-field">
              Pairing code
              <input
                className="devicepair__input devicepair__input--code"
                value={code}
                onChange={(e) => {
                  setError("");
                  setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8));
                }}
                placeholder="XXXXXXXX"
                autoCapitalize="characters"
                autoCorrect="off"
                autoComplete="off"
                disabled={disabled}
                autoFocus
              />
            </label>

            <label className="devicepair__label-field">
              Device name
              <input
                className="devicepair__input"
                value={deviceName}
                onChange={(e) => {
                  setError("");
                  setDeviceName(e.target.value.slice(0, 60));
                }}
                placeholder="e.g. Front Counter iPad"
                disabled={disabled}
              />
            </label>
            <p className="devicepair__hint">
              This name shows up in Back Office's device list — pick something the team will recognize.
            </p>

            <button type="submit" className="devicepair__submit" disabled={disabled}>
              {submitting ? "Pairing…" : "Pair Device"}
            </button>
          </form>
        </div>

        <div className="login-footer">Narcos Tacos POS v1.0</div>
      </div>
    </div>
  );
}
