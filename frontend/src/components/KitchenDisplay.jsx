import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { API_URL } from "../config";
import logoImg from "../assets/narcos-tacos-logo.png";
import "./KitchenDisplay.css";

const POLL_MS = 5000;
const KDS_STATUSES = "open,preparing";
const FAIL_FLASH_MS = 2500; // how long a card shows its "update failed" state
const UNDO_TOAST_MS = 6000; // how long the undo toast stays visible

// --- Elapsed-time escalation thresholds (minutes) — tune here as needed ---
const ELAPSED_YELLOW_MIN = 5; // green → yellow at/after this many minutes
const ELAPSED_RED_MIN = 10; //   yellow → red at/after this many minutes

// --- Past Orders window ---
const HISTORY_SINCE_HOURS = 6;

// One forward step per tap: open → preparing → ready.
const NEXT_STATUS = { open: "preparing", preparing: "ready" };
const STATUS_LABEL = { open: "NEW", preparing: "IN PROGRESS" };
const TAP_HINT = { open: "TAP TO START", preparing: "TAP WHEN READY" };

// ---- Time helpers ----
function elapsedSeconds(iso, nowMs) {
  return Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 1000));
}

// "4:32" (M:SS, minutes uncapped so a 72-minute order still reads correctly)
function formatMMSS(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function elapsedTier(totalSec) {
  const min = totalSec / 60;
  if (min >= ELAPSED_RED_MIN) return "red";
  if (min >= ELAPSED_YELLOW_MIN) return "yellow";
  return "green";
}

// Duration between two ISO timestamps → "6m 42s"
function formatDuration(fromIso, toIso) {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

// Wall-clock time an order completed → "2:14 PM"
function formatClock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ---- New-order chime via Web Audio API ----
// Two quick ascending tones, subtle and non-alarming.
// Browser autoplay restrictions: AudioContext starts suspended until a user
// gesture. We attempt to resume() on the first click/touchstart anywhere on
// the page, then play silently fails until that happens — no errors, no spam.
let audioCtx = null;
let audioUnlocked = false;

function ensureAudioCtx() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      // Web Audio not available — chime will silently no-op.
      return null;
    }
  }
  return audioCtx;
}

