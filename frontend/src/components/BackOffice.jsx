import { useState, useCallback, useMemo } from "react";
import PinLogin from "./PinLogin";
import HomeDashboard from "./HomeDashboard";
import MenuManager from "./MenuManager";
import StaffManager from "./StaffManager";
import logoImg from "../assets/narcos-tacos-logo.png";
import "./BackOffice.css";

// Persistent nav config — add future Back Office sections here, each with
// the roles allowed to see/use it. Nothing else in this file needs to
// change to add a new section (e.g. Reports, Orders).
const NAV_ITEMS = [
  { key: "home", label: "Home", roles: ["owner", "admin"], render: (staff) => <HomeDashboard staff={staff} /> },
  { key: "staff", label: "Staff Management", roles: ["owner", "admin", "manager"], render: (staff) => <StaffManager staff={staff} /> },
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

  const handleLogout = useCallback(() => {
    setStaff(null);
    setDenied(false);
    setActiveKey(null);
    setSidebarOpen(false);
  }, []);

  // Not logged in yet — show PIN screen
  if (!staff && !denied) {
    return <PinLogin onLogin={handleLogin} />;
  }

  // Denied — wrong role
  if (denied) {
    return (
      <div className="backoffice__denied">
        <h1 className="backoffice__denied-title">Access Restricted</h1>
        <p className="backoffice__denied-msg">
          Access restricted to owners, admins, and managers
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
      {/* Header */}
      <header className="backoffice__header">
        <div className="backoffice__header-left">
          {/* Hamburger — hidden on desktop via CSS, opens the mobile drawer */}
          <button
            className="backoffice__hamburger"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation menu"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>
          <img src={logoImg} alt="NARCOS TACOS" className="backoffice__logo" />
          <span className="backoffice__label">Back Office</span>
        </div>
        <div className="backoffice__right">
          <span className="backoffice__user">{staff.name}</span>
          <button className="backoffice__btn" onClick={handleLogout}>
            Log Out
          </button>
        </div>
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
