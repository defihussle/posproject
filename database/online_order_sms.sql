-- ============================================================
-- Online pickup SMS - notification log (schema only)
-- ------------------------------------------------------------
-- Slice 1 of docs/architecture/online-pickup-sms-plan.md. This file ONLY adds
-- a table. It adds no route, sends nothing, and changes no existing table.
-- Applying it changes nothing staff or customers can see.
--
-- WHAT IT IS FOR
-- The POS (not the website, not Flex / Cloud Pay Display) will text the
-- customer of an ONLINE pickup order at three moments:
--   placed  - a NEW ticket inserted by POST /api/online-orders
--             (never the idempotent replay or the 409 race)
--   started - KDS tap open -> preparing  (PATCH /api/orders/:id/status)
--   ready   - KDS tap preparing -> ready (same route)
-- The revert route never texts.
--
-- WHY UNIQUE (order_id, event)
-- The row is claimed with INSERT ... ON CONFLICT DO NOTHING before any send.
-- That one constraint is what stops a double text across ingest retries,
-- a KDS double tap, and revert-then-advance (ready -> preparing -> ready
-- finds the 'ready' row already there and sends nothing).
--
-- NO AUTOMATIC RETRY IN V1
-- A failed send stays 'failed'. Nothing re-sends it: a late "ready" text that
-- arrives after the customer has already collected is worse than none.
--
-- NOTE ON THE SCHEMA GUARD
-- `npm run schema:sync` adds this table to backend/schema-requirements.json.
-- From then on the Render pre-deploy check and the server boot check REFUSE to
-- run until the table exists. Apply this file to PRODUCTION before pushing the
-- manifest or any code that reads the table. See the Schema Change Checklist
-- in CLAUDE.md.
--
-- Re-runnable: every statement is IF NOT EXISTS or catalog-guarded.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

CREATE TABLE IF NOT EXISTS order_notifications (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    event         TEXT NOT NULL,
    -- Normalized E.164 (+1XXXXXXXXXX). NULL when the order had no usable
    -- phone and the row records a 'skipped' outcome.
    to_phone      TEXT,
    status        TEXT NOT NULL,
    -- Provider message id (Twilio SM...) once a send is accepted.
    provider_sid  TEXT,
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Named constraints added through catalog lookups so this file stays
-- re-runnable (ADD CONSTRAINT has no IF NOT EXISTS).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'order_notifications_event_check'
           AND conrelid = 'order_notifications'::regclass
    ) THEN
        ALTER TABLE order_notifications
            ADD CONSTRAINT order_notifications_event_check
            CHECK (event IN ('placed', 'started', 'ready'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'order_notifications_status_check'
           AND conrelid = 'order_notifications'::regclass
    ) THEN
        ALTER TABLE order_notifications
            ADD CONSTRAINT order_notifications_status_check
            CHECK (status IN ('queued', 'sent', 'failed', 'skipped'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'order_notifications_order_event_key'
           AND conrelid = 'order_notifications'::regclass
    ) THEN
        ALTER TABLE order_notifications
            ADD CONSTRAINT order_notifications_order_event_key
            UNIQUE (order_id, event);
    END IF;
END $$;

-- For "what did we text today" reads.
CREATE INDEX IF NOT EXISTS idx_order_notifications_created_at
    ON order_notifications (created_at DESC);

COMMENT ON TABLE order_notifications IS
    'POS-owned online pickup SMS log. One row per (order, event): placed, '
    'started, ready. The UNIQUE (order_id, event) claim prevents double texts. '
    'No automatic retry in v1.';
