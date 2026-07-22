import { useState, useEffect, useCallback, cloneElement, isValidElement } from "react";
import logoImg from "../assets/narcos-tacos-logo.png";
import { API_URL } from "../config";
import DevicePairingScreen from "./DevicePairingScreen";
import "./PinLogin.css";

// How often to retry GET /api/devices/me after a network/server error
// (NOT after a clean "not paired" response — see the status machine
// below). A brief connectivity blip on an already-paired, unattended KDS
// screen shouldn't bounce it to the pairing form; it should just retry
// until it gets a real answer.
const RETRY_MS = 5000;

/**
 * Route guard wrapping /order-entry and the KDS route in App.jsx — the
 * device-level trust layer that sits UNDERNEATH staffId/PIN identity
 * (device-pairing-plan.md, "Background"). Renders DevicePairingScreen
 * instead of `children` whenever the current device has no valid,
 * unrevoked pairing; once paired, renders `children` with a `deviceName`
 * prop injected (used by KDS's device-paired indicator — Order Entry
 * currently ignores the extra prop, which is harmless).
 *
 * Status machine (never "fails open" — the only way to reach "paired" is
 * a confirmed { paired: true } response):
 *   checking -> paired            (normal case)
 *   checking -> unpaired          (confirmed: no valid pairing)
 *   checking -> error -> checking (network/server failure; retries,
 *                                   does NOT fall through to unpaired)
 */
export default function RequireDevicePairing({ children }) {
  const [status, setStatus] = useState("checking");
  const [deviceName, setDeviceName] = useState(null);

  const checkPairing = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/devices/me`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.paired) {
        setDeviceName(data.deviceName || null);
        setStatus("paired");
      } else {
        setStatus("unpaired");
      }
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    checkPairing();
  }, [checkPairing]);

  useEffect(() => {
    if (status !== "error") return;
    const id = setTimeout(checkPairing, RETRY_MS);
    return () => clearTimeout(id);
  }, [status, checkPairing]);

  if (status === "checking" || status === "error") {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="brand-logo">
            <img src={logoImg} alt="NARCOS TACOS" className="brand-logo__img" />
          </div>
          <div className="login-footer">
            {status === "error" ? "Connection error — retrying…" : "Checking device…"}
          </div>
        </div>
      </div>
    );
  }

  if (status === "unpaired") {
    return <DevicePairingScreen onPaired={() => checkPairing()} />;
  }

  return isValidElement(children) ? cloneElement(children, { deviceName }) : children;
}
