import { useState, useEffect, useCallback, useMemo } from "react";
import { API_URL } from "../config";
import ReceiptModal from "./ReceiptModal";
import useScrollLock from "../useScrollLock";
import {
  REFUND_REASONS,
  orderState,
  orderStateLabel,
  isInteracOrder,
  lineItemRefundAmount,
} from "./orderRecall";
import "./OrderHistory.css";

/**
 * Back Office → Orders → Order History.
 *
 * A searchable history of past orders for owners on a phone, so looking up a
 * ticket doesn't mean walking to a till and opening the POS Recall modal.
 *
 * Everything money-shaped is borrowed, not rebuilt:
 *  - the list and detail come from GET /api/backoffice/orders/history, which
 *    runs the SAME fetchRecallOrders() the POS recall endpoint does;
 *  - order state and the line-item price preview come from orderRecall.js,
 *    shared with OrderRecallModal;
 *  - the receipt is the same read-only buildReceipt() projection, rendered by
 *    the same ReceiptModal component;
 *  - a refund or void posts to the EXISTING POST /api/backoffice/orders/:id/
 *    refund, which has always been the Back Office reversal path and calls the
 *    same applyRefund() the POS does. No new reversal logic exists here.
 *
 * The one deliberate difference from the POS flow is approval. The POS is a
 * shared counter device, so it asks for an approver by name and PIN. Back
 * Office is already an authenticated owner/admin session behind email +
 * password + TOTP — that IS the approval, and the backoffice refund route has
 * always self-approved (approved_by = requested_by). Asking for a PIN here
 * would be theatre, not a second pair of eyes.
 */

const PAGE_SIZE = 25;

const STATE_PILL = {
  voided: "bo-pill--negative",
  fully_refunded: "bo-pill--warn",
  partially_refunded: "bo-pill--warn",
  ready: "bo-pill--positive",
  completed: "bo-pill--positive",
  open: "bo-pill--neutral",
  preparing: "bo-pill--neutral",
};

const STATUS_FILTERS = [
  { value: "", label: "Any status" },
  { value: "ready", label: "Completed" },
  { value: "cancelled", label: "Voided" },
  { value: "open", label: "Open" },
  { value: "preparing", label: "Preparing" },
];

const METHOD_FILTERS = [
  { value: "", label: "Any payment" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "gift_card", label: "Gift card" },
  { value: "other", label: "Other" },
];

const money = (n) => `$${Number(n).toFixed(2)}`;

// Local YYYY-MM-DD built from numeric parts, never from a parsed string: iOS
// Safari throws on new Date("YYYY-MM-DD") where Chromium accepts it — the same
// rule reportRange.js follows.
const toYmd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const shiftDays = (d, n) => {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
};

// Date presets resolve to a plain start/end pair, which is all the backend
// takes; it windows them in the location timezone.
function resolveDatePreset(key, today = new Date()) {
  if (key === "today") return { start: toYmd(today), end: toYmd(today) };
  if (key === "yesterday") {
    const y = shiftDays(today, -1);
    return { start: toYmd(y), end: toYmd(y) };
  }
  if (key === "week") {
    // Monday-start, matching Payroll's week and the rest of the app.
    const monday = shiftDays(today, -((today.getDay() + 6) % 7));
    return { start: toYmd(monday), end: toYmd(today) };
  }
  return { start: "", end: "" }; // custom / all
}

const DATE_PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "week", label: "This Week" },
  { key: "custom", label: "Custom" },
];

