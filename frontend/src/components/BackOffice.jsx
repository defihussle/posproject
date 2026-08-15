import { useState, useCallback, useMemo, useEffect } from "react";
import { Routes, Route, Navigate, NavLink, useLocation } from "react-router-dom";
import BackofficeLogin from "./BackofficeLogin";
import HomeDashboard from "./HomeDashboard";
import MenuManager from "./MenuManager";
import StaffManager from "./StaffManager";
import Payroll from "./Payroll";
import DeviceManager from "./DeviceManager";
import LiveOrders from "./LiveOrders";
import OrderHistory from "./OrderHistory";
import ReportsLayout, { ReportRoute } from "./reports/ReportsLayout";
import { REPORTS, visibleReports } from "./reports/registry";
import logoImg from "../assets/narcos-tacos-logo.png";
import { API_URL } from "../config";
import "./BackOffice.css";
import useScrollLock from "../useScrollLock";
import {
  IconHome,
  IconUsers,
  IconMenu,
  IconPayroll,
  IconReports,
  IconDevices,
  IconOrders,
  IconLogOut,
} from "./icons";

// Sub-items of the Orders group — "what's cooking now" then "what happened
// before". Adding another is one entry here; the nav group and the routes
// below both read from this list.
const ORDERS_VIEWS = [
  {
    key: "live",
    label: "Live Orders",
    path: "live",
    roles: ["owner", "admin"],
    element: () => <LiveOrders />,
  },
  {
    key: "history",
    label: "Order History",
    path: "history",
    roles: ["owner", "admin"],
    element: () => <OrderHistory />,
  },
];

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
// A `group: true` item is an expandable dropdown; its `subs(role)` returns the
// sub-items to list, so Reports draws from the reports registry and Orders from
// ORDERS_VIEWS above without NavGroup knowing about either.
//
// Order: Home, Orders (dropdown), Staff, Menu, Payroll, Reports (dropdown),
// Devices. Orders sits directly under Home because "what's happening right
// now" is the other thing an owner opens the app to check.
const NAV_ITEMS = [
  { key: "home", label: "Home", path: "home", Icon: IconHome, roles: ["owner", "admin"], element: (staff) => <HomeDashboard staff={staff} /> },
  { key: "orders", label: "Orders", path: "orders", Icon: IconOrders, roles: ["owner", "admin"], group: true, subs: (role) => ORDERS_VIEWS.filter((v) => v.roles.includes(role)) },
  { key: "staff", label: "Staff Management", path: "staff", Icon: IconUsers, roles: ["owner", "admin"], element: (staff) => <StaffManager staff={staff} /> },
  { key: "menu", label: "Menu Management", path: "menu", Icon: IconMenu, roles: ["owner", "admin"], element: (staff) => <MenuManager staff={staff} /> },
  { key: "payroll", label: "Payroll", path: "payroll", Icon: IconPayroll, roles: ["owner", "admin"], element: (staff) => <Payroll staff={staff} /> },
  { key: "reports", label: "Reports", path: "reports", Icon: IconReports, roles: ["owner", "admin"], group: true, subs: (role) => visibleReports(role) },
  { key: "devices", label: "Devices", path: "devices", Icon: IconDevices, roles: ["owner", "admin"], element: () => <DeviceManager /> },
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

  // The mobile nav drawer covers the page behind a full-screen backdrop, so it
  // gets the same treatment as a modal card.
  //
  // MUST stay above the checkingSession / not-logged-in / denied early returns
  // below: those make the first render bail out before this line, so calling it
  // further down changes the hook count between renders and React tears the
  // whole tree down — which is exactly what turned Back Office white.
  useScrollLock(sidebarOpen);

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
  const firstOrdersPath = ORDERS_VIEWS.filter((v) => v.roles.includes(staff.role))[0]?.path ?? "live";
  const closeDrawer = () => setSidebarOpen(false);

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
            {/* Always the hamburger, open or closed — it's one toggle in one
                fixed place, so swapping it to an X made the control look like
                a different button depending on state. The drawer still closes
                by tapping it, the backdrop, or any nav item. */}
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
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
                <NavGroup key={item.key} item={item} staff={staff} onNavigate={closeDrawer} />
              ) : (
                <NavLink
                  key={item.key}
                  to={`/backoffice/${item.path}`}
                  className={({ isActive }) =>
                    `backoffice__navitem${isActive ? " backoffice__navitem--active" : ""}`
                  }
                  onClick={closeDrawer}
                >
                  <item.Icon size={17} className="backoffice__navicon" />
                  <span className="backoffice__navlabel">{item.label}</span>
                </NavLink>
              )
            )}
          </div>

          <div className="backoffice__navfoot">
            <button className="backoffice__navitem backoffice__navitem--logout" onClick={handleLogout}>
              <IconLogOut size={17} className="backoffice__navicon" />
              <span className="backoffice__navlabel">Log Out</span>
            </button>
          </div>
        </nav>

        <main className={`backoffice__body${TOP_ALIGNED ? " backoffice__body--top" : ""}`}>
          <Routes>
            <Route index element={<Navigate to={defaultPath} replace />} />
            {NAV_ITEMS.filter((n) => !n.group && n.roles.includes(staff.role)).map((n) => (
              <Route key={n.key} path={n.path} element={n.element(staff)} />
            ))}
            {/* Orders group. Flat (no shared layout) unlike Reports — its
                views don't share a range selector, so there's nothing for a
                parent element to own yet. */}
            <Route path="orders">
              <Route index element={<Navigate to={firstOrdersPath} replace />} />
              {ORDERS_VIEWS.filter((v) => v.roles.includes(staff.role)).map((v) => (
                <Route key={v.key} path={v.path} element={v.element(staff)} />
              ))}
              <Route path="*" element={<Navigate to={firstOrdersPath} replace />} />
            </Route>
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

// Expandable sidebar section (Orders, Reports). Tapping the parent reveals its
// sub-items (each a real route); it auto-expands whenever one of its own routes
// is active, so the current page is always visible in context. Which sub-items
// it lists comes from the nav item's own `subs(role)` — this component is
// generic, so a new group costs one NAV_ITEMS entry and nothing here.
function NavGroup({ item, staff, onNavigate }) {
  const location = useLocation();
  const onSection = location.pathname.startsWith(`/backoffice/${item.path}`);
  const [open, setOpen] = useState(onSection);
  useEffect(() => {
    if (onSection) setOpen(true);
  }, [onSection]);

  const subs = item.subs(staff.role);

  return (
    <div className="backoffice__navgroup">
      <button
        className={`backoffice__navitem backoffice__navitem--group${onSection ? " backoffice__navitem--active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <item.Icon size={17} className="backoffice__navicon" />
        <span className="backoffice__navlabel">{item.label}</span>
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
