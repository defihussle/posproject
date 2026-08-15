import { useState, useEffect, useCallback, useMemo } from "react";
import { API_URL } from "../config";
import ReceiptModal from "./ReceiptModal";
import useScrollLock from "../useScrollLock";
// State/pricing rules shared with Back Office → Orders → Order History, which
// lists the same orders and can start a reversal on one. See orderRecall.js.
import {
  REFUND_REASONS,
  REFUND_OWNER_APPROVAL_THRESHOLD,
  orderState,
  isInteracOrder,
  lineItemRefundAmount,
} from "./orderRecall";
import "./OrderRecallModal.css";

// Maps the shared state key to this surface's pill. The POS keeps its raw
// lowercase status text (`ready`, `preparing`) — the badge reads as a status
// chip here, not a sentence.
const POS_STATE_CLASS = {
  voided: "orm-badge--cancelled",
  fully_refunded: "orm-badge--refunded",
  partially_refunded: "orm-badge--refunded",
};
const POS_STATE_TEXT = {
  voided: "Voided",
  fully_refunded: "Fully Refunded",
  partially_refunded: "Partially Refunded",
};

function orderStateBadge(order) {
  const key = orderState(order);
  return {
    text: POS_STATE_TEXT[key] || key,
    cls: POS_STATE_CLASS[key] || `orm-badge--${key}`,
  };
}

const fmtLogTime = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// Voiding an order the kitchen hasn't finished needs no second person: nothing
// has reached a customer, so it's a correction rather than money moving. Any
// role that can reach Order Entry may do it alone — a cashier shouldn't have to
// find a manager to kill a mis-rung ticket mid-rush. Mirrors the server rule in
// applyRefund(), which re-checks it under the row lock and is authoritative;
// this only decides whether to show the PIN step.
const selfVoidAllowed = (order, actionType) =>
  actionType === "void" && (order?.status === "open" || order?.status === "preparing");

