import { useState, useCallback, useMemo, useEffect } from "react";
import { Routes, Route, Navigate, NavLink, useLocation } from "react-router-dom";
import BackofficeLogin from "./BackofficeLogin";
import HomeDashboard from "./HomeDashboard";
import MenuManager from "./MenuManager";
import StaffManager from "./StaffManager";
import Payroll from "./Payroll";
import DeviceManager from "./DeviceManager";
import ReportsLayout, { ReportRoute } from "./reports/ReportsLayout";
import { REPORTS, visibleReports } from "./reports/registry";
import logoImg from "../assets/narcos-tacos-logo.png";
import { API_URL } from "../config";
import "./BackOffice.css";
import useScrollLock from "../useScrollLock";

// Persistent nav config — add future Back Office sections here, each with the
// roles allowed to see/use it and a URL path (sections are real routes under
// /backoffice/*). `element` renders the section; a `group: true` item (Reports)
// is an expandable dropdown whose sub-items come from the reports registry —
// nothing else in this file changes to add a report.
//
// Back Office access is owner/admin ONLY — Manager's access was fully revoked
// (that capability moved to a POS-side quick-add action, see OrderEntry's
// account dropdown). ALLOWED_ROLES is derived from these lists, so removing
// "manager" here also makes PIN login reject Manager with "Access Restricted".
//
// Order: Home, Staff, Menu, Payroll, Reports (dropdown), Devices.
const NAV_ITEMS = [
  { key: "home", label: "Home", path: "home", roles: ["owner", "admin"], element: (staff) => <HomeDashboard staff={staff} /> },
  { key: "staff", label: "Staff Management", path: "staff", roles: ["owner", "admin"], element: (staff) => <StaffManager staff={staff} /> },
  { key: "menu", label: "Menu Management", path: "menu", roles: ["owner", "admin"], element: (staff) => <MenuManager staff={staff} /> },
  { key: "payroll", label: "Payroll", path: "payroll", roles: ["owner", "admin"], element: (staff) => <Payroll staff={staff} /> },
  { key: "reports", label: "Reports", path: "reports", roles: ["owner", "admin"], group: true },
  { key: "devices", label: "Devices", path: "devices", roles: ["owner", "admin"], element: () => <DeviceManager /> },
];

const ALLOWED_ROLES = [...new Set(NAV_ITEMS.flatMap((n) => n.roles))];
// Sections whose body should scroll top-aligned rather than be centered.
const TOP_ALIGNED = true;

