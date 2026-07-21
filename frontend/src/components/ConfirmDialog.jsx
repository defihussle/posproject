import "./ConfirmDialog.css";

/**
 * Shared "Are you sure?" confirmation dialog for destructive/high-impact
 * actions (menu item/variant/group/option removal, staff role changes,
 * deactivation, smart delete, PIN resets) — used across Back Office, the
 * POS's Manage Menu, and Staff Management. A deliberate second step
 * (tap "Confirm") rather than a browser-native confirm() popup, matching
 * the app's own modal visual style. Stacks on top of whatever modal it
 * was opened from (see z-index in ConfirmDialog.css) since every use so
 * far opens this from within an already-open detail modal.
 *
 * Low-stakes actions (editing a name/price, toggling Default) do NOT use
 * this — reserved for actions that are destructive or hard to reverse.
 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}) {
  // Every current usage opens this from within an already-open modal —
  // stopPropagation here (not just on the inner modal) keeps a backdrop
  // click from also bubbling up and closing/dismissing whatever's behind
  // this dialog, not just this one.
  return (
    <div
      className="confirmdlg__overlay"
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="confirmdlg__modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="confirmdlg__title">{title}</h3>
        <p className="confirmdlg__message">{message}</p>
        <div className="confirmdlg__actions">
          <button className="confirmdlg__btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            className={`confirmdlg__btn confirmdlg__btn--${danger ? "danger" : "primary"}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
