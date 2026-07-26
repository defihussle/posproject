-- ============================================================
-- Refunds & Voids — audit ledger + money-model link
-- ------------------------------------------------------------
-- Adds the record layer behind the Refund/Void feature. The MONEY itself
-- continues to live in the existing `payments` table: every reversal writes a
-- NEW negative payments row (status='refunded', amount = −refunded), so
-- SUM(payments.amount) over settled rows (captured + refunded) is net collected
-- by construction — one predicate (settledPaymentsWhere) keeps every report
-- reconciling. This migration adds:
--
--   1. order_refunds       — one row per reversal: type (void|refund), amount,
--                             reason (+ note), who requested + who approved
--                             (dual-control), a mock/async status, and the
--                             forward-looking Stripe fields (stripe_refund_id,
--                             processor_status) so a webhook can confirm later.
--   2. order_refund_items  — optional line-item detail (empty for full/amount
--                             refunds); used by the line-item refund path.
--   3. payments.refund_id  — links each negative money row to its audit record
--                             (NULL on the original capture).
--
-- Style matches modifier_management_and_discounts.sql: TEXT + CHECK for the
-- small fixed sets (idempotent, re-runnable), not new ENUM types. Run on prod
-- BEFORE deploying the code that reads these (standing deploy-order rule).
-- ============================================================

-- 1. Link column on payments (FK added after order_refunds exists, below).
ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS refund_id UUID;

-- 2. Audit + processor layer.
CREATE TABLE IF NOT EXISTS order_refunds (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id         UUID NOT NULL REFERENCES orders(id),
    type             TEXT NOT NULL,                       -- 'void' | 'refund'
    amount           NUMERIC(10,2) NOT NULL,              -- positive magnitude returned
    tax_amount       NUMERIC(10,2) NOT NULL DEFAULT 0,    -- tax portion of amount
    reason           TEXT NOT NULL,                       -- fixed set (CHECK below)
    reason_note      TEXT,                                -- required when reason='other'
    requested_by     UUID NOT NULL REFERENCES staff(id),  -- initiator (cashier/owner/admin)
    approved_by      UUID NOT NULL REFERENCES staff(id),  -- dual-control approver (manager+)
    status           TEXT NOT NULL DEFAULT 'completed',   -- 'pending'|'completed'|'failed'
    stripe_refund_id TEXT,                                -- processor ref, set by Stripe later
    processor_status TEXT,                                -- raw webhook status, set later
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Optional line-item detail.
CREATE TABLE IF NOT EXISTS order_refund_items (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    refund_id      UUID NOT NULL REFERENCES order_refunds(id) ON DELETE CASCADE,
    order_item_id  UUID NOT NULL REFERENCES order_items(id),
    quantity       INTEGER NOT NULL,
    amount         NUMERIC(10,2) NOT NULL
);

-- 4. payments.refund_id FK + CHECK constraints (idempotent, DO-guarded).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_refund_id_fkey') THEN
        ALTER TABLE payments
            ADD CONSTRAINT payments_refund_id_fkey
            FOREIGN KEY (refund_id) REFERENCES order_refunds(id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_refunds_type_check') THEN
        ALTER TABLE order_refunds ADD CONSTRAINT order_refunds_type_check
            CHECK (type IN ('void', 'refund'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_refunds_reason_check') THEN
        ALTER TABLE order_refunds ADD CONSTRAINT order_refunds_reason_check
            CHECK (reason IN ('wrong_order', 'kitchen_error', 'quality_issue',
                              'customer_cancelled', 'overcharge', 'duplicate', 'other'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_refunds_status_check') THEN
        ALTER TABLE order_refunds ADD CONSTRAINT order_refunds_status_check
            CHECK (status IN ('pending', 'completed', 'failed'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_refunds_amount_check') THEN
        ALTER TABLE order_refunds ADD CONSTRAINT order_refunds_amount_check
            CHECK (amount > 0);
    END IF;

    -- Free-text note is mandatory only for the catch-all 'other' reason.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_refunds_reason_note_check') THEN
        ALTER TABLE order_refunds ADD CONSTRAINT order_refunds_reason_note_check
            CHECK (reason <> 'other' OR (reason_note IS NOT NULL AND length(trim(reason_note)) > 0));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_refund_items_quantity_check') THEN
        ALTER TABLE order_refund_items ADD CONSTRAINT order_refund_items_quantity_check
            CHECK (quantity > 0);
    END IF;
END $$;

-- 5. Indexes for the report/lookup paths.
CREATE INDEX IF NOT EXISTS idx_order_refunds_order_id   ON order_refunds(order_id);
CREATE INDEX IF NOT EXISTS idx_order_refunds_created_at ON order_refunds(created_at);
CREATE INDEX IF NOT EXISTS idx_order_refund_items_refund ON order_refund_items(refund_id);
CREATE INDEX IF NOT EXISTS idx_payments_refund_id       ON payments(refund_id);
