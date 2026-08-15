// ============================================================
// Shared order-recall logic — the POS Order Recall modal and Back Office →
// Orders → Order History both list past orders and can start a reversal from
// one, so the rules that decide what an order's state IS and what a selection
// of lines is WORTH live here rather than in either component.
//
// Pure: no React, no fetching. Presentation stays per-surface (the POS uses
// brand red, Back Office the warm admin palette), which is why orderState()
// returns a semantic key rather than a CSS class.
// ============================================================

// The fixed reason set, CHECK-constrained server-side in the same order.
export const REFUND_REASONS = [
  { key: "wrong_order", label: "Wrong Order Rung" },
  { key: "kitchen_error", label: "Kitchen Error" },
  { key: "quality_issue", label: "Quality Issue" },
  { key: "customer_cancelled", label: "Customer Cancelled" },
  { key: "overcharge", label: "Overcharge" },
  { key: "duplicate", label: "Duplicate Ticket" },
  { key: "other", label: "Other (Note Required)" },
];

// $ — reversals at/above this need owner/admin approval (POS dual control).
// Mirrors REFUND_OWNER_APPROVAL_THRESHOLD server-side.
export const REFUND_OWNER_APPROVAL_THRESHOLD = 100;

// The single place that decides how an order's state reads, so a list pill and
// a detail badge can never disagree — on either surface. Reversal state
// OUTRANKS the raw order status: once money has gone back, showing "READY" is
// actively misleading to whoever is deciding what to reverse next.
//
// Returns a key; each surface maps it to its own class and label.
export function orderState(order) {
  if (order.status === "cancelled") return "voided";
  if (order.refund_summary.is_fully_refunded) return "fully_refunded";
  if (order.refund_summary.total_refunded > 0) return "partially_refunded";
  return order.status;
}

export const ORDER_STATE_LABEL = {
  voided: "Voided",
  fully_refunded: "Fully Refunded",
  partially_refunded: "Partially Refunded",
  open: "Open",
  preparing: "Preparing",
  ready: "Completed",
  completed: "Completed",
};

export const orderStateLabel = (order) => {
  const key = orderState(order);
  return ORDER_STATE_LABEL[key] || key;
};

// Interac debit can only be refunded to the card with the card physically at
// the reader — Stripe cannot push an interac_present refund remotely (plan
// decision D5). Credit (card_present) is unaffected and always refunds through
// Stripe, so the cash-out choice is deliberately NOT offered there.
export const isInteracOrder = (order) => order?.processor_payment_type === "interac_present";

// Preview of what the selected lines are worth. MUST mirror the server's
// pricing in applyRefund() — (qty × unit_price) scaled by total/subtotal, so
// the order's discount and tax are included. The server is authoritative and
// recomputes this itself; matching it here keeps the amount shown to whoever
// is authorising honest, and keeps the $100 owner-approval gate in step with
// the threshold the server will actually apply.
export function lineItemRefundAmount(order, lineQuantities) {
  if (!order) return 0;
  const collectedRatio = order.subtotal > 0 ? order.total / order.subtotal : 0;
  let sum = 0;
  for (const item of order.items || []) {
    const qty = lineQuantities[item.order_item_id] || 0;
    if (qty > 0) {
      sum += Math.round((qty * item.unit_price * collectedRatio + Number.EPSILON) * 100) / 100;
    }
  }
  return Math.round((sum + Number.EPSILON) * 100) / 100;
}