export default function BackOffice() {
  const [staff, setStaff] = useState(null);
  const [denied, setDenied] = useState(false);
  // True until the initial GET /auth/me check resolves — avoids flashing the
  // login screen on every page refresh when a valid session cookie exists.
  const [checkingSession, setCheckingSession] = useState(true);
  // Mobile-only drawer state — collapsed by default; irrelevant on desktop.
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const visibleNav = useMemo(
    () => (staff ? NAV_ITEMS.filter((n) => n.roles.includes(staff.role)) : []),
    [staff]
  );

  const handleLogin = useCallback((staffData) => {
    if (!ALLOWED_ROLES.includes(staffData.role)) {
      setDenied(true);
      return;
    }
    setStaff(staffData);
  }, []);

  // On mount, silently check for an existing valid session cookie.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/backoffice/auth/me`, { credentials: "include" });
        if (cancelled) return;
        if (res.ok) {
          const staffData = await res.json();
          handleLogin(staffData);
        }
      } catch {
        // No session / connection error — fall through to the login screen
      } finally {
        if (!cancelled) setCheckingSession(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handleLogin]);

  const handleLogout = useCallback(() => {
    fetch(`${API_URL}/api/backoffice/auth/logout`, { method: "POST", credentials: "include" }).catch(() => {});
    setStaff(null);
    setDenied(false);
    setSidebarOpen(false);
  }, []);

  if (checkingSession) {
    return (
      <div className="backoffice__placeholder">
        <h1 className="backoffice__placeholder-title">Loading…</h1>
      </div>
    );
  }

  // Not logged in yet — show email + password + TOTP screen
  if (!staff && !denied) {
    return <BackofficeLogin onLogin={handleLogin} />;
  }

  // Denied — wrong role
  if (denied) {
    return (
      <div className="backoffice__denied">
        <h1 className="backoffice__denied-title">Access Restricted</h1>
        <p className="backoffice__denied-msg">Access restricted to owners and admins</p>
        <button className="backoffice__btn" onClick={handleLogout}>
          Back to Login
        </button>
      </div>
    );
  }

  // Landing section for this role (owner/admin → Home) and first report route.
  const defaultPath = visibleNav.find((n) => !n.group)?.path ?? "home";
  const firstReportPath = visibleReports(staff.role)[0]?.path ?? "sales-summary";
  const closeDrawer = () => setSidebarOpen(false);

  // The mobile nav drawer covers the page behind a full-screen backdrop, so
  // it gets the same treatment as a modal card.
  useScrollLock(sidebarOpen);

  return (
    <div className="backoffice">
      <header className="backoffice__header">
        <div className="backoffice__header-side backoffice__header-side--left">
          <button
            className="backoffice__hamburger"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label={sidebarOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={sidebarOpen}
          >
            {sidebarOpen ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="6" x2="18" y2="18"></line>
                <line x1="18" y1="6" x2="6" y2="18"></line>
              </svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
              </svg>
            )}
          </button>
        </div>

        <div className="backoffice__header-center">
          <img src={logoImg} alt="NARCOS TACOS" className="backoffice__logo" />
        </div>

        <div className="backoffice__header-side backoffice__header-side--right" aria-hidden="true" />
      </header>

      <div className="backoffice__shell">
        {sidebarOpen && (
          <div className="backoffice__sidebar-backdrop" onClick={closeDrawer} />
        )}

        <nav className={`backoffice__sidebar${sidebarOpen ? " backoffice__sidebar--open" : ""}`}>
          <div className="backoffice__navlist">
            {visibleNav.map((item) =>
              item.group ? (
                <ReportsNavGroup key={item.key} item={item} staff={staff} onNavigate={closeDrawer} />
              ) : (
                <NavLink
                  key={item.key}
                  to={`/backoffice/${item.path}`}
                  className={({ isActive }) =>
                    `backoffice__navitem${isActive ? " backoffice__navitem--active" : ""}`
                  }
                  onClick={closeDrawer}
                >
                  {item.label}
                </NavLink>
              )
            )}
          </div>

          <div className="backoffice__navfoot">
            <button className="backoffice__navitem backoffice__navitem--logout" onClick={handleLogout}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                <polyline points="16 17 21 12 16 7"></polyline>
                <line x1="21" y1="12" x2="9" y2="12"></line>
              </svg>
              Log Out
            </button>
          </div>
        </nav>

        <main className={`backoffice__body${TOP_ALIGNED ? " backoffice__body--top" : ""}`}>
          <Routes>
            <Route index element={<Navigate to={defaultPath} replace />} />
            {NAV_ITEMS.filter((n) => !n.group && n.roles.includes(staff.role)).map((n) => (
              <Route key={n.key} path={n.path} element={n.element(staff)} />
            ))}
            <Route path="reports" element={<ReportsLayout staff={staff} />}>
              <Route index element={<Navigate to={firstReportPath} replace />} />
              {REPORTS.map((r) => (
                <Route key={r.key} path={r.path} element={<ReportRoute report={r} />} />
              ))}
              <Route path="*" element={<Navigate to={firstReportPath} replace />} />
            </Route>
            <Route path="*" element={<Navigate to={defaultPath} replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

// Expandable Reports section in the sidebar. Tapping the parent reveals the
// per-report sub-items (each a real route); it auto-expands whenever a reports
// route is active so the current report is always visible in context.
function ReportsNavGroup({ item, staff, onNavigate }) {
  const location = useLocation();
  const onReports = location.pathname.startsWith("/backoffice/reports");
  const [open, setOpen] = useState(onReports);
  useEffect(() => {
    if (onReports) setOpen(true);
  }, [onReports]);

  const subs = visibleReports(staff.role);

  return (
    <div className="backoffice__navgroup">
      <button
        className={`backoffice__navitem backoffice__navitem--group${onReports ? " backoffice__navitem--active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{item.label}</span>
        <svg
          className={`backoffice__caret${open ? " backoffice__caret--open" : ""}`}
          width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </button>
      {open && (
        <div className="backoffice__navsub">
          {subs.map((r) => (
            <NavLink
              key={r.key}
              to={`/backoffice/${item.path}/${r.path}`}
              className={({ isActive }) =>
                `backoffice__navitem backoffice__navitem--sub${isActive ? " backoffice__navitem--active" : ""}`
              }
              onClick={onNavigate}
            >
              {r.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}