function unlockAudio() {
  if (audioUnlocked) return;
  const ctx = ensureAudioCtx();
  if (ctx && ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  audioUnlocked = true;
}

function playChime() {
  const ctx = ensureAudioCtx();
  if (!ctx || ctx.state === "suspended") return;

  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0.12, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

  // Tone 1: 523 Hz (C5) — 0.12s
  const osc1 = ctx.createOscillator();
  osc1.type = "sine";
  osc1.frequency.setValueAtTime(523, now);
  osc1.connect(gain);
  osc1.start(now);
  osc1.stop(now + 0.12);

  // Tone 2: 659 Hz (E5) — 0.12s, starts right after tone 1
  const gain2 = ctx.createGain();
  gain2.connect(ctx.destination);
  gain2.gain.setValueAtTime(0.10, now + 0.13);
  gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

  const osc2 = ctx.createOscillator();
  osc2.type = "sine";
  osc2.frequency.setValueAtTime(659, now + 0.13);
  osc2.connect(gain2);
  osc2.start(now + 0.13);
  osc2.stop(now + 0.25);
}

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
  // Ticks once a second so elapsed timers update smoothly between the 5s polls.
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Past Orders overlay toggle.
  const [pastOpen, setPastOpen] = useState(false);
  // Fast Mode: aggregated rush-hour view. Manual toggle only, view-only —
  // completing orders still happens in the normal ticket view.
  const [fastMode, setFastMode] = useState(false);
  // Undo last action — single-level.
  const [undoAction, setUndoAction] = useState(null); // { orderId, orderNumber, previousStatus }
  const undoTimer = useRef(null);
  // Known order IDs — for detecting genuinely new orders (vs. existing on reload).
  const knownOrderIds = useRef(null); // null = first load, Set after
  // Track if initial load is complete for chime gating.
  const initialLoadDone = useRef(false);

  // Unlock Web Audio on first user interaction anywhere on the KDS.
  useEffect(() => {
    const handler = () => unlockAudio();
    document.addEventListener("click", handler, { once: true, capture: true });
    document.addEventListener("touchstart", handler, { once: true, capture: true });
    return () => {
      document.removeEventListener("click", handler, { capture: true });
      document.removeEventListener("touchstart", handler, { capture: true });
    };
  }, []);

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

  // 1s clock tick — drives the elapsed timers client-side, independent of the
  // 5s data poll, so counters advance smoothly and never stutter on refetch.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/orders?status=${KDS_STATUSES}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Backend already sorts FIFO (oldest created_at first) — do NOT re-sort.

      // Detect genuinely new orders for the chime. Skip on first load.
      if (knownOrderIds.current !== null && initialLoadDone.current) {
        const newIds = data.filter((o) => !knownOrderIds.current.has(o.id));
        if (newIds.length > 0) {
          playChime();
        }
      }
      knownOrderIds.current = new Set(data.map((o) => o.id));
      if (!initialLoadDone.current) initialLoadDone.current = true;

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

  // --- Undo helpers ---
  const clearUndo = useCallback(() => {
    setUndoAction(null);
    if (undoTimer.current) {
      clearTimeout(undoTimer.current);
      undoTimer.current = null;
    }
  }, []);

  const startUndoTimer = useCallback(
    (action) => {
      clearUndo();
      setUndoAction(action);
      undoTimer.current = setTimeout(() => {
        setUndoAction(null);
        undoTimer.current = null;
      }, UNDO_TOAST_MS);
    },
    [clearUndo]
  );

  const performUndo = useCallback(async () => {
    if (!undoAction) return;
    const { orderId } = undoAction;
    clearUndo();

    try {
      const res = await fetch(`${API_URL}/api/orders/${orderId}/status/revert`, {
        method: "PATCH",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      // Refresh the board
      fetchOrders();
    } catch (err) {
      console.error("Undo failed:", err.message);
      // Silent fail — the next poll will sync anyway.
    }
  }, [undoAction, clearUndo, fetchOrders]);

  // Clean up undo timer on unmount.
  useEffect(() => {
    return () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    };
  }, []);

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

        // Offer undo for this action.
        startUndoTimer({
          orderId: order.id,
          orderNumber: order.order_number,
          previousStatus: order.status,
        });
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
    [fetchOrders, clearFailed, markFailed, startUndoTimer]
  );

  // Fast Mode aggregation — pure client-side reshaping of the SAME polled
  // order data (open/preparing only, no extra fetching). Two lines merge only
  // when item_id + variant_id + the FULL modifier set (option ids AND
  // quantities) match exactly; any difference is a separate line, because the
  // cook needs to see exactly what to make.
  const fastLines = useMemo(() => {
    const map = new Map();
    for (const order of orders) {
      for (const it of order.items) {
        const modKey = (it.modifiers_raw || [])
          .map((m) => `${m.option_id}:${m.quantity}`)
          .sort()
          .join(",");
        const key = `${it.item_id}|${it.variant_id || ""}|${modKey}`;
        const entry = map.get(key);
        if (entry) {
          entry.count += it.quantity;
          // Track the oldest source order so the line can carry the same
          // elapsed-tier color language as the ticket view.
          if (new Date(order.created_at) < new Date(entry.oldestCreatedAt)) {
            entry.oldestCreatedAt = order.created_at;
          }
        } else {
          map.set(key, {
            key,
            count: it.quantity,
            oldestCreatedAt: order.created_at,
            sample: it, // identical modifier set ⇒ identical display fields
          });
        }
      }
    }
    // Busiest first; ties broken by oldest order so urgent work floats up
    return [...map.values()].sort(
      (a, b) =>
        b.count - a.count ||
        new Date(a.oldestCreatedAt) - new Date(b.oldestCreatedAt)
    );
  }, [orders]);

  const orderCountClass = orders.length > 0 ? "kds__badge--active" : "kds__badge--clear";

  return (
    <div className="kds">
      <header className="kds__header">
        <img src={logoImg} alt="NARCOS TACOS" className="kds__logo" />

        {/* Nav center: Fast Mode (left) — Order Count Badge (center) — Past Orders (right) */}
        <nav className="kds__nav">
          <label className="kds__fast-toggle">
            <span className="kds__fast-toggle-text">Fast Mode</span>
            <span className="kds__switch">
              <input
                type="checkbox"
                checked={fastMode}
                onChange={() => setFastMode((v) => !v)}
              />
              <span className="kds__switch-slider" />
            </span>
          </label>

          <div className={`kds__badge ${orderCountClass}`} title="Open orders">
            <span className="kds__badge-num">{orders.length}</span>
            <span className="kds__badge-label">orders</span>
          </div>

          <button className="kds__past-link" onClick={() => setPastOpen(true)}>
            Completed Orders
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </button>
        </nav>
      </header>

      {error && <div className="kds__error">{error}</div>}

      <main className={`kds__board${fastMode ? " kds__board--fast" : ""}`}>
        {loading ? (
          <div className="kds__empty">Loading orders…</div>
        ) : orders.length === 0 ? (
          <div className="kds__empty">
            <div className="kds__empty-check">✓</div>
            <div className="kds__empty-title">All caught up</div>
            <div className="kds__empty-sub">No open orders right now</div>
          </div>
        ) : fastMode ? (
          /* Fast Mode — aggregated, VIEW-ONLY. No tap targets: orders are
             completed via the normal ticket view. */
          <div className="kds-fast">
            {fastLines.map((line) => (
              <FastLine key={line.key} line={line} nowMs={nowMs} />
            ))}
          </div>
        ) : (
          orders.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              nowMs={nowMs}
              busy={patchingIds.has(order.id)}
              failed={failedIds.has(order.id)}
              onAdvance={() => advanceOrder(order)}
            />
          ))
        )}
      </main>

      {/* Undo toast — appears after advancing an order, auto-dismisses */}
      {undoAction && (
        <div className="kds-undo">
          <span className="kds-undo__text">
            #{undoAction.orderNumber} moved to {undoAction.previousStatus === "open" ? "In Progress" : "Ready"}
          </span>
          <button className="kds-undo__btn" onClick={performUndo}>
            Undo
          </button>
          <button className="kds-undo__dismiss" onClick={clearUndo} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {/* Device-paired indicator — non-interactive, informational only.
          Pairing system not built yet; shows a sensible default state.
          Trivially wirable to real pairing status later. */}
      <div className="kds__device-indicator" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.55a11 11 0 0 1 14.08 0" />
          <path d="M1.42 9a16 16 0 0 1 21.16 0" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <circle cx="12" cy="20" r="1" fill="currentColor" />
        </svg>
        <span>KDS Active</span>
      </div>

      {pastOpen && (
        <PastOrdersOverlay onClose={() => setPastOpen(false)} onReverted={fetchOrders} />
      )}
    </div>
  );
}

