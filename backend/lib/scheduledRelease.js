// Scheduled pickup release rule for the live kitchen board.
//
// An online order for a later pickup slot is held off the live board (KDS and
// Back Office Live Orders, both via loadLiveBoard in server.js) until
// SCHEDULE_LEAD_MINUTES before its pickup_at, or until the kitchen taps
// "Fire now" (orders.released_at, database/scheduled_pickup_release.sql).
// pickup_at itself is never moved: it is the guest's slot.
//
// Only 'open' tickets are ever held. Anything already started, ready or
// voided is on the board by other rules and stays there.

const SCHEDULE_LEAD_MINUTES = 20;

// SQL predicate over an orders row (alias-free column names): true when an
// open ticket may be on the live board. Keep in step with isReleased() below.
const RELEASED_SQL = `(pickup_at IS NULL
      OR released_at IS NOT NULL
      OR pickup_at <= now() + interval '${SCHEDULE_LEAD_MINUTES} minutes')`;

/** When a held ticket goes live by itself, or null if it is never held. */
function releaseAt(pickupAt) {
  if (!pickupAt) return null;
  const t = new Date(pickupAt).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t - SCHEDULE_LEAD_MINUTES * 60000);
}

/** JS mirror of RELEASED_SQL for an open ticket. */
function isReleased({ pickup_at: pickupAt, released_at: releasedAt }, now = new Date()) {
  if (releasedAt) return true;
  const at = releaseAt(pickupAt);
  return at === null || at.getTime() <= now.getTime();
}

module.exports = { SCHEDULE_LEAD_MINUTES, RELEASED_SQL, releaseAt, isReleased };
