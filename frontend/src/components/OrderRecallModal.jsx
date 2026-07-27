import { useState, useEffect, useCallback, useMemo } from "react";
import { API_URL } from "../config";
import "./OrderRecallModal.css";

const REFUND_REASONS = [
  { key: "wrong_order", label: "Wrong Order Rung" },
  { key: "kitchen_error", label: "Kitchen Error" },
  { key: "quality_issue", label: "Quality Issue" },
  { key: "customer_cancelled", label: "Customer Cancelled" },
  { key: "overcharge", label: "Overcharge" },
  { key: "duplicate", label: "Duplicate Ticket" },
  { key: "other", label: "Other (Note Required)" },
];

const REFUND_OWNER_APPROVAL_THRESHOLD = 100; // $ — reversals at/above $100 require Owner/Admin approval

export default function OrderRecallModal({ staff, onClose, onOrderUpdated }) {
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

  // PIN Approval Modal state
  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [selectedApprover, setSelectedApprover] = useState(null);
  const [approverPin, setApproverPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pinError, setPinError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

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
      if (data.orders?.length > 0 && !selectedOrderId) {
        setSelectedOrderId(data.orders[0].id);
      }
    } catch (err) {
      console.error("Order recall fetch failed:", err.message);
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, [selectedOrderId]);

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

  const selectedOrder = useMemo(
    () => orders.find((o) => o.id === selectedOrderId) || orders[0] || null,
    [orders, selectedOrderId]
  );

  // Reset form when switching selected order
  useEffect(() => {
    setActionType(null);
    setReason("wrong_order");
    setReasonNote("");
    setPartialAmount("");
    setLineQuantities({});
    setSuccessMsg(null);
  }, [selectedOrderId]);

  // Calculate line item refund amount
  const lineItemTotalAmount = useMemo(() => {
    if (!selectedOrder || actionType !== "line_item") return 0;
    let sum = 0;
    for (const item of selectedOrder.items || []) {
      const qty = lineQuantities[item.order_item_id] || 0;
      if (qty > 0) {
        sum += qty * item.unit_price;
      }
    }
    return Math.round((sum + Number.EPSILON) * 100) / 100;
  }, [selectedOrder, actionType, lineQuantities]);

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
    setSuccessMsg(null);

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

  // Submit Reversal
  const submitReversal = async (e) => {
    if (e) e.preventDefault();
    if (!selectedApprover || approverPin.length !== 4) return;

    setSubmitting(true);
    setPinError(null);

    const type = actionType === "void" ? "void" : "refund";
    let amountPayload = undefined;
    if (actionType === "partial") {
      amountPayload = parseFloat(partialAmount);
    } else if (actionType === "line_item") {
      amountPayload = lineItemTotalAmount;
    } else if (actionType === "full") {
      amountPayload = selectedOrder.refund_summary.remaining_refundable;
    }

    let itemsPayload = undefined;
    if (actionType === "line_item") {
      itemsPayload = Object.entries(lineQuantities)
        .filter(([, qty]) => qty > 0)
        .map(([orderItemId, qty]) => {
          const item = selectedOrder.items.find((i) => i.order_item_id === orderItemId);
          return {
            orderItemId,
            quantity: qty,
            amount: Math.round((qty * item.unit_price + Number.EPSILON) * 100) / 100,
          };
        });
    }

    try {
      const res = await fetch(`${API_URL}/api/orders/${selectedOrder.id}/refund`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: staff.id,
          approverStaffId: selectedApprover.id,
          approverPin,
          type,
          reason,
          reasonNote: reasonNote.trim() || undefined,
          amount: amountPayload,
          items: itemsPayload,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to process reversal");

      // Success
      setPinModalOpen(false);
      setActionType(null);
      setSelectedApprover(null);
      setSuccessMsg(`${type.toUpperCase()} processed successfully!`);
      fetchOrders(search);
      if (onOrderUpdated) onOrderUpdated();
    } catch (err) {
      setPinError(err.message || "Failed to process reversal");
      setApproverPin("");
    } finally {
      setSubmitting(false);
    }
  };

  // Auto-submit when 4 digits entered
  useEffect(() => {
    if (approverPin.length === 4 && pinModalOpen && selectedApprover && !submitting) {
      submitReversal();
    }
  }, [approverPin, pinModalOpen, selectedApprover, submitting]);

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
                <div style={{ padding: "1rem", textAlign: "center", color: "#888" }}>Loading...</div>
              ) : orders.length === 0 ? (
                <div style={{ padding: "1rem", textAlign: "center", color: "#888" }}>No orders found</div>
              ) : (
                orders.map((o) => {
                  const isSel = selectedOrder?.id === o.id;
                  let badgeClass = "orm-badge--ready";
                  let statusText = o.status;

                  if (o.status === "cancelled") {
                    badgeClass = "orm-badge--cancelled";
                    statusText = "Voided";
                  } else if (o.refund_summary.is_fully_refunded) {
                    badgeClass = "orm-badge--refunded";
                    statusText = "Fully Refunded";
                  } else if (o.refund_summary.total_refunded > 0) {
                    badgeClass = "orm-badge--refunded";
                    statusText = "Partially Refunded";
                  }

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
                        <span className={`orm-badge ${badgeClass}`}>{statusText}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Main Pane: Details & Actions */}
          <div className="orm-content">
            {!selectedOrder ? (
              <div className="orm-empty-state">Select an order on the left to view details</div>
            ) : (
              <>
                <div className="orm-detail-header">
                  <div>
                    <h3 className="orm-detail-title">Order #{selectedOrder.order_number}</h3>
                    <div className="orm-detail-meta">
                      <span>Server: <strong>{selectedOrder.staff_name}</strong></span>
                      <span>Payment: <strong style={{ textTransform: "uppercase" }}>{selectedOrder.payment_method}</strong></span>
                      <span>Time: {new Date(selectedOrder.created_at).toLocaleString()}</span>
                    </div>
                  </div>
                  <div>
                    <span className={`orm-badge ${
                      selectedOrder.status === "cancelled" ? "orm-badge--cancelled" : "orm-badge--ready"
                    }`}>
                      {selectedOrder.status.toUpperCase()}
                    </span>
                  </div>
                </div>

                {successMsg && (
                  <div style={{ padding: "0.75rem", background: "#e6f4ea", color: "#137333", borderRadius: "8px", fontWeight: "600", marginBottom: "1rem" }}>
                    ✓ {successMsg}
                  </div>
                )}

                {/* Items Table */}
                <table className="orm-items-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th style={{ textAlign: "center" }}>Qty</th>
                      <th style={{ textAlign: "right" }}>Price</th>
                      <th style={{ textAlign: "right" }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedOrder.items.map((item) => (
                      <tr key={item.order_item_id}>
                        <td>
                          <strong>{item.name}</strong>
                          {item.variant_name && <span style={{ color: "#666" }}> ({item.variant_name})</span>}
                        </td>
                        <td style={{ textAlign: "center" }}>{item.quantity}</td>
                        <td style={{ textAlign: "right" }}>${item.unit_price.toFixed(2)}</td>
                        <td style={{ textAlign: "right" }}>${item.line_total.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Order Summary */}
                <div className="orm-summary-box">
                  <div className="orm-summary-row"><span>Subtotal:</span><span>${selectedOrder.subtotal.toFixed(2)}</span></div>
                  {selectedOrder.discount > 0 && (
                    <div className="orm-summary-row" style={{ color: "#d93025" }}>
                      <span>Discount ({selectedOrder.discount_reason}):</span>
                      <span>-${selectedOrder.discount.toFixed(2)}</span>
                    </div>
                  )}
                  <div className="orm-summary-row"><span>Tax (HST 13%):</span><span>${selectedOrder.tax.toFixed(2)}</span></div>
                  <div className="orm-summary-row orm-summary-row--total">
                    <span>Total Paid:</span><span>${selectedOrder.total.toFixed(2)}</span>
                  </div>
                  {selectedOrder.refund_summary.total_refunded > 0 && (
                    <div className="orm-summary-row" style={{ color: "#b06000", fontWeight: "600", marginTop: "0.4rem" }}>
                      <span>Total Refunded:</span>
                      <span>-${selectedOrder.refund_summary.total_refunded.toFixed(2)}</span>
                    </div>
                  )}
                </div>

                {/* Prior Refunds Log */}
                {selectedOrder.refunds?.length > 0 && (
                  <div style={{ marginBottom: "1.25rem" }}>
                    <h4 style={{ fontSize: "0.9rem", textTransform: "uppercase", color: "#666", marginBottom: "0.5rem" }}>Prior Reversal Log</h4>
                    {selectedOrder.refunds.map((r) => (
                      <div key={r.id} style={{ fontSize: "0.85rem", padding: "0.4rem 0.6rem", background: "#fff8e1", borderRadius: "6px", marginBottom: "0.4rem" }}>
                        <strong>{r.type.toUpperCase()}</strong> ${r.amount.toFixed(2)} — {r.reason} ({r.approved_by_name}) on {new Date(r.created_at).toLocaleTimeString()}
                      </div>
                    ))}
                  </div>
                )}

                {/* Reversal Action Buttons */}
                {selectedOrder.status !== "cancelled" && selectedOrder.refund_summary.remaining_refundable > 0 && (
                  <div className="orm-actions-bar">
                    {selectedOrder.refund_summary.total_refunded === 0 && (
                      <button className="orm-btn orm-btn--danger" onClick={() => startAction("void")}>
                        Void Order
                      </button>
                    )}
                    <button className="orm-btn orm-btn--warning" onClick={() => startAction("full")}>
                      Full Refund (${selectedOrder.refund_summary.remaining_refundable.toFixed(2)})
                    </button>
                    <button className="orm-btn orm-btn--secondary" onClick={() => startAction("partial")}>
                      Partial Amount Refund
                    </button>
                    <button className="orm-btn orm-btn--secondary" onClick={() => startAction("line_item")}>
                      Line-Item Refund
                    </button>
                  </div>
                )}

                {/* Reversal Form */}
                {actionType && (
                  <div className="orm-form">
                    <h4 className="orm-form-title">
                      Confirm {actionType.toUpperCase().replace("_", " ")} — ${calculatedReversalAmount.toFixed(2)}
                    </h4>

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
                            <div key={item.order_item_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.5rem 0", borderBottom: "1px solid #eee" }}>
                              <div>
                                <span>{item.name}</span> (${item.unit_price.toFixed(2)})
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                                <button
                                  type="button"
                                  className="orm-btn orm-btn--secondary"
                                  style={{ padding: "0.2rem 0.6rem" }}
                                  onClick={() => handleLineQtyChange(item.order_item_id, item.quantity, -1)}
                                >
                                  −
                                </button>
                                <span style={{ fontWeight: "700", minWidth: "20px", textAlign: "center" }}>{currentQty} / {item.quantity}</span>
                                <button
                                  type="button"
                                  className="orm-btn orm-btn--secondary"
                                  style={{ padding: "0.2rem 0.6rem" }}
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

                    <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
                      <button className="orm-btn orm-btn--primary" onClick={openPinApproval}>
                        Approve & Submit (${calculatedReversalAmount.toFixed(2)})
                      </button>
                      <button className="orm-btn orm-btn--secondary" onClick={() => setActionType(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

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
                  {isOwnerRequired && <span style={{ color: "#d93025", display: "block", fontWeight: "600", marginTop: "0.2rem" }}>Owner/Admin approval required for $100+</span>}
                </p>

                <div className="orm-approvers-list">
                  {eligibleApprovers.length === 0 ? (
                    <div style={{ color: "#888", padding: "1rem" }}>No eligible approver found</div>
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
                  className="orm-btn orm-btn--secondary"
                  style={{ width: "100%", marginTop: "0.5rem" }}
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

                <p className="orm-pin-subtitle" style={{ fontSize: "0.95rem" }}>
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
                    className="orm-keypad-btn"
                    style={{ fontSize: "0.9rem", color: "#d93025" }}
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
    </div>
  );
}
