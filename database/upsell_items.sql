-- ============================================================
-- menu_items.is_upsell — flags an item as a post-checkout upsell
-- ------------------------------------------------------------
-- After the cashier hits Checkout (but before the payment screen),
-- Order Entry shows a single upsell prompt ("Would you like some guac
-- with your order?"). Only items flagged here are eligible. For now the
-- modal uses the first eligible item; later this can drive multiple /
-- randomized upsells without a schema change.
--
-- Default off for every item. Guacamole is seeded on so the feature has
-- a working default out of the box; owners toggle others from Menu
-- Management. Name-based UPDATE (not a hard-coded id) so this applies
-- cleanly across environments that were seeded independently.
-- ============================================================

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS is_upsell BOOLEAN NOT NULL DEFAULT false;

UPDATE menu_items SET is_upsell = true WHERE name = 'Guacamole';
