import { useState, useEffect, useCallback } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import PinLogin from "./components/PinLogin";
import Dashboard from "./components/Dashboard";

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

function roleToPath(role) {
  switch (role) {
    case "owner":
    case "admin":
      return "/dashboard";
    case "kitchen":
      return "/kitchen";
    case "manager":
    case "cashier":
    default:
      return "/orders";
  }
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
              <Navigate to={roleToPath(staff.role)} replace />
            ) : (
              <PinLogin onLogin={handleLogin} />
            )
          }
        />

        {/* Owner / Admin Dashboard */}
        <Route
          path="/dashboard"
          element={
            staff ? (
              <Dashboard
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

        {/* Order Entry (Manager / Cashier) */}
        <Route
          path="/orders"
          element={
            staff ? (
              <Dashboard
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

        {/* Kitchen Display */}
        <Route
          path="/kitchen"
          element={
            staff ? (
              <Dashboard
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

        {/* Catch-all */}
        <Route
          path="*"
          element={
            <Navigate to={staff ? roleToPath(staff.role) : "/login"} replace />
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