export default function OrderHistory() {
  const [orders, setOrders] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState("");
  const [datePreset, setDatePreset] = useState("today");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [status, setStatus] = useState("");
  const [method, setMethod] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [selectedId, setSelectedId] = useState(null);

  const range = useMemo(() => {
    if (datePreset === "custom") return { start: customStart, end: customEnd };
    return resolveDatePreset(datePreset);
  }, [datePreset, customStart, customEnd]);

  const buildQuery = useCallback(
    (offset) => {
      const qs = new URLSearchParams();
      if (search.trim()) qs.set("search", search.trim());
      if (range.start) qs.set("start", range.start);
      if (range.end) qs.set("end", range.end);
      if (status) qs.set("status", status);
      if (method) qs.set("method", method);
      qs.set("limit", String(PAGE_SIZE));
      qs.set("offset", String(offset));
      return qs.toString();
    },
    [search, range.start, range.end, status, method]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/backoffice/orders/history?${buildQuery(0)}`, {
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setOrders(data.orders || []);
      setHasMore(!!data.hasMore);
      setError(null);
    } catch (err) {
      setError(err.message || "Failed to load order history");
      setOrders([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [buildQuery]);

  // Debounced so typing an order number doesn't fire a request per keystroke.
  useEffect(() => {
    const id = setTimeout(load, 250);
    return () => clearTimeout(id);
  }, [load]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const res = await fetch(
        `${API_URL}/api/backoffice/orders/history?${buildQuery(orders.length)}`,
        { credentials: "include" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setOrders((prev) => [...prev, ...(data.orders || [])]);
      setHasMore(!!data.hasMore);
    } catch (err) {
      setError(err.message || "Failed to load more orders");
    } finally {
      setLoadingMore(false);
    }
  }, [buildQuery, orders.length]);

  const selectedOrder = useMemo(
    () => orders.find((o) => o.id === selectedId) || null,
    [orders, selectedId]
  );

  const activeFilterCount = (status ? 1 : 0) + (method ? 1 : 0);

  return (
    <div className="ordhist">
      <div className="ordhist__head">
        <h2 className="ordhist__title">Order History</h2>
      </div>

      <input
        type="search"
        className="ordhist__search"
        placeholder="Search order # or customer name…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="ordhist__presets">
        {DATE_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`ordhist__preset${datePreset === p.key ? " ordhist__preset--on" : ""}`}
            onClick={() => setDatePreset(p.key)}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          className={`ordhist__preset${filtersOpen || activeFilterCount ? " ordhist__preset--on" : ""}`}
          onClick={() => setFiltersOpen((v) => !v)}
          aria-expanded={filtersOpen}
        >
          Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}
        </button>
      </div>

      {datePreset === "custom" && (
        <div className="ordhist__daterange">
          <label className="ordhist__field">
            <span className="ordhist__field-label">Start</span>
            <input
              type="date"
              className="ordhist__input"
              value={customStart}
              max={customEnd || toYmd(new Date())}
              onChange={(e) => setCustomStart(e.target.value)}
            />
          </label>
          <label className="ordhist__field">
            <span className="ordhist__field-label">End</span>
            <input
              type="date"
              className="ordhist__input"
              value={customEnd}
              min={customStart}
              max={toYmd(new Date())}
              onChange={(e) => setCustomEnd(e.target.value)}
            />
          </label>
        </div>
      )}

      {filtersOpen && (
        <div className="ordhist__filters">
          <label className="ordhist__field">
            <span className="ordhist__field-label">Status</span>
            <select
              className="ordhist__input"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {STATUS_FILTERS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </label>
          <label className="ordhist__field">
            <span className="ordhist__field-label">Payment</span>
            <select
              className="ordhist__input"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              {METHOD_FILTERS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {error && <div className="ordhist__error">{error}</div>}

      {loading ? (
        <div className="ordhist__notice">Loading orders…</div>
      ) : orders.length === 0 ? (
        <div className="ordhist__empty">
          No orders match these filters. Try a wider date range.
        </div>
      ) : (
        <>
          <div className="ordhist__list">
            {orders.map((o) => {
              const state = orderState(o);
              return (
                <button
                  key={o.id}
                  className="ordhist-row"
                  onClick={() => setSelectedId(o.id)}
                >
                  <span className="ordhist-row__main">
                    <span className="ordhist-row__top">
                      <span className="ordhist-row__number">#{o.order_number}</span>
                      <span className={`bo-pill ${STATE_PILL[state] || "bo-pill--neutral"}`}>
                        {orderStateLabel(o)}
                      </span>
                    </span>
                    <span className="ordhist-row__sub">
                      {new Date(o.created_at).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                      {" · "}
                      {o.staff_name}
                      {" · "}
                      <span className="ordhist-row__method">{o.payment_method}</span>
                    </span>
                  </span>
                  <span className="ordhist-row__total">{money(o.total)}</span>
                  <ChevronIcon />
                </button>
              );
            })}
          </div>

          {hasMore && (
            <button className="ordhist__more" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}

      {selectedOrder && (
        <OrderDetailModal
          order={selectedOrder}
          onClose={() => setSelectedId(null)}
          onReversed={load}
        />
      )}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg className="ordhist-row__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6"></polyline>
    </svg>
  );
}

// View-first, like every other Back Office detail modal: it opens as a
// read-only record of the order, and a reversal is something you deliberately
// step into via "Refund or Void".
function OrderDetailModal({ order, onClose, onReversed }) {
  useScrollLock();
  const [showReceipt, setShowReceipt] = useState(false);
  const [reversing, setReversing] = useState(false);

  const state = orderState(order);
  const canReverse =
    order.status !== "cancelled" && order.refund_summary.remaining_refundable > 0;

  return (
    <div className="staffmgr__overlay" onClick={onClose}>
      <div className="staffmgr__modal" onClick={(e) => e.stopPropagation()}>
        <div className="staffmgr__modal-head">
          <h3 className="staffmgr__modal-title">Order #{order.order_number}</h3>
          <button className="staffmgr__modal-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="staffmgr__modal-body">
          <span className={`bo-pill ${STATE_PILL[state] || "bo-pill--neutral"}`}>
            {orderStateLabel(order)}
          </span>

          <div className="ordhist__detail-rows">
            <DetailRow label="Server" value={order.staff_name} />
            <DetailRow label="Payment" value={order.payment_method} mono />
            <DetailRow label="Time" value={new Date(order.created_at).toLocaleString()} />
            {order.customer_name && <DetailRow label="Customer" value={order.customer_name} />}
          </div>

          <div className="staffmgr__modal-divider" />

          <span className="ordhist__section-label">Items</span>
          <ul className="ordhist__items">
            {order.items.map((it) => (
              <li key={it.order_item_id} className="ordhist__item">
                <span className="ordhist__item-qty">{it.quantity}×</span>
                <span className="ordhist__item-name">
                  {it.name}
                  {it.variant_name && (
                    <span className="ordhist__item-variant"> ({it.variant_name})</span>
                  )}
                </span>
                <span className="ordhist__item-total">{money(it.line_total)}</span>
              </li>
            ))}
          </ul>

          <div className="ordhist__totals">
            <TotalRow label="Subtotal" value={money(order.subtotal)} />
            {order.discount > 0 && (
              <TotalRow
                label={`Discount (${order.discount_reason})`}
                value={`−${money(order.discount)}`}
                tone="discount"
              />
            )}
            <TotalRow label="Tax (HST 13%)" value={money(order.tax)} />
            {order.tip > 0 && <TotalRow label="Tip" value={money(order.tip)} />}
            <TotalRow label="Total paid" value={money(order.total)} tone="total" />
            {order.refund_summary.total_refunded > 0 && (
              <TotalRow
                label="Refunded"
                value={`−${money(order.refund_summary.total_refunded)}`}
                tone="refunded"
              />
            )}
          </div>

          {order.refunds?.length > 0 && (
            <>
              <span className="ordhist__section-label">Prior reversals</span>
              <div className="ordhist__log">
                {order.refunds.map((r) => {
                  const lines = (r.items || [])
                    .map((i) => (i.quantity > 1 ? `${i.name} ×${i.quantity}` : i.name))
                    .join(", ");
                  return (
                    <div key={r.id} className="ordhist__log-row">
                      <strong>{r.type.toUpperCase()}</strong> {money(r.amount)} —{" "}
                      {lines ? `${lines} (${r.reason})` : `${r.reason} (${r.approved_by_name})`}
                      {" · "}
                      {new Date(r.created_at).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                      {r.status !== "completed" && (
                        <span className="ordhist__log-status"> [{r.status}]</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <div className="staffmgr__modal-divider" />

          <div className="ordhist__actions">
            <button className="staffmgr__btn" onClick={() => setShowReceipt(true)}>
              View / Print Receipt
            </button>
            {canReverse && (
              <button
                className="staffmgr__btn staffmgr__btn--danger"
                onClick={() => setReversing(true)}
              >
                Refund or Void
              </button>
            )}
          </div>
        </div>
      </div>

      {showReceipt && (
        <ReceiptModal
          orderId={order.id}
          basePath="/api/backoffice/orders"
          allowEmail={false}
          onClose={() => setShowReceipt(false)}
        />
      )}

      {reversing && (
        <ReversalPanel
          order={order}
          onCancel={() => setReversing(false)}
          onDone={() => {
            setReversing(false);
            onClose();
            onReversed();
          }}
        />
      )}
    </div>
  );
}

function DetailRow({ label, value, mono }) {
  return (
    <div className="ordhist__detail-row">
      <span className="ordhist__detail-label">{label}</span>
      <span className={`ordhist__detail-value${mono ? " ordhist__detail-value--mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function TotalRow({ label, value, tone }) {
  return (
    <div className={`ordhist__total-row${tone ? ` ordhist__total-row--${tone}` : ""}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/**
 * The reversal form. Same four actions and the same fixed reason set as the
 * POS modal, and it posts to the endpoint Back Office has always used —
 * POST /api/backoffice/orders/:id/refund, which calls applyRefund() with
 * requested_by = approved_by = the session owner/admin. Every rule that
 * matters (cumulative ceiling, ready-only refunds, line validation, tax
 * proration, the Interac card-present rule) is enforced there, not here.
 */
function ReversalPanel({ order, onCancel, onDone }) {
  const [actionType, setActionType] = useState(null); // void | full | partial | line_item
  const [reason, setReason] = useState("wrong_order");
  const [reasonNote, setReasonNote] = useState("");
  const [partialAmount, setPartialAmount] = useState("");
  const [lineQuantities, setLineQuantities] = useState({});
  const [refundMethod, setRefundMethod] = useState("card");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const remaining = order.refund_summary.remaining_refundable;
  const lineTotal = useMemo(
    () => (actionType === "line_item" ? lineItemRefundAmount(order, lineQuantities) : 0),
    [order, actionType, lineQuantities]
  );

  const amount = useMemo(() => {
    if (actionType === "void") return order.total;
    if (actionType === "full") return remaining;
    if (actionType === "partial") return parseFloat(partialAmount) || 0;
    if (actionType === "line_item") return lineTotal;
    return 0;
  }, [actionType, order.total, remaining, partialAmount, lineTotal]);

  const start = (type) => {
    setActionType(type);
    setReason("wrong_order");
    setReasonNote("");
    setError(null);
    setRefundMethod("card");
    if (type === "partial") setPartialAmount(remaining.toFixed(2));
    if (type === "line_item") {
      const init = {};
      for (const it of order.items) init[it.order_item_id] = 0;
      setLineQuantities(init);
    }
  };

  const step = (orderItemId, maxQty, delta) => {
    setLineQuantities((prev) => ({
      ...prev,
      [orderItemId]: Math.max(0, Math.min(maxQty, (prev[orderItemId] || 0) + delta)),
    }));
  };

  const submit = async () => {
    if (submitting) return;
    if (reason === "other" && !reasonNote.trim()) {
      setError("A reason note is required when the reason is Other.");
      return;
    }
    if (actionType === "partial" && (!(amount > 0) || amount > remaining)) {
      setError(`Enter an amount between $0.01 and ${money(remaining)}.`);
      return;
    }
    if (actionType === "line_item" && !(lineTotal > 0)) {
      setError("Select at least one item to refund.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      // Line-item reversals deliberately send NO dollar amount — the server
      // prices the selected lines itself, the same never-trust-the-client rule
      // as checkout. Sending a figure here is what previously short-changed the
      // customer by the tax.
      const body = {
        type: actionType === "void" ? "void" : "refund",
        reason,
        reasonNote: reasonNote.trim() || undefined,
        ...(actionType === "partial" ? { amount: parseFloat(partialAmount) } : {}),
        ...(actionType === "full" ? { amount: remaining } : {}),
        ...(actionType === "line_item"
          ? {
              items: Object.entries(lineQuantities)
                .filter(([, q]) => q > 0)
                .map(([orderItemId, quantity]) => ({ orderItemId, quantity })),
            }
          : {}),
        ...(isInteracOrder(order) && refundMethod === "cash" ? { refundMethod: "cash" } : {}),
      };

      const res = await fetch(`${API_URL}/api/backoffice/orders/${order.id}/refund`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onDone();
    } catch (err) {
      setError(err.message || "Failed to process the reversal");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ordhist__sheet" onClick={(e) => e.stopPropagation()}>
      <div className="ordhist__sheet-card">
        <h4 className="ordhist__sheet-title">
          {actionType ? `Confirm ${actionType.replace("_", " ")} — ${money(amount)}` : "Refund or Void"}
        </h4>
        <p className="ordhist__sheet-sub">
          Order #{order.order_number} · {money(remaining)} refundable
        </p>

        {!actionType ? (
          <div className="ordhist__sheet-actions">
            {order.refund_summary.total_refunded === 0 && (
              <button className="staffmgr__btn staffmgr__btn--danger" onClick={() => start("void")}>
                Void &amp; Refund Full Amount
              </button>
            )}
            {order.status === "ready" ? (
              <>
                <button className="staffmgr__btn" onClick={() => start("full")}>
                  Full Refund ({money(remaining)})
                </button>
                <button className="staffmgr__btn" onClick={() => start("partial")}>
                  Partial Amount
                </button>
                <button className="staffmgr__btn" onClick={() => start("line_item")}>
                  Line Items
                </button>
              </>
            ) : (
              <p className="ordhist__sheet-note">
                This order isn't completed yet, so it's reversed with a void rather than a refund.
              </p>
            )}
            <button className="staffmgr__btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            {isInteracOrder(order) && (
              <div className="ordhist__field-block">
                <span className="ordhist__field-label">How is the money going back?</span>
                <div className="ordhist__method-choice">
                  <button
                    type="button"
                    className={`ordhist__method${refundMethod === "card" ? " ordhist__method--on" : ""}`}
                    onClick={() => setRefundMethod("card")}
                  >
                    To the card
                  </button>
                  <button
                    type="button"
                    className={`ordhist__method${refundMethod === "cash" ? " ordhist__method--on" : ""}`}
                    onClick={() => setRefundMethod("cash")}
                  >
                    Refund as cash
                  </button>
                </div>
                <p className="ordhist__sheet-note">
                  Interac can only go back to the card with the card at the reader. From here that
                  isn't possible, so a cash reversal is usually the only option.
                </p>
              </div>
            )}

            <div className="ordhist__field-block">
              <span className="ordhist__field-label">Reason</span>
              <select
                className="ordhist__input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              >
                {REFUND_REASONS.map((r) => (
                  <option key={r.key} value={r.key}>{r.label}</option>
                ))}
              </select>
            </div>

            {reason === "other" && (
              <div className="ordhist__field-block">
                <span className="ordhist__field-label">Note (required)</span>
                <input
                  className="ordhist__input"
                  value={reasonNote}
                  onChange={(e) => setReasonNote(e.target.value)}
                  placeholder="State the reason for this reversal"
                />
              </div>
            )}

            {actionType === "partial" && (
              <div className="ordhist__field-block">
                <span className="ordhist__field-label">Amount ($)</span>
                <input
                  type="number"
                  step="0.01"
                  max={remaining}
                  className="ordhist__input"
                  value={partialAmount}
                  onChange={(e) => setPartialAmount(e.target.value)}
                />
              </div>
            )}

            {actionType === "line_item" && (
              <div className="ordhist__field-block">
                <span className="ordhist__field-label">Items to refund</span>
                {order.items.map((it) => (
                  <div key={it.order_item_id} className="ordhist__line">
                    <span className="ordhist__line-name">{it.name}</span>
                    <span className="ordhist__stepper">
                      <button
                        type="button"
                        onClick={() => step(it.order_item_id, it.quantity, -1)}
                      >
                        −
                      </button>
                      <span className="ordhist__line-qty">
                        {lineQuantities[it.order_item_id] || 0} / {it.quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => step(it.order_item_id, it.quantity, 1)}
                      >
                        +
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {error && <div className="ordhist__error">{error}</div>}

            <div className="ordhist__sheet-actions">
              <button
                className="staffmgr__btn staffmgr__btn--danger"
                onClick={submit}
                disabled={submitting}
              >
                {submitting ? "Processing…" : `Confirm ${money(amount)}`}
              </button>
              <button
                className="staffmgr__btn"
                onClick={() => setActionType(null)}
                disabled={submitting}
              >
                Back
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