export default function OrderRecallModal({ staff, onClose, onOrderUpdated }) {
  // The options/PIN overlays live inside this same component, so locking once
  // at the root covers them too.
  useScrollLock();

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState(null);

  // Eligible approvers for dual-control
  const [approvers, setApprovers] = useState([]);

  // Reversal Form state
  const [actionType, setActionType] = useState(null); // 'void' | 'full' | 'partial' | 'line_item'
  const [reason, setReason] = useState("wrong_order");
  const [reasonNote, setReasonNote] = useState("");
  const [partialAmount, setPartialAmount] = useState("");
  const [lineQuantities, setLineQuantities] = useState({}); // { [order_item_id]: qty_to_refund }
  // How the money goes back. Only ever shown (and only ever sent) for an
  // Interac sale — see isInteracOrder. 'card' is the default and means "the
  // customer is here with their card"; 'cash' is the D5 cash-out.
  const [refundMethod, setRefundMethod] = useState("card");

  // PIN Approval Modal state
  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [selectedApprover, setSelectedApprover] = useState(null);
  const [approverPin, setApproverPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pinError, setPinError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  // Receipt — order id, or null when closed. Recall is the reprint surface:
  // any past order can be found here and printed again.
  const [receiptOrderId, setReceiptOrderId] = useState(null);

  // Fetch recent orders for recall
  const fetchOrders = useCallback(async (query = "") => {
    setLoading(true);
    try {
      const q = encodeURIComponent(query.trim());
      const res = await fetch(`${API_URL}/api/orders/pos-recall?search=${q}&limit=30`, {
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to fetch orders");
      setOrders(data.orders || []);
      // Deliberately no auto-select: the detail is a modal card over the list,
      // so pre-selecting the newest order would pop that card open on every
      // fetch — including the refresh after a reversal — instead of returning
      // the cashier to a browsable list.
    } catch (err) {
      console.error("Order recall fetch failed:", err.message);
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch eligible approvers
  const fetchApprovers = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/staff/approvers`, { credentials: "include" });
      const data = await res.json();
      if (res.ok) {
        setApprovers(data.approvers || []);
      }
    } catch (err) {
      console.error("Failed to fetch approvers:", err.message);
    }
  }, []);

  useEffect(() => {
    fetchOrders(search);
    fetchApprovers();
  }, [search, fetchOrders, fetchApprovers]);

  // Strictly what the cashier tapped — no fallback to orders[0], or closing the
  // detail card would immediately re-open it on the newest order.
  const selectedOrder = useMemo(
    () => orders.find((o) => o.id === selectedOrderId) || null,
    [orders, selectedOrderId]
  );

  const closeDetail = useCallback(() => setSelectedOrderId(null), []);

  // Escape closes the detail card, but only when it is the topmost surface —
  // the options / PIN / receipt overlays sit above it and own the key first.
  useEffect(() => {
    if (!selectedOrderId || actionType || pinModalOpen || receiptOrderId) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape") closeDetail();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedOrderId, actionType, pinModalOpen, receiptOrderId, closeDetail]);

  // Reset form when switching selected order
  useEffect(() => {
    setActionType(null);
    setReason("wrong_order");
    setReasonNote("");
    setPartialAmount("");
    setLineQuantities({});
    setRefundMethod("card");
    setSuccessMsg(null);
  }, [selectedOrderId]);

  const lineItemTotalAmount = useMemo(
    () =>
      selectedOrder && actionType === "line_item"
        ? lineItemRefundAmount(selectedOrder, lineQuantities)
        : 0,
    [selectedOrder, actionType, lineQuantities]
  );

  // Calculate final reversal amount to present
  const calculatedReversalAmount = useMemo(() => {
    if (!selectedOrder || !actionType) return 0;
    if (actionType === "void") return selectedOrder.total;
    if (actionType === "full") return selectedOrder.refund_summary.remaining_refundable;
    if (actionType === "partial") return parseFloat(partialAmount) || 0;
    if (actionType === "line_item") return lineItemTotalAmount;
    return 0;
  }, [selectedOrder, actionType, partialAmount, lineItemTotalAmount]);

  const isOwnerRequired = calculatedReversalAmount >= REFUND_OWNER_APPROVAL_THRESHOLD;

  // Filter approvers based on $100+ threshold rule
  const eligibleApprovers = useMemo(() => {
    if (isOwnerRequired) {
      return approvers.filter((a) => a.role === "owner" || a.role === "admin");
    }
    return approvers;
  }, [approvers, isOwnerRequired]);

  // Handle action button click
  const startAction = (type) => {
    setActionType(type);
    setReason("wrong_order");
    setReasonNote("");
    setRefundMethod("card"); // to the card unless staff deliberately choose cash
    setSuccessMsg(null);
    setPinError(null); // errors now show in the options popup — don't carry one in

    if (type === "partial") {
      setPartialAmount(selectedOrder.refund_summary.remaining_refundable.toFixed(2));
    } else if (type === "line_item") {
      const init = {};
      for (const item of selectedOrder.items || []) {
        init[item.order_item_id] = 0;
      }
      setLineQuantities(init);
    }
  };

  // Line item quantity adjustment
  const handleLineQtyChange = (orderItemId, maxQty, delta) => {
    setLineQuantities((prev) => {
      const current = prev[orderItemId] || 0;
      const next = Math.max(0, Math.min(maxQty, current + delta));
      return { ...prev, [orderItemId]: next };
    });
  };

  // Open PIN Modal after form validation
  const openPinApproval = () => {
    if (reason === "other" && !reasonNote.trim()) {
      alert("A reason note is required when selecting 'Other'.");
      return;
    }
    if (actionType === "partial") {
      const amt = parseFloat(partialAmount);
      if (isNaN(amt) || amt <= 0) {
        alert("Please enter a valid partial refund amount.");
        return;
      }
      if (amt > selectedOrder.refund_summary.remaining_refundable) {
        alert(`Amount cannot exceed remaining refundable ($${selectedOrder.refund_summary.remaining_refundable.toFixed(2)}).`);
        return;
      }
    } else if (actionType === "line_item") {
      if (lineItemTotalAmount <= 0) {
        alert("Please select at least one item quantity to refund.");
        return;
      }
      if (lineItemTotalAmount > selectedOrder.refund_summary.remaining_refundable) {
        alert(`Line items total ($${lineItemTotalAmount.toFixed(2)}) exceeds remaining refundable ($${selectedOrder.refund_summary.remaining_refundable.toFixed(2)}).`);
        return;
      }
    }

    // Voiding an order still being made needs no approver — submit straight
    // through rather than showing a PIN step the server won't ask for.
    if (selfVoidAllowed(selectedOrder, actionType)) {
      submitReversal();
      return;
    }

    // Default to currently logged-in staff if they are eligible for this threshold
    const isCallerEligible = eligibleApprovers.some((a) => a.id === staff.id);
    setSelectedApprover(isCallerEligible ? staff : null);
    setApproverPin("");
    setPinError(null);
    setPinModalOpen(true);
  };

  // Keypad press handler
  const handleKeyPress = (digit) => {
    if (approverPin.length < 4) {
      setApproverPin((prev) => prev + digit);
    }
  };

  const handleKeyBackspace = () => {
    setApproverPin((prev) => prev.slice(0, -1));
  };

  // Submit Reversal. Memoized because the auto-submit effect below depends on
  // it: an unmemoized function would be a new identity every render, so the
  // effect would re-run (and could re-fire the submit) on any unrelated render.
  const submitReversal = useCallback(async (e) => {
    if (e) e.preventDefault();
    // Self-approved voids carry no approver; everything else needs a picked
    // approver and a complete PIN before there is anything to send.
    const selfApproved = selfVoidAllowed(selectedOrder, actionType);
    if (!selfApproved && (!selectedApprover || approverPin.length !== 4)) return;

    setSubmitting(true);
    setPinError(null);

    const type = actionType === "void" ? "void" : "refund";
    // Guarded on the order as well as the toggle: a stale 'cash' selection must
    // never ride along onto a credit sale, where it would empty the till for a
    // reversal Stripe was going to make anyway.
    const cashOut = isInteracOrder(selectedOrder) && refundMethod === "cash";
    // For a line-item refund we deliberately send NO dollar amount — the server
    // prices the selected lines itself (unit_price × qty, scaled to what was
    // actually collected so discount and tax are included). Sending a figure
    // from here is what previously short-changed the customer by the tax.
    let amountPayload = undefined;
    if (actionType === "partial") {
      amountPayload = parseFloat(partialAmount);
    } else if (actionType === "full") {
      amountPayload = selectedOrder.refund_summary.remaining_refundable;
    }

    let itemsPayload = undefined;
    if (actionType === "line_item") {
      itemsPayload = Object.entries(lineQuantities)
        .filter(([, qty]) => qty > 0)
        .map(([orderItemId, qty]) => ({ orderItemId, quantity: qty }));
    }

    try {
      const res = await fetch(`${API_URL}/api/orders/${selectedOrder.id}/refund`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: staff.id,
          // Omitting the approver IS the request to self-approve; the server
          // grants it only for voiding an order the kitchen hasn't finished.
          ...(selfApproved
            ? {}
            : { approverStaffId: selectedApprover.id, approverPin }),
          type,
          reason,
          reasonNote: reasonNote.trim() || undefined,
          amount: amountPayload,
          items: itemsPayload,
          // ONLY on an Interac sale, and only when staff explicitly chose the
          // cash-out. Everything else omits the field entirely and keeps the
          // server's own settlement decision — credit refunds through the
          // Stripe API, cash sales internally.
          ...(cashOut ? { refundMethod: "cash" } : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to process reversal");

      // Success. An Interac refund TO THE CARD is not finished when this
      // returns — the server has started an action on the reader and the
      // customer still has to present their card, so the reversal comes back
      // 'pending' and only settles when Stripe confirms. Saying "processed
      // successfully" there would tell the cashier money had gone back before
      // the customer had touched the reader.
      setPinModalOpen(false);
      setActionType(null);
      setSelectedApprover(null);
      setSuccessMsg(
        data.refund?.status === "pending"
          ? `${type.toUpperCase()} started — ask the customer to present their card on the reader.`
          : cashOut
            ? `${type.toUpperCase()} processed — give the customer $${Number(data.refund?.amount ?? 0).toFixed(2)} in cash.`
            : `${type.toUpperCase()} processed successfully!`
      );
      fetchOrders(search);
      if (onOrderUpdated) onOrderUpdated();
    } catch (err) {
      setPinError(err.message || "Failed to process reversal");
      setApproverPin("");
    } finally {
      setSubmitting(false);
    }
  }, [
    selectedApprover, approverPin, actionType, partialAmount, selectedOrder,
    lineQuantities, reason, reasonNote, refundMethod, staff.id, search, fetchOrders, onOrderUpdated,
  ]);

  // Auto-submit when 4 digits entered. submitReversal is a dependency because
  // the effect calls it — without it the effect would keep an older closure and
  // could post a stale reason/note/line selection. It can't loop: every path out
  // of a submit breaks the guard below (success clears pinModalOpen and
  // selectedApprover, failure clears approverPin).
  useEffect(() => {
    if (approverPin.length === 4 && pinModalOpen && selectedApprover && !submitting) {
      submitReversal();
    }
  }, [approverPin, pinModalOpen, selectedApprover, submitting, submitReversal]);

  return (
    <div className="orm-backdrop">
      <div className="orm-modal">
        {/* Header */}
        <div className="orm-header">
          <div className="orm-title-group">
            <h2 className="orm-title">Order Recall & Reversals</h2>
          </div>
          <button className="orm-close-btn" onClick={onClose} aria-label="Close modal">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="orm-body">
          {/* Left Sidebar: Search & List */}
          <div className="orm-sidebar">
            <div className="orm-search-box">
              <input
                type="text"
                className="orm-search-input"
                placeholder="Search Order # or Customer..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="orm-order-list">
              {loading ? (
                <div className="orm-list-status">Loading…</div>
              ) : orders.length === 0 ? (
                <div className="orm-list-status">No orders found</div>
              ) : (
                orders.map((o) => {
                  const isSel = selectedOrder?.id === o.id;
                  const badge = orderStateBadge(o);

                  return (
                    <div
                      key={o.id}
                      className={`orm-order-card${isSel ? " orm-order-card--active" : ""}`}
                      onClick={() => setSelectedOrderId(o.id)}
                    >
                      <div className="orm-order-card-header">
                        <span className="orm-order-number">#{o.order_number}</span>
                        <span className="orm-order-total">${o.total.toFixed(2)}</span>
                      </div>
                      <div className="orm-order-card-meta">
                        <span>{new Date(o.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                        <span className={`orm-badge ${badge.cls}`}>{badge.text}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Order detail — a floating card OVER the list, not a second column
          inside it. The list keeps its own scroll position underneath and is
          untouched when this closes, which is the same view-first pattern the
          Menu and Staff managers use: browse a list, tap a row, read a card. */}
      {selectedOrder && (
        <div
          className="orm-detail-overlay"
          onClick={(e) => {
            // Backdrop only — a click that started inside the card bubbles up
            // here too, and must not dismiss it.
            if (e.target === e.currentTarget) closeDetail();
          }}
        >
          <div
            className="orm-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Order ${selectedOrder.order_number} details`}
          >
            <div className="orm-detail-topbar">
              <h3 className="orm-detail-title">Order #{selectedOrder.order_number}</h3>
              <button
                className="orm-close-btn"
                onClick={closeDetail}
                aria-label="Close order details"
              >
                ✕
              </button>
            </div>

            <div className="orm-content">
              <div className="orm-detail-header">
                <div className="orm-detail-meta">
                  <span>Server: <strong>{selectedOrder.staff_name}</strong></span>
                  <span>Payment: <strong className="orm-payment-method">{selectedOrder.payment_method}</strong></span>
                  <span>Time: {new Date(selectedOrder.created_at).toLocaleString()}</span>
                </div>
                <div className="orm-detail-aside">
                  <span className={`orm-badge ${orderStateBadge(selectedOrder).cls}`}>
                    {orderStateBadge(selectedOrder).text}
                  </span>
                  <button
                    className="orm-btn orm-btn--secondary orm-receipt-btn"
                    onClick={() => setReceiptOrderId(selectedOrder.id)}
                  >
                    Receipt
                  </button>
                </div>
              </div>

              {successMsg && <div className="orm-success">✓ {successMsg}</div>}

              {/* Items Table */}
              <table className="orm-items-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="orm-col--center">Qty</th>
                    <th className="orm-col--right">Price</th>
                    <th className="orm-col--right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedOrder.items.map((item) => (
                    <tr key={item.order_item_id}>
                      <td>
                        <span className="orm-item-name">{item.name}</span>
                        {item.variant_name && <span className="orm-item-variant"> ({item.variant_name})</span>}
                      </td>
                      <td className="orm-col--center">{item.quantity}</td>
                      <td className="orm-col--right">${item.unit_price.toFixed(2)}</td>
                      <td className="orm-col--right">${item.line_total.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Order Summary */}
              <div className="orm-summary-box">
                <div className="orm-summary-row"><span>Subtotal:</span><span>${selectedOrder.subtotal.toFixed(2)}</span></div>
                {selectedOrder.discount > 0 && (
                  <div className="orm-summary-row orm-summary-row--discount">
                    <span>Discount ({selectedOrder.discount_reason}):</span>
                    <span>-${selectedOrder.discount.toFixed(2)}</span>
                  </div>
                )}
                <div className="orm-summary-row"><span>Tax (HST 13%):</span><span>${selectedOrder.tax.toFixed(2)}</span></div>
                <div className="orm-summary-row orm-summary-row--total">
                  <span>Total Paid:</span><span>${selectedOrder.total.toFixed(2)}</span>
                </div>
                {selectedOrder.refund_summary.total_refunded > 0 && (
                  <div className="orm-summary-row orm-summary-row--refunded">
                    <span>Total Refunded:</span>
                    <span>-${selectedOrder.refund_summary.total_refunded.toFixed(2)}</span>
                  </div>
                )}
              </div>

              {/* Prior Refunds Log */}
              {selectedOrder.refunds?.length > 0 && (
                <div className="orm-log">
                  <h4 className="orm-log-title">Prior Reversal Log</h4>
                  {selectedOrder.refunds.map((r) => {
                    // A line-item refund names what went back, which is the
                    // detail a cashier actually needs when deciding what's
                    // left to reverse. Full refunds and voids cover the whole
                    // order, so naming lines would just be noise — they keep
                    // the original reason/approver format.
                    const lines = (r.items || [])
                      .map((i) => (i.quantity > 1 ? `${i.name} ×${i.quantity}` : i.name))
                      .join(", ");
                    return (
                      <div key={r.id} className="orm-log-row">
                        <strong>{r.type.toUpperCase()}</strong> ${r.amount.toFixed(2)} —{" "}
                        {lines
                          ? `${lines} (${r.reason})`
                          : `${r.reason} (${r.approved_by_name})`}{" "}
                        on {fmtLogTime(r.created_at)}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Reversal Action Buttons */}
              {/* Refunds apply only to a standing COMPLETED sale — the
                  server rejects one on an open/preparing order (reverse
                  those with a void instead), so offering the buttons there
                  would just produce a guaranteed 409. Void stays available
                  on any live order, subject to its own no-prior-refund rule. */}
              {selectedOrder.status !== "cancelled" && selectedOrder.refund_summary.remaining_refundable > 0 && (
                <>
                <div className="orm-actions-bar">
                  {selectedOrder.refund_summary.total_refunded === 0 && (
                    <button className="orm-btn orm-btn--danger" onClick={() => startAction("void")}>
                      Void &amp; Refund Full Amount
                    </button>
                  )}
                  {selectedOrder.status === "ready" ? (
                    <>
                      <button className="orm-btn orm-btn--warning" onClick={() => startAction("full")}>
                        Full Refund (${selectedOrder.refund_summary.remaining_refundable.toFixed(2)})
                      </button>
                      <button className="orm-btn orm-btn--secondary" onClick={() => startAction("partial")}>
                        Partial Amount Refund
                      </button>
                      <button className="orm-btn orm-btn--secondary" onClick={() => startAction("line_item")}>
                        Line-Item Refund
                      </button>
                    </>
                  ) : (
                    <span className="orm-actions-note">
                      Not yet completed — reverse this order with a void.
                    </span>
                  )}
                </div>
                <p className="orm-actions-help">
                  Void cancels the entire order and returns the full payment.
                  Refund keeps the order and returns money.
                </p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Reversal options popup — the fields live here rather than expanding
          under the action buttons, so the detail panel stays a clean read-only
          record of the order. Hidden once the PIN overlay opens, making the
          flow one linear journey: pick action → fill in → approve. */}
      {actionType && selectedOrder && !pinModalOpen && (
        <div className="orm-pin-overlay">
          <div className="orm-options-modal">
            <h4 className="orm-form-title">
              Confirm {actionType.toUpperCase().replace("_", " ")} — ${calculatedReversalAmount.toFixed(2)}
            </h4>
            <p className="orm-options-order">Order #{selectedOrder.order_number}</p>

            {/* Interac only. Stripe cannot push an interac_present refund
                remotely, so if the customer no longer has the card, refunding
                to it is impossible rather than slow — cash is the only way to
                give the money back (plan decision D5). Credit sales never see
                this and always refund through Stripe. */}
            {isInteracOrder(selectedOrder) && (
              <div className="orm-field">
                <label className="orm-label">How is the money going back?</label>
                <div className="orm-method-choice">
                  <button
                    type="button"
                    className={`orm-method${refundMethod === "card" ? " orm-method--active" : ""}`}
                    onClick={() => setRefundMethod("card")}
                  >
                    <span className="orm-method__title">To the card</span>
                    <span className="orm-method__sub">
                      Customer taps their card on the reader
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`orm-method${refundMethod === "cash" ? " orm-method--active" : ""}`}
                    onClick={() => setRefundMethod("cash")}
                  >
                    <span className="orm-method__title">Refund as cash</span>
                    <span className="orm-method__sub">
                      Customer doesn't have the card — pay from the till
                    </span>
                  </button>
                </div>
                <p className="orm-method-note">
                  {refundMethod === "cash"
                    ? "No money goes back to the card. Hand the amount over in cash and it is recorded as a cash reversal."
                    : "Interac debit can only be refunded to the card with the card present at the reader."}
                </p>
              </div>
            )}

            <div className="orm-field">
              <label className="orm-label">Reason</label>
              <select className="orm-select" value={reason} onChange={(e) => setReason(e.target.value)}>
                {REFUND_REASONS.map((r) => (
                  <option key={r.key} value={r.key}>{r.label}</option>
                ))}
              </select>
            </div>

            {reason === "other" && (
              <div className="orm-field">
                <label className="orm-label">Reason Note (Required)</label>
                <input
                  type="text"
                  className="orm-input"
                  placeholder="State the reason for this reversal..."
                  value={reasonNote}
                  onChange={(e) => setReasonNote(e.target.value)}
                />
              </div>
            )}

            {actionType === "partial" && (
              <div className="orm-field">
                <label className="orm-label">Partial Refund Amount ($)</label>
                <input
                  type="number"
                  step="0.01"
                  max={selectedOrder.refund_summary.remaining_refundable}
                  className="orm-input"
                  value={partialAmount}
                  onChange={(e) => setPartialAmount(e.target.value)}
                />
              </div>
            )}

            {actionType === "line_item" && (
              <div className="orm-field">
                <label className="orm-label">Select Items to Refund</label>
                {selectedOrder.items.map((item) => {
                  const currentQty = lineQuantities[item.order_item_id] || 0;
                  return (
                    <div key={item.order_item_id} className="orm-line-row">
                      <div>
                        <span className="orm-item-name">{item.name}</span>{" "}
                        <span className="orm-line-price">${item.unit_price.toFixed(2)}</span>
                      </div>
                      <div className="orm-line-stepper">
                        <button
                          type="button"
                          className="orm-btn orm-btn--secondary orm-step-btn"
                          onClick={() => handleLineQtyChange(item.order_item_id, item.quantity, -1)}
                        >
                          −
                        </button>
                        <span className="orm-line-qty">{currentQty} / {item.quantity}</span>
                        <button
                          type="button"
                          className="orm-btn orm-btn--secondary orm-step-btn"
                          onClick={() => handleLineQtyChange(item.order_item_id, item.quantity, 1)}
                        >
                          +
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {selfVoidAllowed(selectedOrder, actionType) && (
              <p className="orm-options-note">
                The kitchen hasn't finished this order, so no manager approval
                is needed.
              </p>
            )}

            {/* A self-approved void never opens the PIN overlay, so its errors
                have to surface here or they'd be invisible. */}
            {pinError && !pinModalOpen && <div className="orm-error">{pinError}</div>}

            <div className="orm-options-actions">
              <button
                className="orm-btn orm-btn--primary"
                onClick={openPinApproval}
                disabled={submitting}
              >
                {selfVoidAllowed(selectedOrder, actionType)
                  ? `Void Order ($${calculatedReversalAmount.toFixed(2)})`
                  : `Approve & Submit ($${calculatedReversalAmount.toFixed(2)})`}
              </button>
              <button
                className="orm-btn orm-btn--secondary"
                onClick={() => setActionType(null)}
                disabled={submitting}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dual-Control Inline PIN Approval Modal */}
      {pinModalOpen && (
        <div className="orm-pin-overlay">
          <div className="orm-pin-modal">
            <h3 className="orm-pin-title">Approval Required</h3>
            
            {!selectedApprover ? (
              /* Step 1: Select Approver Name */
              <>
                <p className="orm-pin-subtitle">
                  Reversal of ${calculatedReversalAmount.toFixed(2)} — Select who is approving
                  {isOwnerRequired && <span className="orm-pin-required">Owner/Admin approval required for $100+</span>}
                </p>

                <div className="orm-approvers-list">
                  {eligibleApprovers.length === 0 ? (
                    <div className="orm-approvers-empty">No eligible approver found</div>
                  ) : (
                    eligibleApprovers.map((appr) => (
                      <button
                        key={appr.id}
                        type="button"
                        className="orm-approver-btn"
                        onClick={() => {
                          setSelectedApprover(appr);
                          setApproverPin("");
                          setPinError(null);
                        }}
                      >
                        <span>{appr.name}</span>
                        <span className="orm-approver-role">{appr.role}</span>
                      </button>
                    ))
                  )}
                </div>

                <button
                  type="button"
                  className="orm-btn orm-btn--secondary orm-pin-cancel-btn"
                  onClick={() => setPinModalOpen(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              /* Step 2: Enter PIN for selected approver */
              <>
                <button
                  type="button"
                  className="orm-change-approver-btn"
                  onClick={() => {
                    setSelectedApprover(null);
                    setApproverPin("");
                    setPinError(null);
                  }}
                >
                  ← Select Different Approver
                </button>

                <p className="orm-pin-subtitle">
                  Enter 4-digit PIN for <strong>{selectedApprover.name}</strong> ({selectedApprover.role.toUpperCase()})
                </p>

                <div className="orm-pin-dots">
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className={`orm-pin-dot${i < approverPin.length ? " orm-pin-dot--filled" : ""}`}
                    />
                  ))}
                </div>

                <div className="orm-keypad">
                  {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((num) => (
                    <button
                      key={num}
                      type="button"
                      className="orm-keypad-btn"
                      onClick={() => handleKeyPress(num)}
                      disabled={submitting}
                    >
                      {num}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="orm-keypad-btn"
                    onClick={handleKeyBackspace}
                    disabled={submitting}
                  >
                    ⌫
                  </button>
                  <button
                    type="button"
                    className="orm-keypad-btn"
                    onClick={() => handleKeyPress("0")}
                    disabled={submitting}
                  >
                    0
                  </button>
                  <button
                    type="button"
                    className="orm-keypad-btn orm-keypad-btn--cancel"
                    onClick={() => setPinModalOpen(false)}
                    disabled={submitting}
                  >
                    Cancel
                  </button>
                </div>

                {pinError && <div className="orm-error">{pinError}</div>}
              </>
            )}
          </div>
        </div>
      )}

      {receiptOrderId && (
        <ReceiptModal orderId={receiptOrderId} onClose={() => setReceiptOrderId(null)} />
      )}
    </div>
  );
}
