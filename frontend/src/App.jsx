import { useState, useEffect, useCallback } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import PinLogin from "./components/PinLogin";
import OrderEntry from "./components/OrderEntry";
import KitchenDisplay from "./components/KitchenDisplay";
import BackOffice from "./components/BackOffice";

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
        {/* Login */}
        <Route
          path="/login"
          element={
            staff ? (
              <Navigate to={roleToPath()} replace />
            ) : (
              <PinLogin onLogin={handleLogin} />
            )
          }
        />

        {/* Order Entry — owner, admin, manager, cashier */}
        <Route
          path="/order-entry"
          element={
            staff ? (
              <OrderEntry
                staff={staff}
                theme={theme}
                onToggleTheme={handleToggleTheme}
                onLogout={handleLogout}
              />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

        {/* Kitchen Display — no auth, no session, reachable directly by URL.
            Opened once on a kitchen device and left running. */}
        <Route path="/kds/lawrence-east-4471" element={<KitchenDisplay />} />

        {/* Back Office — has its own PIN login + role gate */}
        <Route path="/backoffice" element={<BackOffice />} />

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
