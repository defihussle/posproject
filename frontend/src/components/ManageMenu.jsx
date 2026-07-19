import { useNavigate } from "react-router-dom";
import MenuManager from "./MenuManager";
import logoImg from "../assets/narcos-tacos-logo.png";
import "./ManageMenu.css";

/**
 * POS-reachable "Manage Menu" page — owner/admin only, opened from Order
 * Entry's account dropdown. Full-page (not a modal, per design) since menu
 * editing needs real screen space. Just page chrome here; the actual editor
 * is MenuManager, the same component + same backend routes Back Office's
 * Menu Management section uses — one editor, two entry points.
 */
export default function ManageMenu({ staff }) {
  const navigate = useNavigate();

  return (
    <div className="managemenu">
      <div className="managemenu__topbar">
        <div className="managemenu__topbar-left">
          <button
            className="managemenu__back"
            onClick={() => navigate("/order-entry")}
            aria-label="Back to Order Entry"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"></polyline>
            </svg>
          </button>
          <img src={logoImg} alt="NARCOS TACOS" className="managemenu__logo" />
          <span className="managemenu__title">Manage Menu</span>
        </div>
        <span className="managemenu__staff">{staff.name}</span>
      </div>

      <div className="managemenu__body">
        <MenuManager staff={staff} showTitle={false} />
      </div>
    </div>
  );
}
