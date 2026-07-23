-- ============================================================
-- payroll_status — per-staff, per-week "Paid / Unpaid" marker
-- ------------------------------------------------------------
-- Backs the Back Office → Payroll page's Mark-as-Paid toggle. One row per
-- (staff member, pay week), where week_start is the Monday of that week in
-- the location's timezone. Hours and gross pay are NOT stored here — they're
-- recomputed live from shifts/shift_breaks each time the page loads (v1
-- decision: no amount snapshot). This table only records whether a given
-- staffer's week has been paid, plus a light audit (who/when).
--
-- Upserted on Save via ON CONFLICT (staff_id, week_start); paid_at/paid_by
-- are set when paid flips true and cleared when it flips back to false.
-- ============================================================

CREATE TABLE IF NOT EXISTS payroll_status (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID NOT NULL REFERENCES locations(id),
    staff_id    UUID NOT NULL REFERENCES staff(id),
    week_start  DATE NOT NULL,                 -- Monday of the pay week (location tz)
    paid        BOOLEAN NOT NULL DEFAULT false,
    paid_at     TIMESTAMPTZ,
    paid_by     UUID REFERENCES staff(id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (staff_id, week_start)
);

-- Payroll always loads a full week at once, keyed by week_start.
CREATE INDEX IF NOT EXISTS idx_payroll_status_week ON payroll_status(week_start);
