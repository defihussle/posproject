-- Refunds Slice 5 — KDS voided-ticket handling.
--
-- A void sets orders.status = 'cancelled', which erases the sale but also
-- erases the only record of how far the order had got. The KDS needs two facts
-- the current schema can't answer:
--
--   1. Was this order ever FIRED to the kitchen? A void of an 'open' order
--      never reached the line and needs no ticket; a void of a 'preparing' or
--      'ready' order means someone is cooking food nobody is paying for, and
--      the board must interrupt them.
--   2. Has the kitchen ACKNOWLEDGED the void? Voided tickets are dismissed by
--      hand (never auto-cleared on a timer), so the acknowledgement has to
--      survive a page reload and be shared across every KDS device.
--
-- Both are recorded on `orders` rather than `order_refunds` because they are
-- properties of the ORDER's kitchen lifecycle, not of the money reversal — and
-- because the KDS poll filters on them, which would otherwise force a join on
-- the hottest query in the app.
--
-- Run against prod BEFORE deploying the dependent code (standing deploy-order
-- rule — the is_upsell lesson).

-- The status the order held immediately before it was voided. NULL for every
-- order that has never been voided. 'open' => never fired, no KDS ticket.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS voided_from_status order_status;

-- When kitchen staff dismissed the VOIDED ticket from the board. NULL while it
-- is still demanding acknowledgement; set => it moves to the history view,
-- still marked as voided.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS void_acknowledged_at TIMESTAMPTZ;

COMMENT ON COLUMN orders.voided_from_status IS
  'Status held immediately before a void; NULL if never voided. open = never reached the kitchen.';
COMMENT ON COLUMN orders.void_acknowledged_at IS
  'When kitchen staff dismissed the VOIDED ticket from the KDS board; NULL = still on the board.';

-- The KDS board polls for unacknowledged voided tickets every 5s. Partial index
-- so it stays a tiny lookup no matter how many cancelled orders accumulate.
CREATE INDEX IF NOT EXISTS idx_orders_unacked_voids
  ON orders (location_id, created_at)
  WHERE status = 'cancelled' AND void_acknowledged_at IS NULL;
