import { useState, useEffect, useCallback, useMemo } from "react";
import { API_URL } from "../config";
import {
  POLL_MS,
  elapsedSeconds,
  formatMMSS,
  elapsedTier,
  aggregateRushLines,
  voidedFirst,
} from "./kdsBoard";
import "./LiveOrders.css";

/**
 * Back Office → Orders → Live Orders.
 *
 * A read-only mirror of the KDS board for owners on a phone. Every rule that
 * decides what a ticket looks like — FIFO order, voided-first, elapsed tiers,
 * Rush Hour grouping — is imported from kdsBoard.js, the same module the KDS
 * itself now uses, so the two screens can't drift apart.
 *
 * READ-ONLY BY CONSTRUCTION, not by hiding buttons: this component renders no
 * interactive ticket controls and calls exactly one endpoint, a GET. The
 * status-advance, revert, void-acknowledge and refund routes are never
 * imported or referenced here. Advancing a ticket stays the kitchen's job at
 * the pass, where whoever taps it can see the food.
 *
 * Visually this is a Back Office surface, not a KDS one: the warm palette and
 * Inter type scoped under .backoffice, phone-first, no brand red. The KDS's
 * green/amber/red lateness cues are the one thing carried over, because
 * "this ticket is late" is the whole point of glancing at it.
 */

const STATUS_LABEL = { open: "Open", preparing: "Preparing" };

export default function LiveOrders() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Ticks once a second so the elapsed timers move smoothly between polls,
  // exactly as they do on the KDS.
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Rush Hour here is this screen's OWN toggle. The KDS's switch is local
  // React state on that tablet and is never sent anywhere, so no other device
  // can read it — see the note in the report. The grouping logic is identical.
  const [rushHour, setRushHour] = useState(false);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/backoffice/orders/live`, {
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // Backend already sorts FIFO; voidedFirst only lifts the interrupts.
      setOrders(voidedFirst(data));
      setError(null);
    } catch (err) {
      // Keep the last good board on screen — a dropped poll on a phone with
      // patchy signal shouldn't blank the page.
      setError(err.message || "Connection issue — retrying…");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOrders();
    const id = setInterval(fetchOrders, POLL_MS);
    return () => clearInterval(id);
  }, [fetchOrders]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const rushLines = useMemo(() => aggregateRushLines(orders), [orders]);
  const voided = useMemo(() => orders.filter((o) => o.voided), [orders]);
  const liveCount = orders.filter((o) => !o.voided).length;

  if (loading) return <div className="liveorders__notice">Loading live orders…</div>;

  return (
    <div className="liveorders">
      <div className="liveorders__head">
        <h2 className="liveorders__title">Live Orders</h2>
        <label className="liveorders__rush">
          <span>Rush Hour</span>
          <input
            type="checkbox"
            checked={rushHour}
            onChange={(e) => setRushHour(e.target.checked)}
          />
          <span className="liveorders__switch" aria-hidden="true" />
        </label>
      </div>

      <div className="liveorders__meta">
        <span className="bo-pill bo-pill--neutral">
          {liveCount} {liveCount === 1 ? "ticket" : "tickets"} on the line
        </span>
        <span className="liveorders__readonly">View only — advance tickets on the KDS</span>
      </div>

      {error && <div className="liveorders__error">{error}</div>}

      {/* Voided tickets render above everything in BOTH views, same as the
          KDS: "stop making this" can't wait for a view switch. They are never
          folded into a Rush Hour make-line. */}
      {voided.map((o) => (
        <div key={o.id} className="liveorders-card liveorders-card--voided">
          <div className="liveorders-card__top">
            <span className="liveorders-card__number">#{o.order_number}</span>
            <span className="bo-pill bo-pill--negative">Voided</span>
          </div>
          <p className="liveorders-card__voidnote">
            {o.voided_from_status === "ready"
              ? "Was ready — kitchen still to pull it from the pass."
              : "Was in progress — kitchen still to stop and discard."}
          </p>
          <ItemLines items={o.items} />
        </div>
      ))}

      {orders.length === 0 ? (
        <div className="liveorders__empty">
          Nothing on the line right now. New orders appear here within a few seconds.
        </div>
      ) : rushHour ? (
        <div className="liveorders__lines">
          {rushLines.map((line) => {
            const tier = elapsedTier(elapsedSeconds(line.oldestCreatedAt, nowMs));
            return (
              <div key={line.key} className={`liveorders-line liveorders-line--${tier}`}>
                <span className="liveorders-line__count">{line.count}×</span>
                <span className="liveorders-line__body">
                  <span className="liveorders-line__name">{line.sample.name}</span>
                  {line.sample.variant && (
                    <span className="liveorders-line__variant">{line.sample.variant}</span>
                  )}
                  <ModifierNote item={line.sample} />
                </span>
                <span className="liveorders-line__age">
                  {formatMMSS(elapsedSeconds(line.oldestCreatedAt, nowMs))}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="liveorders__list">
          {orders
            .filter((o) => !o.voided)
            .map((o) => {
              const secs = elapsedSeconds(o.created_at, nowMs);
              const tier = elapsedTier(secs);
              return (
                <div key={o.id} className={`liveorders-card liveorders-card--${tier}`}>
                  <div className="liveorders-card__top">
                    <span className="liveorders-card__number">#{o.order_number}</span>
                    <span
                      className={`bo-pill ${
                        o.status === "preparing" ? "bo-pill--warn" : "bo-pill--neutral"
                      }`}
                    >
                      {STATUS_LABEL[o.status] || o.status}
                    </span>
                    <span className={`liveorders-card__age liveorders-card__age--${tier}`}>
                      {formatMMSS(secs)}
                    </span>
                  </div>
                  <ItemLines items={o.items} />
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

// The ticket's contents, kept to what reads at a glance on a phone: quantity,
// item, variant, and a one-line modifier summary. The full per-item detail
// (every added option, every removed ingredient) stays on the KDS, where the
// person acting on it is standing.
function ItemLines({ items }) {
  return (
    <ul className="liveorders-card__items">
      {items.map((it) => (
        <li key={it.id} className="liveorders-card__item">
          <span className="liveorders-card__qty">{it.quantity}×</span>
          <span className="liveorders-card__itembody">
            <span className="liveorders-card__itemname">{it.name}</span>
            {it.variant && <span className="liveorders-card__variant">{it.variant}</span>}
            <ModifierNote item={it} />
          </span>
        </li>
      ))}
    </ul>
  );
}

// Required-group choices, additions, removals and add-ons collapsed into one
// muted line. Removals are prefixed "NO" exactly as the KDS and the receipt
// render them, so the same ticket reads the same wherever an owner sees it.
// Required choices lead because they say what the item IS (the protein on a
// bowl), not what was done to it.
function ModifierNote({ item }) {
  const parts = [
    ...(item.selected_options || []).map((s) => s.choice),
    ...(item.added_modifiers || []).map((m) => (m.quantity > 1 ? `${m.name} ×${m.quantity}` : m.name)),
    ...(item.removed_ingredients || []).map((r) => `NO ${r}`),
    ...(item.addons || []).map((a) => a.name),
  ];
  if (parts.length === 0) return null;
  return <span className="liveorders-card__mods">{parts.join(" · ")}</span>;
}
