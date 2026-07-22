import { useState, useEffect, useCallback } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import PinLogin from "./components/PinLogin";
import OrderEntry from "./components/OrderEntry";
import KitchenDisplay from "./components/KitchenDisplay";
import BackOffice from "./components/BackOffice";
import ManageMenu from "./components/ManageMenu";
import ResetPassword from "./components/ResetPassword";
import RequireDevicePairing from "./components/RequireDevicePairing";

// Roles allowed onto the POS-side "Manage Menu" page (mirrors Back Office's
// Menu Management access — real enforcement is server-side on every write,
// this is just so a typed-in URL doesn't dead-end non-owner/admin staff on
// a blank page instead of sending them back to work).
const MANAGE_MENU_ROLES = ["owner", "admin"];

const STORAGE_KEY_STAFF = "narcos_pos_staff";
const STORAGE_KEY_THEME = "narcos_pos_theme";

function getStoredStaff() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_STAFF);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getStoredTheme() {
  try {
    return localStorage.getItem(STORAGE_KEY_THEME) || "light";
  } catch {
    return "light";
  }
}

// Kitchen staff never log in (the KDS is a no-auth screen at a fixed URL), so
// every login role routes to Order Entry.
function roleToPath() {
  return "/order-entry";
}

export default function App() {
  const [staff, setStaff] = useState(getStoredStaff);
  const [theme, setTheme] = useState(getStoredTheme);

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(STORAGE_KEY_THEME, theme);
  }, [theme]);

  const handleLogin = useCallback((staffData) => {
    setStaff(staffData);
    localStorage.setItem(STORAGE_KEY_STAFF, JSON.stringify(staffData));
  }, []);

  const handleLogout = useCallback(() => {
    setStaff(null);
    localStorage.removeItem(STORAGE_KEY_STAFF);
  }, []);

  const handleToggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        {/* Login — device pairing gates the PIN pad itself, so an unpaired
            device (or one whose cookie was cleared) always sees the pairing
            screen first, never the PIN pad. Without this wrapper an unpaired
            device landing on /login (e.g. via the catch-all from the bare
            domain) would show the PIN pad, and since POST /api/auth/login is
            device-gated server-side, a correct PIN would be rejected 401 —
            looking like a "wrong PIN" with no way forward. */}
        <Route
          path="/login"
          element={
            staff ? (
              <Navigate to={roleToPath()} replace />
            ) : (
              <RequireDevicePairing>
                <PinLogin onLogin={handleLogin} />
              </RequireDevicePairing>
            )
          }
        />

        {/* Order Entry — owner, admin, manager, cashier. Device pairing
            gates this AND /login above, so an unpaired device never even
            reaches the PIN pad. */}
        <Route
          path="/order-entry"
          element={
            <RequireDevicePairing>
              {staff ? (
                <OrderEntry
                  staff={staff}
                  theme={theme}
                  onToggleTheme={handleToggleTheme}
                  onLogout={handleLogout}
                />
              ) : (
                <Navigate to="/login" replace />
              )}
            </RequireDevicePairing>
          }
        />

        {/* Manage Menu — POS-reachable, owner/admin only */}
        <Route
          path="/manage-menu"
          element={
            staff && MANAGE_MENU_ROLES.includes(staff.role) ? (
              <ManageMenu staff={staff} />
            ) : (
              <Navigate to={staff ? "/order-entry" : "/login"} replace />
            )
          }
        />

        {/* Kitchen Display — no staff auth, no session, reachable directly
            by URL. Opened once on a kitchen device and left running.
            Device pairing is now the ONLY gate in front of it — KDS has
            no login step of its own for this to layer underneath, unlike
            Order Entry above. */}
        <Route
          path="/kds/lawrence-east-4471"
          element={
            <RequireDevicePairing>
              <KitchenDisplay />
            </RequireDevicePairing>
          }
        />

        {/* Back Office — has its own email+password+TOTP login + role gate */}
        <Route path="/backoffice" element={<BackOffice />} />

        {/* Reached via the emailed forgot-password link — no auth required
            to view, the token in the query string is the proof. */}
        <Route path="/backoffice/reset-password" element={<ResetPassword />} />

        {/* Catch-all */}
        <Route
          path="*"
          element={
            <Navigate to={staff ? roleToPath() : "/login"} replace />
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
