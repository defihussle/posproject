-- ============================================================
-- Stripe Terminal — schema foundations (Slice 0.2)
-- ------------------------------------------------------------
-- Implements the Schema section of docs/architecture/stripe-terminal-plan.md.
-- Schema ONLY: no application code depends on any of this yet, and
-- PAYMENTS_PROVIDER stays 'mock', so applying this migration changes nothing
-- staff can see. That is deliberate — the standing deploy-order rule in
-- CLAUDE.md wants the schema in place BEFORE the code that reads it.
--
-- Everything here is additive and nullable, and there are NO new enum values
-- (plan decision D6): the schema guard does not check enum members
-- (docs/architecture/schema-guard.md), so an ALTER TYPE would ship with no
-- backstop — precisely the is_upsell failure class. Interac vs. credit is
-- therefore recorded in a TEXT + CHECK column, not a new payment_method
-- member, and the existing payment_method / payment_status / order_status
-- enums are untouched.
--
-- What this adds:
--
--   1. pending_checkouts — the priced cart held between PaymentIntent creation
--      and webhook settlement. This is the heart of plan decision D1
--      ("Option B"): the real orders + payments rows are inserted ONLY when
--      the success webhook arrives, so a declined or abandoned checkout leaves
--      no order row anywhere — nothing on the KDS, nothing in pos-recall, and
--      no phantom 'cancelled' order in the Transaction Log. `payload` holds the
--      fully-priced snapshot, which is authoritative at insert time (D2): a
--      price edit in Manage Menu while a payment is in flight must never change
--      what the customer is charged.
--
--   2. stripe_events — durable webhook dedup + audit (D9). Keyed on Stripe's
--      own event id, so a redelivered event is recognised across restarts.
--
--   3. payments.processor_payment_type / card_brand / card_last4 — the first
--      drives the D5 Interac rule (interac_present refunds require the physical
--      card at the reader, so they are blocked from Back Office); the other two
--      are for receipts. payments.processor_txn_id ALREADY EXISTS from
--      schema.sql and takes the PaymentIntent id — it needs no migration.
--
--   4. device_pairings.stripe_reader_id — binds a paired tablet to the reader
--      it should drive. Stripe readers are a SEPARATE trust layer from
--      device_pairings (readers are registered to a Stripe Location by Stripe;
--      device_pairings is our own tablet-trust layer, see
--      docs/architecture/device-pairing.md). This column binds them without
--      merging them.
--
--   5. locations.stripe_location_id — multi-location readiness. The Stripe
--      Location id lives on the row, not in an env var, so a second store is
--      configuration rather than a code change.
--
--   6. Two PARTIAL UNIQUE indexes that are correctness guarantees, not
--      performance tuning — see the block comment above them.
--
-- Style matches refunds.sql / modifier_management_and_discounts.sql: TEXT +
-- CHECK for the small fixed sets, DO $$ guards on constraints, IF NOT EXISTS
-- throughout, so the whole file is idempotent and re-runnable.
-- ============================================================

