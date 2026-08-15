// ============================================================
// Shared live-board logic — the KDS and Back Office → Orders → Live Orders
// both render the same kitchen queue, so the rules that decide what a ticket
// looks like live here rather than in either component.
//
// Everything in this file is PURE: no fetching, no React, no DOM. The KDS owns
// the board's interactions (tap-to-advance, void acknowledgement, sounds) and
// Live Orders is read-only, but "how old is this ticket", "is it late", and
// "how do these lines aggregate under Rush Hour" must be answered identically
// on both screens — an owner checking their phone should never see a different
// board from the one the kitchen is working off.
//
// Extracted verbatim from KitchenDisplay.jsx; the KDS now imports it.
// ============================================================

// Poll cadence and the status filter the live board asks for. 'cancelled'
// pulls VOIDED tickets in — the backend narrows those to voids the kitchen was
// already cooking and hasn't acknowledged yet.
export const POLL_MS = 5000;
export const KDS_STATUSES = "open,preparing,cancelled";

// --- Elapsed-time escalation thresholds (minutes) — tune here as needed ---
export const ELAPSED_YELLOW_MIN = 5; // green → yellow at/after this many minutes
export const ELAPSED_RED_MIN = 10; //   yellow → red at/after this many minutes

// ---- Time helpers ----
export function elapsedSeconds(iso, nowMs) {
  return Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 1000));
}

// "4:32" (M:SS, minutes uncapped so a 72-minute order still reads correctly)
export function formatMMSS(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function elapsedTier(totalSec) {
  const min = totalSec / 60;
  if (min >= ELAPSED_RED_MIN) return "red";
  if (min >= ELAPSED_YELLOW_MIN) return "yellow";
  return "green";
}

// ---- Rush Hour make-line priority ----
// Highest-value / longest-lead work first, so the line fires in the order the
// kitchen actually wants during a rush.
//
// Matched on the item NAME because the KDS payload carries `name` and
// `variant` but no category (see fetchKdsOrders in server.js) — adding a
// category to that query would mean changing an endpoint the board depends on,
// for a distinction the names already make. The live menu names are
// unambiguous here: every taco says "taco", every burrito "burrito", every
// bowl "bowl", and so on (see database/menu_restructure.sql, which renamed
// these to "<Protein> Burrito", "<Protein> Bowl", "<Protein> Quesadilla").
//
// Order matters: the birria test runs first, otherwise "Birria Tacos (3pc)"
// would match the generic taco rule. It requires BOTH words so a hypothetical
// "Birria Bowl" still sorts as a bowl rather than jumping to the front.
const RUSH_PRIORITY_TESTS = [
  (n) => n.includes("birria") && n.includes("taco"), // 1 — best seller, leads the tacos
  (n) => n.includes("taco"), // 2 — every other taco
  (n) => n.includes("burrito"), // 3
  (n) => n.includes("bowl"), // 4
  (n) => n.includes("quesadilla"), // 5
  (n) => n.includes("fries"), // 6 — "Fries Supreme" and "Seasoned Fries" alike
];
// Sides, desserts, drinks, nachos, elotes — keep their existing relative order,
// which the count/age tiebreakers below already decide.
const RUSH_PRIORITY_OTHER = RUSH_PRIORITY_TESTS.length + 1;

export function rushPriority(itemName) {
  const n = (itemName || "").toLowerCase();
  const i = RUSH_PRIORITY_TESTS.findIndex((test) => test(n));
  return i === -1 ? RUSH_PRIORITY_OTHER : i + 1;
}

// Rush Hour aggregation — pure client-side reshaping of the SAME polled
// order data (open/preparing only, no extra fetching). Two lines merge only
// when item_id + variant_id + the FULL modifier set (option ids AND
// quantities) match exactly; any difference is a separate line, because the
// cook needs to see exactly what to make.
export function aggregateRushLines(orders) {
  const map = new Map();
  for (const order of orders) {
    // Voided tickets are never aggregated into a make-line — that would tell
    // the cook to produce food that has just been cancelled. They stay
    // visible as their own banner above the Rush Hour view instead.
    if (order.voided) continue;
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
  // Station priority first, then busiest, then oldest. Priority is the outer
  // key on purpose: during a rush the point of this view is to fire the
  // highest-value work first, and a big pile of drinks shouldn't outrank a
  // single birria order just because it aggregated to a larger count. The
  // two previous keys are unchanged and still break ties within a tier.
  return [...map.values()].sort(
    (a, b) =>
      rushPriority(a.sample.name) - rushPriority(b.sample.name) ||
      b.count - a.count ||
      new Date(a.oldestCreatedAt) - new Date(b.oldestCreatedAt)
  );
}

// Voided tickets jump to the front of the board regardless of FIFO age — they
// are an interrupt ("stop cooking this"), not a queue entry. Stable within
// each group, so live tickets keep the backend's FIFO order.
export function voidedFirst(orders) {
  return [...orders.filter((o) => o.voided), ...orders.filter((o) => !o.voided)];
}
