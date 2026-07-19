import StaffManager from "./StaffManager";
import "./StaffManager.css";

/**
 * Order Entry's "Staff Management" popup — owner/admin only. Same pattern
 * as ManageMenu.jsx (one shared component, two entry points: Back Office's
 * Staff tab and this POS popup), except this one stays a modal rather than
 * a full page, per this feature's spec — a "pop up card," similar
 * interaction weight to the item customization modal, not a page
 * navigation like Manage Menu.
 *
 * Renders the exact same StaffManager component/logic Back Office uses
 * (list, inline edit, deactivate/reactivate, PIN reset, add) — same
 * /api/backoffice/staff* routes, same owner/admin role check, same
 * hierarchy protections, nothing duplicated or weakened. The one addition
 * is live clock-in/break status per row, via StaffManager's opt-in
 * showLiveStatus prop (Back Office's own Staff tab doesn't pass it, so
 * that surface is completely unchanged).
 *
 * Manager's dropdown entry is untouched — this popup is owner/admin only;
 * manager keeps the existing add-only quick-add modal (see OrderEntry.jsx).
 */
export default function StaffManagementModal({ staff, onClose }) {
  return (
    <div className="staffmgr__overlay" onClick={onClose}>
      <div className="staffmgr__modal staffmgr__modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="staffmgr__modal-head">
          <h3 className="staffmgr__modal-title">Staff Management</h3>
          <button className="staffmgr__modal-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="staffmgr__modal-body">
          <StaffManager staff={staff} showLiveStatus />
        </div>
      </div>
    </div>
  );
}
