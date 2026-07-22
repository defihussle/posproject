import { useState, useEffect, useCallback } from "react";
import logoImg from "../assets/narcos-tacos-logo.png";
import { API_URL } from "../config";
import { formatDuration } from "../format";
import "./PinLogin.css";

const KEYPAD_KEYS = [
  { digit: "1", letters: "" },
  { digit: "2", letters: "ABC" },
  { digit: "3", letters: "DEF" },
  { digit: "4", letters: "GHI" },
  { digit: "5", letters: "JKL" },
  { digit: "6", letters: "MNO" },
  { digit: "7", letters: "PQRS" },
  { digit: "8", letters: "TUV" },
  { digit: "9", letters: "WXYZ" },
];

export default function PinLogin({ onLogin }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [shaking, setShaking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lockoutEnd, setLockoutEnd] = useState(null);
  const [lockoutSeconds, setLockoutSeconds] = useState(0);

  const isLockedOut = lockoutEnd && Date.now() < lockoutEnd;
  const disabled = loading || isLockedOut;

  // Lockout countdown timer. Lockout state comes ENTIRELY from the server
  // now (keyed by the specific PIN, 3 wrong attempts -> 5 min) — this
  // component just reflects whatever retryAfter the server last reported,
  // it doesn't independently decide anything is locked.
  useEffect(() => {
    if (!lockoutEnd) return;

    const tick = () => {
      const remaining = Math.ceil((lockoutEnd - Date.now()) / 1000);
      if (remaining <= 0) {
        setLockoutEnd(null);
        setLockoutSeconds(0);
        setError("");
      } else {
        setLockoutSeconds(remaining);
      }
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [lockoutEnd]);

  // Submit PIN when 4 digits entered
  useEffect(() => {
    if (pin.length !== 4) return;

    const submit = async () => {
      setLoading(true);
      setError("");

      try {
        const res = await fetch(`${API_URL}/api/auth/login`, {
          method: "POST",
          // Sends the httpOnly device-pairing cookie — /api/auth/login is
          // device-gated, so without this the backend 401s ("device isn't
          // paired") even on a paired device and it looks like a bad PIN.
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin }),
        });

        const data = await res.json();

        if (res.ok && data.success) {
          onLogin(data.staff);
          return;
        }

        // Rate limited — this specific PIN has hit 3 wrong attempts.
        // Doesn't affect any other PIN on this device.
        if (res.status === 429) {
          const retryAfter = data.retryAfter || 300;
          setLockoutEnd(Date.now() + retryAfter * 1000);
          setError(data.message || "Too many attempts");
          triggerShake();
          return;
        }

        // Wrong PIN — just a normal miss, no local counting; the server
        // is the only thing that decides when a PIN is locked out.
        setError(data.message || "PIN not recognized");
        triggerShake();
      } catch {
        setError("Connection error");
        triggerShake();
      } finally {
        setLoading(false);
      }
    };

    submit();
  }, [pin]);

  const triggerShake = useCallback(() => {
    setShaking(true);
    setTimeout(() => {
      setShaking(false);
      setPin("");
    }, 500);
  }, []);

  const handleDigit = useCallback(
    (digit) => {
      if (disabled || pin.length >= 4) return;
      setError("");
      setPin((prev) => prev + digit);
    },
    [disabled, pin]
  );

  const handleBackspace = useCallback(() => {
    if (disabled) return;
    setError("");
    setPin((prev) => prev.slice(0, -1));
  }, [disabled]);

  // Keyboard support
  useEffect(() => {
    const handler = (e) => {
      if (e.key >= "0" && e.key <= "9") {
        handleDigit(e.key);
      } else if (e.key === "Backspace") {
        handleBackspace();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleDigit, handleBackspace]);

  const getStatusText = () => {
    if (lockoutEnd && lockoutSeconds > 0) {
      return { text: `Locked out — ${formatDuration(lockoutSeconds)}`, className: "pin-status__text--lockout" };
    }
    if (error) {
      return { text: error, className: "pin-status__text--error" };
    }
    if (loading) {
      return { text: "Verifying…", className: "" };
    }
    return { text: "Enter your PIN", className: "" };
  };

  const status = getStatusText();

  return (
    <div className="login-screen">
      <div className="login-card">
        {/* Brand Logo — enlarged on this screen only via brand-logo--pin;
            Back Office login/reset share brand-logo__img too but stay at
            the original size (they don't get this modifier class). */}
        <div className="brand-logo brand-logo--pin">
          <img src={logoImg} alt="NARCOS TACOS" className="brand-logo__img" />
        </div>

        {/* PIN Dots */}
        <div className={`pin-dots${shaking ? " shake" : ""}${error ? " pin-dots--error" : ""}`}>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={`pin-dot${i < pin.length ? " pin-dot--filled" : ""}`}
            />
          ))}
        </div>

        {/* Status */}
        <div className="pin-status">
          <span className={`pin-status__text ${status.className}`}>{status.text}</span>
        </div>

        {/* Keypad */}
        <div className="keypad">
          {KEYPAD_KEYS.map(({ digit, letters }) => (
            <button
              key={digit}
              id={`key-${digit}`}
              type="button"
              className={`keypad__key${disabled ? " keypad__key--disabled" : ""}`}
              onClick={() => handleDigit(digit)}
              disabled={disabled}
            >
              <span className="keypad__digit">{digit}</span>
              {letters && <span className="keypad__letters">{letters}</span>}
            </button>
          ))}

          {/* Empty cell */}
          <div />

          {/* Zero key */}
          <button
            id="key-0"
            type="button"
            className={`keypad__key${disabled ? " keypad__key--disabled" : ""}`}
            onClick={() => handleDigit("0")}
            disabled={disabled}
          >
            <span className="keypad__digit">0</span>
          </button>

          {/* Backspace */}
          <button
            id="key-backspace"
            type="button"
            className={`keypad__key keypad__key--action${disabled ? " keypad__key--disabled" : ""}`}
            onClick={handleBackspace}
            disabled={disabled}
            aria-label="Backspace"
          >
            <svg className="keypad__action-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
              <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        </div>

        {/* Footer */}
        <div className="login-footer">
          Narcos Tacos POS v1.0
        </div>
      </div>
    </div>
  );
}
