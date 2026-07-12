import { useState, useEffect, useCallback, useRef } from "react";
import "./KitchenDisplay.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";
const POLL_MS = 5000;
const KDS_STATUSES = "open,preparing";
const FAIL_FLASH_MS = 2500; // how long a card shows its "update failed" state

// One forward step per tap: open → preparing → ready.
const NEXT_STATUS = { open: "preparing", preparing: "ready" };
const STATUS_LABEL = { open: "NEW", preparing: "IN PROGRESS" };
const TAP_HINT = { open: "TAP TO START", preparing: "TAP WHEN READY" };

/**
 * Kitchen Display System — live order queue.
 * No auth: this screen is opened once on a kitchen device and left running.
 * Orders arrive FIFO (oldest first) from the backend and are rendered in that
 * order. Tapping a card advances its status; once an order hits `ready` it
 * leaves the open,preparing filter and drops off the board.
 */
export default function KitchenDisplay() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [patchingIds, setPatchingIds] = useState(() => new Set());
  // Cards whose last status update failed — shown as a brief inline state so
  // a cook a few feet away notices the tap didn't take. Auto-clears.
  const [failedIds, setFailedIds] = useState(() => new Set());
  const failTimers = useRef(new Map()); // orderId -> timeout id

  const markFailed = useCallback((orderId) => {
    setFailedIds((prev) => new Set(prev).add(orderId));
    const timers = failTimers.current;
    if (timers.has(orderId)) clearTimeout(timers.get(orderId));
    timers.set(
      orderId,
      setTimeout(() => {
        setFailedIds((prev) => {
          const s = new Set(prev);
          s.delete(orderId);
          return s;
        });
        failTimers.current.delete(orderId);
      }, FAIL_FLASH_MS)
    );
  }, []);

  const clearFailed = useCallback((orderId) => {
    const timers = failTimers.current;
    if (timers.has(orderId)) {
      clearTimeout(timers.get(orderId));
      timers.delete(orderId);
    }
    setFailedIds((prev) => {
      if (!prev.has(orderId)) return prev;
      const s = new Set(prev);
      s.delete(orderId);
      return s;
    });
  }, []);

  // Clear any pending fail-flash timers on unmount.
  useEffect(() => {
    const timers = failTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/orders?status=${KDS_STATUSES}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Backend already sorts FIFO (oldest created_at first) — do NOT re-sort.
      setOrders(data);
      setError(null);
    } catch {
      // Keep the last good queue on screen; just surface a quiet notice.
      setError("Connection issue — retrying…");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + 5s polling (cleared on unmount). No websockets in v1.
  useEffect(() => {
    fetchOrders();
    const id = setInterval(fetchOrders, POLL_MS);
    return () => clearInterval(id);
  }, [fetchOrders]);

  const advanceOrder = useCallback(
    async (order) => {
      const next = NEXT_STATUS[order.status];
      if (!next) return;

      // Guard: while a PATCH is in flight for this card, ignore further taps.
      let blocked = false;
      setPatchingIds((prev) => {
        if (prev.has(order.id)) {
          blocked = true;
          return prev;
        }
        const s = new Set(prev);
        s.add(order.id);
        return s;
      });
      if (blocked) return;

      // A fresh attempt clears any lingering "failed" flash on this card.
      clearFailed(order.id);

      try {
        const res = await fetch(`${API_URL}/api/orders/${order.id}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: next }),
        });
        const updated = await res.json();
        if (!res.ok) throw new Error(updated.error || `HTTP ${res.status}`);

        // Apply the returned order: keep it if it's still in the queue filter,
        // drop it the moment it becomes `ready` (falls out of open,preparing).
        setOrders((prev) =>
          prev
            .map((o) => (o.id === updated.id ? updated : o))
            .filter((o) => o.status === "open" || o.status === "preparing")
        );
      } catch (err) {
        // Show the failure ON the card itself. (A top banner here got wiped
        // instantly by the resync below, so staff never saw it.) The inline
        // flash is independent of the resync and holds for FAIL_FLASH_MS.
        markFailed(order.id);
        // Resync to the real backend state so the card isn't left stale.
        fetchOrders();
      } finally {
        setPatchingIds((prev) => {
          const s = new Set(prev);
          s.delete(order.id);
          return s;
        });
      }
    },
    [fetchOrders, clearFailed, markFailed]
  );

  return (
    <div className="kds">
      <header className="kds__header">
        <div className="kds__brand">
          NARCOS <span className="kds__brand-alt">TACOS</span>
        </div>
        <div className="kds__header-right">
          <span className="kds__title">KITCHEN</span>
          <span className="kds__count">{orders.length}</span>
        </div>
      </header>

      {error && <div className="kds__error">{error}</div>}

      <main className="kds__board">
        {loading ? (
          <div className="kds__empty">Loading orders…</div>
        ) : orders.length === 0 ? (
          <div className="kds__empty">
            <div className="kds__empty-check">✓</div>
            <div className="kds__empty-title">All caught up</div>
            <div className="kds__empty-sub">No open orders right now</div>
          </div>
        ) : (
          orders.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              busy={patchingIds.has(order.id)}
              failed={failedIds.has(order.id)}
              onAdvance={() => advanceOrder(order)}
            />
          ))
        )}
      </main>
    </div>
  );
}

function OrderCard({ order, busy, failed, onAdvance }) {
  const handleKey = (e) => {
    if ((e.key === "Enter" || e.key === " ") && !busy) {
      e.preventDefault();
      onAdvance();
    }
  };

  return (
    <div
      className={`kds-card kds-card--${order.status}${busy ? " kds-card--busy" : ""}${
        failed ? " kds-card--failed" : ""
      }`}
      role="button"
      tabIndex={0}
      aria-disabled={busy}
      onClick={busy ? undefined : onAdvance}
      onKeyDown={handleKey}
    >
      <div className="kds-card__top">
        <span className="kds-card__number">#{order.order_number}</span>
        <span className="kds-card__status">
          {STATUS_LABEL[order.status] || order.status}
        </span>
      </div>

      <div className="kds-card__items">
        {order.items.map((item) => (
          <ItemBlock key={item.id} item={item} />
        ))}
      </div>

      <div className="kds-card__cta">
        {busy
          ? "SENDING…"
          : failed
          ? "UPDATE FAILED · TAP TO RETRY"
          : TAP_HINT[order.status] || ""}
      </div>
    </div>
  );
}

function ItemBlock({ item }) {
  const hasChoices = item.selected_options?.length > 0;
  const hasRemoved = item.removed_ingredients?.length > 0;
  const hasAdded = item.added_modifiers?.length > 0;
  const hasAddons = item.addons?.length > 0;

  return (
    <div className="kds-item">
      <div className="kds-item__head">
        <span className="kds-item__qty">{item.quantity}×</span>
        <span className="kds-item__name">
          {item.name}
          {item.variant && <span className="kds-item__variant"> · {item.variant}</span>}
        </span>
      </div>

      {hasChoices && (
        <div className="kds-item__choices">
          {item.selected_options.map((opt, i) => (
            <span key={i} className="kds-item__choice">
              {opt.choice}
            </span>
          ))}
        </div>
      )}

      {/* Most important thing on the card — must not be missed */}
      {hasRemoved && (
        <div className="kds-item__removed">
          {item.removed_ingredients.map((name, i) => (
            <span key={i} className="kds-item__removed-tag">
              NO {name}
            </span>
          ))}
        </div>
      )}

      {hasAdded && (
        <div className="kds-item__added">
          {item.added_modifiers.map((m, i) => (
            <div key={i} className="kds-item__added-line">
              + {m.name}
              {m.quantity > 1 && <span className="kds-item__added-qty"> ×{m.quantity}</span>}
            </div>
          ))}
        </div>
      )}

      {hasAddons && (
        <div className="kds-item__addons">
          {item.addons.map((a, i) => (
            <div key={i} className="kds-item__addon-line">
              <span className="kds-item__addon-name">{a.name}</span>
              <span className="kds-item__addon-qty">×{a.quantity}</span>
              {a.is_complimentary && <span className="kds-item__free">FREE</span>}
            </div>
          ))}
        </div>
      )}

      {item.notes && <div className="kds-item__notes">Note: {item.notes}</div>}
    </div>
  );
}
