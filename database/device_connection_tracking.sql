-- ============================================================
-- device_pairings — per-surface activity timestamps
-- ------------------------------------------------------------
-- last_seen_at already records "this device made SOME gated request."
-- These two split that by surface so Back Office can show what a device is
-- connected to (Order Entry, KDS, or both). requireDevicePairing stamps
-- the matching column on every gated request, classified by route:
--   - Order Entry: POST /api/auth/login, POST /api/orders
--   - KDS:         GET /api/orders, GET /api/orders/history,
--                  PATCH /api/orders/:id/status[/revert]
-- A non-NULL value means the device has been used on that surface; for the
-- dedicated tablets this POS runs on, that maps exactly to its role.
-- ============================================================

ALTER TABLE device_pairings
  ADD COLUMN IF NOT EXISTS last_order_entry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_kds_at         TIMESTAMPTZ;
