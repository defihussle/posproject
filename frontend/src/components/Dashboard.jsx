import { useState } from "react";
import "./Dashboard.css";

const SCREEN_CONFIG = {
  owner: { title: "Owner/Admin Dashboard", subtitle: "Coming Soon", showSettings: true },
  admin: { title: "Owner/Admin Dashboard", subtitle: "Coming Soon", showSettings: true },
  manager: { title: "Order Entry", subtitle: "Coming Soon", showSettings: false },
  cashier: { title: "Order Entry", subtitle: "Coming Soon", showSettings: false },
  kitchen: { title: "Kitchen Display", subtitle: "Coming Soon", showSettings: false },
};

export default function Dashboard({ staff, theme, onToggleTheme, onLogout }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const config = SCREEN_CONFIG[staff.role] || SCREEN_CONFIG.cashier;

  return (
    <div className="dashboard">
      {/* Header */}
      <header className="dashboard__header">
        <div className="dashboard__brand">
          <span className="dashboard__brand-narcos">NARCOS</span>
          <span className="dashboard__brand-tacos">TACOS</span>
        </div>

        <div className="dashboard__user-info">
          <span className="dashboard__user-name">{staff.name}</span>
          <span className="dashboard__user-role">{staff.role}</span>

          <div className="dashboard__actions">
            {config.showSettings && (
              <button
                id="btn-owner-settings"
                className="dashboard__btn dashboard__btn--settings"
                onClick={() => setSettingsOpen(true)}
              >
                ⚙ Owner Settings
              </button>
            )}
            <button
              id="btn-logout"
              className="dashboard__btn dashboard__btn--logout"
              onClick={onLogout}
            >
              Log Out
            </button>
          </div>
        </div>
      </header>

      {/* Body */}
      <main className="dashboard__body">
        <div className="dashboard__placeholder">
          <div className="dashboard__placeholder-icon">
            <PlaceholderIcon role={staff.role} />
          </div>
          <h1 className="dashboard__placeholder-title">{config.title}</h1>
          <p className="dashboard__placeholder-subtitle">{config.subtitle}</p>
        </div>
      </main>

      {/* Settings Modal */}
      {settingsOpen && (
        <div className="settings-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
            <div className="settings-panel__header">
              <h2 className="settings-panel__title">Owner Settings</h2>
              <button
                className="settings-panel__close"
                onClick={() => setSettingsOpen(false)}
                aria-label="Close settings"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="settings-panel__row">
              <span className="settings-panel__label">Dark Mode</span>
              <button
                id="toggle-theme"
                className={`toggle${theme === "dark" ? " toggle--active" : ""}`}
                onClick={onToggleTheme}
                role="switch"
                aria-checked={theme === "dark"}
                aria-label="Toggle dark mode"
              >
                <span className="toggle__knob" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PlaceholderIcon({ role }) {
  if (role === "kitchen") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 11h.01M11 15h.01M16 16a5 5 0 10-8 0" />
        <path d="M12 2a10 10 0 100 20 10 10 0 000-20z" />
      </svg>
    );
  }
  if (role === "manager" || role === "cashier") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    );
  }
  // owner / admin
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}