-- ------------------------------------------------------------
-- 1. pending_checkouts — the in-flight, priced cart (D1)
-- ------------------------------------------------------------
-- Lifecycle: one row per card checkout attempt.
--   created 'awaiting_payment' → 'succeeded' (order_id set, exactly once)
--                              → 'failed'    (declined; cashier may retry,
--                                             which creates a NEW PaymentIntent
--                                             against this SAME row)
--                              → 'cancelled' (cashier or customer aborted)
--                              → 'expired'   (reconciliation swept it up)
--                              → 'orphaned'  (D8: Stripe took the money but the
--                                             order insert failed — must alert)
--
-- Rows are never deleted: this table is the audit trail for money that was
-- attempted but never became an order, which is exactly the evidence needed
-- when a customer says "I was charged and got no food". Same "never
-- hard-delete history" spirit as device_pairings and staff/shifts.
CREATE TABLE IF NOT EXISTS pending_checkouts (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id              UUID NOT NULL REFERENCES locations(id),
    staff_id                 UUID NOT NULL REFERENCES staff(id),   -- the ringing cashier
    device_id                TEXT,                                 -- from the device-pairing cookie, for reader binding
    payload                  JSONB NOT NULL,                       -- fully-priced snapshot (D2): lines, variants, modifiers, addons, unit prices
    subtotal                 NUMERIC(10,2) NOT NULL,               -- frozen at creation, never recomputed
    discount                 NUMERIC(10,2) NOT NULL DEFAULT 0,
    discount_percent         NUMERIC(5,2),
    discount_reason          TEXT,                                 -- same fixed set as orders (CHECK below)
    tax                      NUMERIC(10,2) NOT NULL,
    total                    NUMERIC(10,2) NOT NULL,               -- pre-tip; the reader adds the tip on top
    stripe_payment_intent_id TEXT,                                 -- UNIQUE via partial index below
    stripe_reader_id         TEXT,                                 -- which reader was asked to collect
    status                   TEXT NOT NULL DEFAULT 'awaiting_payment',
    order_id                 UUID REFERENCES orders(id),           -- set exactly once, on success
    error_message            TEXT,                                 -- last decline / failure reason
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 2. stripe_events — durable webhook dedup + audit (D9)
-- ------------------------------------------------------------
-- Keyed on Stripe's own event id (evt_…), which is what makes redelivery safe
-- across process restarts. This is one of TWO dedup layers: this table plus the
-- partial UNIQUE index on payments.processor_txn_id below. The table alone is
-- not sufficient — two concurrent deliveries can both pass a lookup before
-- either commits — so the index is the actual guarantee and this is the audit
-- trail and the replay source.
CREATE TABLE IF NOT EXISTS stripe_events (
    id            TEXT PRIMARY KEY,                       -- Stripe event id — the dedup key
    type          TEXT NOT NULL,
    api_version   TEXT,
    payload       JSONB NOT NULL,                         -- full event, for replay and audit
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at  TIMESTAMPTZ,                            -- NULL = received but not yet handled
    process_error TEXT
);

-- ------------------------------------------------------------
-- 3. payments — processor detail (nullable; every existing row stays NULL)
-- ------------------------------------------------------------
-- processor_payment_type is the column the D5 Interac rule reads: an
-- interac_present sale cannot be refunded remotely from Back Office, because
-- the network requires the physical card at the reader.
ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS processor_payment_type TEXT,
    ADD COLUMN IF NOT EXISTS card_brand             TEXT,
    ADD COLUMN IF NOT EXISTS card_last4             TEXT;

-- ------------------------------------------------------------
-- 4. device_pairings — reader binding
-- ------------------------------------------------------------
ALTER TABLE device_pairings
    ADD COLUMN IF NOT EXISTS stripe_reader_id TEXT;

-- ------------------------------------------------------------
-- 5. locations — Stripe Location id (multi-location readiness)
-- ------------------------------------------------------------
ALTER TABLE locations
    ADD COLUMN IF NOT EXISTS stripe_location_id TEXT;

-- ------------------------------------------------------------
-- 6. CHECK constraints (idempotent, DO-guarded — same pattern as refunds.sql)
-- ------------------------------------------------------------
DO $$
BEGIN
    -- pending_checkouts.status — the lifecycle above, TEXT + CHECK not an enum (D6).
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_checkouts_status_check') THEN
        ALTER TABLE pending_checkouts ADD CONSTRAINT pending_checkouts_status_check
            CHECK (status IN ('awaiting_payment', 'succeeded', 'failed',
                              'cancelled', 'expired', 'orphaned'));
    END IF;

    -- Mirrors orders_discount_reason_check exactly — a pending checkout becomes
    -- an order verbatim (D2), so it must not be able to hold a discount reason
    -- the orders table would reject.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_checkouts_discount_reason_check') THEN
        ALTER TABLE pending_checkouts ADD CONSTRAINT pending_checkouts_discount_reason_check
            CHECK (discount_reason IS NULL OR discount_reason IN
                ('family', 'friend', 'employee', 'neighbouring_store'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_checkouts_discount_percent_check') THEN
        ALTER TABLE pending_checkouts ADD CONSTRAINT pending_checkouts_discount_percent_check
            CHECK (discount_percent IS NULL OR (discount_percent > 0 AND discount_percent <= 100));
    END IF;

    -- A successful checkout must have produced an order; nothing else may claim
    -- one. This is the DB-level expression of "order_id is set exactly once, on
    -- success" — it makes the D8 'orphaned' case (money taken, no order)
    -- impossible to mislabel as 'succeeded'.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_checkouts_order_id_check') THEN
        ALTER TABLE pending_checkouts ADD CONSTRAINT pending_checkouts_order_id_check
            CHECK ((status = 'succeeded' AND order_id IS NOT NULL)
                OR (status <> 'succeeded' AND order_id IS NULL));
    END IF;

    -- payments.processor_payment_type — NULL on every pre-Stripe row (all of
    -- them today, since payments are mocked), so NULL must stay legal.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_processor_payment_type_check') THEN
        ALTER TABLE payments ADD CONSTRAINT payments_processor_payment_type_check
            CHECK (processor_payment_type IS NULL OR processor_payment_type IN
                ('card_present', 'interac_present', 'other'));
    END IF;
END $$;

-- ------------------------------------------------------------
-- 7. Indexes
-- ------------------------------------------------------------
-- The two PARTIAL UNIQUE indexes below are CORRECTNESS guarantees, not
-- performance tuning, and the schema guard does NOT verify indexes
-- (docs/architecture/schema-guard.md — tables and added columns only). They
-- must be confirmed by hand against production; the plan's Slice 0.2 step 6
-- carries the query. Losing either one silently reopens the double-charge and
-- duplicate-order paths that D9 exists to close.
--
-- Both are partial (WHERE … IS NOT NULL) because NULLs are expected and
-- plentiful: every existing payments row has a NULL processor_txn_id, and a
-- pending checkout has no PaymentIntent id until the Stripe call returns.
-- (Postgres treats NULLs as distinct in a unique index anyway, so the partial
-- clause is about keeping the index small and its intent explicit.)

-- One order can never be paid twice by the same PaymentIntent. This is the
-- hard backstop behind webhook idempotency: even if two concurrent deliveries
-- both pass the stripe_events lookup, only one INSERT can win.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_processor_txn_id
    ON payments(processor_txn_id) WHERE processor_txn_id IS NOT NULL;

-- One PaymentIntent belongs to exactly one pending checkout — so a retried or
-- redelivered webhook can always resolve to a single row to lock.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_checkouts_payment_intent
    ON pending_checkouts(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

-- Reconciliation sweep: "awaiting_payment older than N minutes" (D8).
CREATE INDEX IF NOT EXISTS idx_pending_checkouts_status_created
    ON pending_checkouts(status, created_at);

-- Set once on success; used to resolve an order back to its checkout attempt.
CREATE INDEX IF NOT EXISTS idx_pending_checkouts_order_id
    ON pending_checkouts(order_id);

-- Webhook audit queries ("what did Stripe send us this hour, and did we
-- process it?").
CREATE INDEX IF NOT EXISTS idx_stripe_events_type_received
    ON stripe_events(type, received_at);

-- Unprocessed-event sweep — partial, because the interesting set is tiny and
-- should normally be empty.
CREATE INDEX IF NOT EXISTS idx_stripe_events_unprocessed
    ON stripe_events(received_at) WHERE processed_at IS NULL;

-- Refunds Report already selects stripe_refund_id (server.js, refunds report);
-- this makes the reverse lookup (webhook → local refund row) cheap.
CREATE INDEX IF NOT EXISTS idx_order_refunds_stripe_refund_id
    ON order_refunds(stripe_refund_id);
