import { useState, useCallback } from "react";
import PinLogin from "./PinLogin";
import MenuManager from "./MenuManager";
import StaffManager from "./StaffManager";
import "./BackOffice.css";

const TABS = ["Reports", "Menu", "Staff", "Orders"];
// Managers are admitted for Staff management ONLY — every other tab stays
// owner/admin (they see just the Staff tab).
const ALLOWED_ROLES = ["owner", "admin", "manager"];
const tabsForRole = (role) => (role === "manager" ? ["Staff"] : TABS);

export default function BackOffice() {
  const [staff, setStaff] = useState(null);
  const [denied, setDenied] = useState(false);
  const [activeTab, setActiveTab] = useState("Reports");

  const handleLogin = useCallback((staffData) => {
    if (!ALLOWED_ROLES.includes(staffData.role)) {
      setDenied(true);
      return;
    }
    setStaff(staffData);
    // Managers only get the Staff tab — land them there directly
    if (staffData.role === "manager") setActiveTab("Staff");
  }, []);

  const handleLogout = useCallback(() => {
    setStaff(null);
    setDenied(false);
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

  // Authenticated owner/admin
  return (
    <div className="backoffice">
      {/* Header */}
      <header className="backoffice__header">
        <div style={{ display: "flex", alignItems: "baseline" }}>
          <div className="backoffice__brand">
            <span className="dashboard__brand-narcos">NARCOS</span>
            <span className="dashboard__brand-tacos">TACOS</span>
          </div>
          <span className="backoffice__label">Back Office</span>
        </div>
        <div className="backoffice__right">
          <span className="backoffice__user">{staff.name}</span>
          <button className="backoffice__btn" onClick={handleLogout}>
            Log Out
          </button>
        </div>
      </header>

      {/* Tabs */}
      <nav className="backoffice__tabs">
        {tabsForRole(staff.role).map((tab) => (
          <button
            key={tab}
            className={`backoffice__tab${tab === activeTab ? " backoffice__tab--active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </nav>

      {/* Body */}
      <main
        className={`backoffice__body${
          activeTab === "Menu" || activeTab === "Staff" ? " backoffice__body--top" : ""
        }`}
      >
        {activeTab === "Menu" ? (
          <MenuManager staff={staff} />
        ) : activeTab === "Staff" ? (
          <StaffManager staff={staff} />
        ) : (
          <div className="backoffice__placeholder">
            <h1 className="backoffice__placeholder-title">{activeTab}</h1>
            <p className="backoffice__placeholder-sub">Coming Soon</p>
          </div>
        )}
      </main>
    </div>
  );
}