function OrderCard({ order, nowMs, busy, failed, onAdvance }) {
  const sec = elapsedSeconds(order.created_at, nowMs);
  const tier = elapsedTier(sec);

  const handleKey = (e) => {
    if ((e.key === "Enter" || e.key === " ") && !busy) {
      e.preventDefault();
      onAdvance();
    }
  };

  return (
    <div
      className={`kds-card kds-card--t-${tier}${
        busy ? " kds-card--busy" : ""
      }${failed ? " kds-card--failed" : ""}`}
      role="button"
      tabIndex={0}
      aria-disabled={busy}
      onClick={busy ? undefined : onAdvance}
      onKeyDown={handleKey}
    >
      <div className="kds-card__top">
        <span className="kds-card__number">#{order.order_number}</span>
        <div className="kds-card__meta">
          <span className={`kds-card__timer kds-card__timer--${tier}`}>
            {formatMMSS(sec)}
          </span>
          <span className={`kds-card__status kds-card__status--${order.status}`}>
            {STATUS_LABEL[order.status] || order.status}
          </span>
        </div>
      </div>

      <div className="kds-card__items">
        {order.items.map((item) => (
          <ItemBlock key={item.id} item={item} />
        ))}
      </div>

      <div className={`kds-card__cta kds-card__cta--${order.status}`}>
        {busy ? (
          "SENDING…"
        ) : failed ? (
          "UPDATE FAILED · TAP TO RETRY"
        ) : (
          <>
            <CtaIcon status={order.status} />
            <span>{TAP_HINT[order.status] || ""}</span>
          </>
        )}
      </div>
    </div>
  );
}

// Workflow-stage icon for the CTA — reinforces the stage distinction without
// relying on color alone (a cook glancing at a tray of cards, or anyone with
// color-vision deficiency, still gets the signal).
function CtaIcon({ status }) {
  if (status === "preparing") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <polygon points="6 3 20 12 6 21 6 3"></polygon>
    </svg>
  );
}

