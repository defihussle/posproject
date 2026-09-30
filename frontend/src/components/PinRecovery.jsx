import { useState, useEffect } from "react";
import { API_URL } from "../config";

// Order Entry "Set up PIN" / "Forgot PIN" (P3 Slice 2). One flow for both:
// phone → code → new PIN. The server decides whether this is a first PIN or a
// reset from whether the matched staff row already has one, so the entry
// button only changes the heading. Every call sends the device cookie — the
// routes are device-gated like PIN login.
//
// The "we sent a code" step reads the same whether or not the number matched
// anyone, so this screen can't be used to find out whose number is on file.

const RESEND_WAIT_S = 60;

async function post(path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

export default function PinRecovery({ mode, onDone, onCancel }) {
  const [step, setStep] = useState("phone"); // phone | code | pin | done
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [token, setToken] = useState(null);
  const [purpose, setPurpose] = useState(null);
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const run = async (fn) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const sendCode = () =>
    run(async () => {
      const data = await post("/api/auth/pin-code/send", { phone });
      setNotice(data.message);
      setCode("");
      setStep("code");
      setResendIn(RESEND_WAIT_S);
    });

  const verifyCode = () =>
    run(async () => {
      const data = await post("/api/auth/pin-code/verify", { phone, code });
      setToken(data.token);
      setPurpose(data.purpose);
      setStep("pin");
    });

  const savePin = () =>
    run(async () => {
      if (!/^\d{4}$/.test(pin)) throw new Error("PIN must be exactly 4 digits");
      if (pin !== confirmPin) throw new Error("PINs don't match");
      await post("/api/auth/pin-code/complete", { token, pin });
      setStep("done");
    });

  const title = mode === "setup" ? "Set up your PIN" : "Forgot PIN";
  const creating = purpose ? purpose === "pin_setup" : mode === "setup";
  const onKey = (action) => (e) => {
    if (e.key === "Enter") action();
  };

  return (
    <div className="pinrec">
      <h2 className="pinrec__title">{title}</h2>

      {step === "phone" && (
        <>
          <p className="pinrec__hint">Enter the phone number your manager saved for you.</p>
          <input
            className="pinrec__input"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="(416) 555-1234"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={onKey(sendCode)}
            autoFocus
          />
          <button className="pinrec__btn pinrec__btn--primary" onClick={sendCode} disabled={busy || !phone.trim()}>
            {busy ? "Sending…" : "Text me a code"}
          </button>
        </>
      )}

      {step === "code" && (
        <>
          <p className="pinrec__hint">{notice}</p>
          <input
            className="pinrec__input pinrec__input--code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            onKeyDown={onKey(verifyCode)}
            autoFocus
          />
          <button
            className="pinrec__btn pinrec__btn--primary"
            onClick={verifyCode}
            disabled={busy || code.length !== 6}
          >
            {busy ? "Checking…" : "Continue"}
          </button>
          <button className="pinrec__link" onClick={sendCode} disabled={busy || resendIn > 0}>
            {resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend code"}
          </button>
        </>
      )}

      {step === "pin" && (
        <>
          <p className="pinrec__hint">{creating ? "Choose a 4-digit PIN." : "Choose a new 4-digit PIN."}</p>
          <input
            className="pinrec__input pinrec__input--code"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder={creating ? "PIN" : "New PIN"}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            autoFocus
          />
          <input
            className="pinrec__input pinrec__input--code"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder="Confirm PIN"
            value={confirmPin}
            onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            onKeyDown={onKey(savePin)}
          />
          <button
            className="pinrec__btn pinrec__btn--primary"
            onClick={savePin}
            disabled={busy || pin.length !== 4 || confirmPin.length !== 4}
          >
            {busy ? "Saving…" : creating ? "Create PIN" : "Save new PIN"}
          </button>
        </>
      )}

      {step === "done" && (
        <>
          <p className="pinrec__hint">{creating ? "Your PIN is set." : "Your PIN has been changed."} Log in with it now.</p>
          <button className="pinrec__btn pinrec__btn--primary" onClick={onDone} autoFocus>
            Back to login
          </button>
        </>
      )}

      {error && <p className="pinrec__error">{error}</p>}

      {step !== "done" && (
        <button className="pinrec__link" onClick={onCancel} disabled={busy}>
          Back to PIN pad
        </button>
      )}
    </div>
  );
}
