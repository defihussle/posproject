import { useState, useCallback, useMemo, useEffect } from "react";
import BackofficeLogin from "./BackofficeLogin";
import HomeDashboard from "./HomeDashboard";
import MenuManager from "./MenuManager";
import StaffManager from "./StaffManager";
import logoImg from "../assets/narcos-tacos-logo.png";
import { API_URL } from "../config";
import "./BackOffice.css";

// Persistent nav config — add future Back Office sections here, each with
// the roles allowed to see/use it. Nothing else in this file needs to
// change to add a new section (e.g. Reports, Orders).
//
// Back Office access is owner/admin ONLY — Manager's access was fully
// revoked (they used to see Staff Management only; that capability moved
// to a POS-side quick-add action instead, see OrderEntry's account
// dropdown + StaffAddForm's `endpoint` prop). Since ALLOWED_ROLES below is
// derived from these roles lists, removing "manager" here also makes PIN
// login correctly reject Manager with the "Access Restricted" screen —
// no separate check needed.
const NAV_ITEMS = [
  { key: "home", label: "Home", roles: ["owner", "admin"], render: (staff) => <HomeDashboard staff={staff} /> },
  { key: "staff", label: "Staff Management", roles: ["owner", "admin"], render: (staff) => <StaffManager staff={staff} /> },
  { key: "menu", label: "Menu Management", roles: ["owner", "admin"], render: (staff) => <MenuManager staff={staff} /> },
];

const ALLOWED_ROLES = [...new Set(NAV_ITEMS.flatMap((n) => n.roles))];
// Sections whose body should scroll top-aligned rather than be centered
// (every real section does — only the "Coming Soon" placeholder centers).
const TOP_ALIGNED = true;

export default function BackOffice() {
  const [staff, setStaff] = useState(null);
  const [denied, setDenied] = useState(false);
  const [activeKey, setActiveKey] = useState(null);
  // True until the initial GET /auth/me check resolves — avoids flashing
  // the login screen on every page refresh when a valid session cookie
  // already exists.
  const [checkingSession, setCheckingSession] = useState(true);
  // Mobile-only drawer state — collapsed by default; irrelevant on desktop,
  // where the sidebar stays permanently visible regardless of this value
  // (enforced in CSS, see BackOffice.css).
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Nav items visible to the logged-in role — a manager never even sees
  // "Home" in this list, not just blocked from opening it.
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
    // Land on the first section this role can see (owner/admin -> Home,
    // manager -> Staff Management, since Home isn't in their list).
    const firstVisible = NAV_ITEMS.find((n) => n.roles.includes(staffData.role));
    setActiveKey(firstVisible?.key ?? null);
  }, []);

  // On mount, silently check for an existing valid session cookie (e.g.
  // after a page refresh) rather than always forcing a fresh login.
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
        // No session / connection error — just fall through to the login screen
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
    setActiveKey(null);
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
        <p className="backoffice__denied-msg">
          Access restricted to owners and admins
        </p>
        <button className="backoffice__btn" onClick={handleLogout}>
          Back to Login
        </button>
      </div>
    );
  }

  const active = NAV_ITEMS.find((n) => n.key === activeKey);

  return (
    <div className="backoffice">
      {/* Header — three-column grid so the logo stays the true visual
          center regardless of what's in the outer columns (hamburger on
          mobile, nothing on desktop — no staff name/Log Out here anymore,
          both moved into the nav list itself, see sidebar below). */}
      <header className="backoffice__header">
        <div className="backoffice__header-side backoffice__header-side--left">
          {/* Hamburger — hidden on desktop via CSS. Single SVG whose path
              swaps between the three-line "menu" glyph and an "X" based on
              sidebarOpen, so there's always a visible, correct affordance
              to open OR close the drawer — never a dead/missing icon. */}
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

      {/* Persistent nav + content */}
      <div className="backoffice__shell">
        {/* Backdrop — mobile only (CSS-gated); click to close the drawer */}
        {sidebarOpen && (
          <div
            className="backoffice__sidebar-backdrop"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <nav className={`backoffice__sidebar${sidebarOpen ? " backoffice__sidebar--open" : ""}`}>
          <div className="backoffice__navlist">
            {visibleNav.map((item) => (
              <button
                key={item.key}
                className={`backoffice__navitem${item.key === activeKey ? " backoffice__navitem--active" : ""}`}
                onClick={() => {
                  setActiveKey(item.key);
                  setSidebarOpen(false); // no-op on desktop, closes the drawer on mobile
                }}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* Log Out lives at the bottom of the nav list itself — same
              persistent sidebar on desktop, same drawer on mobile — rather
              than a separate top-bar element. */}
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
          {active ? (
            active.render(staff)
          ) : (
            <div className="backoffice__placeholder">
              <h1 className="backoffice__placeholder-title">No sections available</h1>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