// One aggregated Fast Mode line: exact make-spec + how many are needed.
// View-only by design — no click handler, no role=button.
function FastLine({ line, nowMs }) {
  const it = line.sample;
  const tier = elapsedTier(elapsedSeconds(line.oldestCreatedAt, nowMs));
  const parts = [];
  for (const opt of it.selected_options || []) parts.push(opt.choice);
  for (const name of it.removed_ingredients || []) parts.push(`no ${name}`);
  for (const m of it.added_modifiers || [])
    parts.push(m.quantity > 1 ? `${m.name} x${m.quantity}` : m.name);

  return (
    <div className={`kds-fast-line kds-fast-line--t-${tier}`}>
      <span className={`kds-fast-line__count kds-fast-line__count--${tier}`}>
        ×{line.count}
      </span>
      <div className="kds-fast-line__what">
        <span className="kds-fast-line__name">
          {it.name}
          {it.variant && <span className="kds-fast-line__variant"> · {it.variant}</span>}
        </span>
        {parts.length > 0 && (
          <span className="kds-fast-line__mods">
            {parts.map((p, i) => (
              <span
                key={i}
                className={`kds-fast-line__mod${
                  p.startsWith("no ") ? " kds-fast-line__mod--removed" : ""
                }`}
              >
                {p}
              </span>
            ))}
          </span>
        )}
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

// ---- Completed Orders (history, with single-level undo) ----
function PastOrdersOverlay({ onClose, onReverted }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null); // selected completed order
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState(null);
  // Brief confirmation after a successful undo — no action needed, just
  // reassurance the order actually moved back to the active queue.
  const [confirmToast, setConfirmToast] = useState(null); // { orderNumber }
  const confirmTimer = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/orders/history?sinceHours=${HISTORY_SINCE_HOURS}`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setRows(data); // backend returns most-recent-first — preserve
          setError(null);
        }
      } catch {
        if (!cancelled) setError("Couldn't load completed orders.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  const openDetail = useCallback((order) => {
    setUndoError(null);
    setDetail(order);
  }, []);

  // Same revert mechanism as the main queue's undo toast
  // (PATCH /api/orders/:id/status/revert) — one step back, ready→preparing.
  const handleUndo = useCallback(
    async (order) => {
      setUndoBusy(true);
      setUndoError(null);
      try {
        const res = await fetch(`${API_URL}/api/orders/${order.id}/status/revert`, {
          method: "PATCH",
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        setRows((prev) => prev.filter((r) => r.id !== order.id));
        setDetail(null);
        onReverted?.();

        setConfirmToast({ orderNumber: order.order_number });
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        confirmTimer.current = setTimeout(() => setConfirmToast(null), 4000);
      } catch (err) {
        setUndoError(err.message || "Failed to undo");
      } finally {
        setUndoBusy(false);
      }
    },
    [onReverted]
  );

  return (
    <div className="kds-past">
      <header className="kds-past__header">
        <button className="kds-past__back" onClick={onClose}>
          ‹ Back to Queue
        </button>
        <h2 className="kds-past__title">Completed Orders</h2>
        <span className="kds-past__sub">last {HISTORY_SINCE_HOURS}h</span>
      </header>

      <div className="kds-past__body">
        {loading ? (
          <div className="kds__empty">Loading…</div>
        ) : error ? (
          <div className="kds__empty">{error}</div>
        ) : rows.length === 0 ? (
          <div className="kds__empty">
            <div className="kds__empty-title">No completed orders</div>
            <div className="kds__empty-sub">in the last {HISTORY_SINCE_HOURS} hours</div>
          </div>
        ) : (
          <ul className="kds-past__list">
            <li className="kds-past-row kds-past-row--head" aria-hidden="true">
              <span className="kds-past-row__num">Order</span>
              <span className="kds-past-row__time">Completed</span>
              <span className="kds-past-row__prep">Prep time</span>
              <span className="kds-past-row__chev" />
            </li>
            {rows.map((o) => (
              <li key={o.id}>
                <button className="kds-past-row" onClick={() => openDetail(o)}>
                  <span className="kds-past-row__num">#{o.order_number}</span>
                  <span className="kds-past-row__time">{formatClock(o.completed_at)}</span>
                  <span className="kds-past-row__prep">
                    {formatDuration(o.created_at, o.completed_at)}
                  </span>
                  <span className="kds-past-row__chev">›</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {detail && (
        <PastOrderDetail
          order={detail}
          onClose={() => setDetail(null)}
          onUndo={() => handleUndo(detail)}
          undoBusy={undoBusy}
          undoError={undoError}
        />
      )}

      {confirmToast && (
        <div className="kds-past-confirm">
          Order #{confirmToast.orderNumber} returned to the active queue
        </div>
      )}
    </div>
  );
}

function PastOrderDetail({ order, onClose, onUndo, undoBusy, undoError }) {
  return (
    <div className="kds-detail-overlay" onClick={onClose}>
      <div className="kds-detail" onClick={(e) => e.stopPropagation()}>
        <div className="kds-detail__top">
          <span className="kds-detail__num">#{order.order_number}</span>
          <button className="kds-detail__close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="kds-detail__meta">
          <span className="kds-detail__meta-item">Completed {formatClock(order.completed_at)}</span>
          <span className="kds-detail__prep">
            Prep {formatDuration(order.created_at, order.completed_at)}
          </span>
        </div>

        <div className="kds-detail__items">
          {order.items.map((item) => (
            <ItemBlock key={item.id} item={item} />
          ))}
        </div>

        <div className="kds-detail__actions">
          {undoError && <div className="kds-detail__undo-error">{undoError}</div>}
          <button
            className="kds-detail__undo-btn"
            onClick={onUndo}
            disabled={undoBusy}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7v6h6" />
              <path d="M21 17a9 9 0 1 0-2.64-6.36L3 13" />
            </svg>
            {undoBusy ? "Reverting…" : "Undo — Return to Active Queue"}
          </button>
        </div>
      </div>
    </div>
  );
}
