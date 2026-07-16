-- ============================================================
-- Modifier group management + checkout discounts
-- ------------------------------------------------------------
-- 1. modifier_groups gets an `active` flag, matching the soft-delete
--    pattern already used everywhere else (menu_items, item_variants,
--    modifier_options already had one) — needed so a group referenced by
--    order history can be deactivated instead of hard-deleted.
--
-- 2. orders gets three new columns for the discount feature:
--      discount_percent     — the % applied (0-100), NULL = no discount
--      discount_reason      — one of a fixed set of categories, enforced
--                              by CHECK; required whenever percent is set
--      discount_applied_by  — which staff member applied it
--    The DOLLAR amount of the discount continues to use the EXISTING
--    orders.discount column (already present in schema.sql, previously
--    unused/always 0) — no need for a second amount column.
--
--    NOTE on tips: orders.tip already exists too (also previously unused/
--    always 0). The "tip readiness" work reuses that existing column for
--    the Home dashboard's Total Tips stat — no new tip column was added.
-- ============================================================

ALTER TABLE modifier_groups
    ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS discount_reason TEXT,
    ADD COLUMN IF NOT EXISTS discount_applied_by UUID REFERENCES staff(id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'orders_discount_reason_check'
    ) THEN
        ALTER TABLE orders
            ADD CONSTRAINT orders_discount_reason_check
            CHECK (discount_reason IS NULL OR discount_reason IN
                ('family', 'friend', 'employee', 'neighbouring_store'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'orders_discount_percent_check'
    ) THEN
        ALTER TABLE orders
            ADD CONSTRAINT orders_discount_percent_check
            CHECK (discount_percent IS NULL OR (discount_percent > 0 AND discount_percent <= 100));
    END IF;
END $$;
