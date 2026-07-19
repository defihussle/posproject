-- ============================================================
-- shift_breaks — multiple breaks per shift (clock in/out v2)
-- ------------------------------------------------------------
-- One row per break; break_end IS NULL means the break is still open.
-- No limit on breaks per shift. FK to shifts follows the same style as
-- shifts' own FKs (no explicit ON DELETE — shifts are never hard-deleted
-- in this app, same "deactivate only" spirit as staff).
-- ============================================================

CREATE TABLE IF NOT EXISTS shift_breaks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shift_id    UUID NOT NULL REFERENCES shifts(id),
    break_start TIMESTAMPTZ NOT NULL DEFAULT now(),
    break_end   TIMESTAMPTZ
);

-- Every clock action queries "is there an open break for this shift" —
-- worth an index given how frequently it's hit.
CREATE INDEX IF NOT EXISTS idx_shift_breaks_shift_id ON shift_breaks(shift_id);
