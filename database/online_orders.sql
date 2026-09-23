-- ============================================================
-- Online ordering (website pickup tickets) - schema only
-- ------------------------------------------------------------
-- Slice 1 of the online-ordering work. This file ONLY widens the schema so a
-- web pickup ticket can be stored. It adds no route, changes no existing
-- column, drops nothing, and backfills nothing beyond the column defaults
-- described below. Applying it changes nothing staff can see and nothing that
-- currently runs.
--
-- WHERE THE ORDERS COME FROM
-- narcostacos.ca (the marketing site, a separate repo) takes a card through
-- Clover's HOSTED ECOMMERCE iframe and charges it in a Netlify function. That
-- is a DIFFERENT Clover product from the in-store Clover Flex / Cloud Pay
-- Display integration this POS drives - different merchant, different keys,
-- different API. The two must never be conflated; see the note on
-- payments.processor below, which exists precisely because they currently are.
--
-- WHAT IS NOT IN THIS SLICE (deliberately)
--   * No Express route. The website cannot reach POST /api/orders - that route
--     is behind requireDevicePairing, which needs a paired-device cookie a web
--     browser on another domain will never have. The later server-to-server
--     ingest route is a separate slice.
--   * No change to fetchKdsOrders. Its item query INNER JOINs menu_items on
--     order_items.item_id. Online lines will carry item_id = NULL (a website
--     cart has no POS menu UUIDs), so today they would be silently dropped and
--     the kitchen would see a ticket with ZERO items on it. name_snapshot
--     below is what a later LEFT JOIN will read. UNTIL THAT JOIN CHANGES,
--     THESE COLUMNS ALONE DO NOT MAKE AN ONLINE TICKET VISIBLE ON THE KDS.
--   * No change to PIN login. staff.is_system below is the flag a later slice
--     will filter on; the login query does not read it yet.
--   * No backfill of payments.processor. See that section.
--
-- NOTE ON THE SCHEMA GUARD
-- backend/schema-requirements.json is regenerated from this file by
-- `npm run schema:sync`. Once that manifest lists these columns, the backend
-- REFUSES TO BOOT until they exist in the database it connects to. That is
-- deliberate (docs/architecture/schema-guard.md) and it is exactly why this
-- migration must reach PRODUCTION *before* any code that reads these columns
-- is deployed. See the Schema Change Checklist in CLAUDE.md.
--
-- Re-runnable: every statement is IF NOT EXISTS or guarded by a catalog
-- lookup, and the one seed row is inserted only if absent.
-- ============================================================


-- ============================================================
-- STAFF - machine users
-- ============================================================

-- Marks a staff row that is NOT a person: no one holds its PIN, no one clocks
-- in on it, and it must never appear on the PIN login screen or the roster.
-- It exists only because orders.staff_id is NOT NULL, so an order that no
-- cashier rang in still needs a staff row to point at.
ALTER TABLE staff
    ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN staff.is_system IS
    'TRUE = machine user, not a person (e.g. the website''s "Online Ordering" '
    'account). Exists because orders.staff_id is NOT NULL. Hide these from PIN '
    'login and from the staff roster - the login query does not filter on this '
    'yet, that is a later slice.';

-- The website's staff row.
--
-- WHY THE PIN HASH IS WHAT IT IS
-- PIN login fetches EVERY active staff row and bcrypt-compares the submitted
-- PIN against each pin_hash in turn - there is no role filter and no is_system
-- filter yet. So this row IS in the candidate set today. Hashing a 36-character
-- random hex string (not a 4-digit PIN) means no PIN a human can type on the
-- keypad can ever match it. The plaintext is generated here, never stored, and
-- never needed again: nobody logs in as this account, ever.
--
-- location_id matters: priceCart resolves the tax rate from the ordering
-- staff member's location, so attaching this row to the wrong location would
-- quietly tax every online order wrong. Hence the exactly-one-active-location
-- guard rather than a silent LIMIT 1.
DO $$
DECLARE
    active_locations INTEGER;
BEGIN
    IF EXISTS (SELECT 1 FROM staff WHERE name = 'Online Ordering') THEN
        RAISE NOTICE 'Staff row "Online Ordering" already present - leaving it as is.';
        RETURN;
    END IF;

    SELECT count(*) INTO active_locations FROM locations WHERE active = true;

    IF active_locations <> 1 THEN
        RAISE EXCEPTION
            'Expected exactly one active location, found %. Seed locations first, '
            'then re-run this migration - guessing which location the website '
            'orders belong to would silently apply the wrong tax rate.',
            active_locations;
    END IF;

    INSERT INTO staff (location_id, name, title, pin_hash, role, active, is_system)
    VALUES (
        (SELECT id FROM locations WHERE active = true),
        'Online Ordering',
        'Website',
        -- Random secret, hashed the same way every other PIN is. Deliberately
        -- not recorded anywhere: it is unusable by design.
        crypt(encode(gen_random_bytes(18), 'hex'), gen_salt('bf', 10)),
        'cashier',
        true,
        true
    );
END $$;


-- ============================================================
-- ORDERS - channel, customer contact, pickup time, payment refs
-- ============================================================

-- Which channel rang this order in. Every existing row is an in-store order,
-- which is exactly what the DEFAULT records - this is not a guess about
-- history, it is the truth about it.
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'pos';

-- Pickup contact. orders.customer_name already exists; a phone number did not,
-- and the website makes it a required field because it is how the kitchen
-- reaches someone whose order is sitting on the pass.
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS customer_phone TEXT;

-- Optional on the website (receipt address only). NULL on every in-store order.
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS customer_email TEXT;

-- WHEN the customer said they would collect. fulfillment_type already says
-- pickup vs delivery, but not the time, and without a time the kitchen cannot
-- sequence a ticket that arrived an hour before it is wanted.
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS pickup_at TIMESTAMPTZ;

-- Free text the customer typed at checkout. order_items.notes is per line and
-- is written by the till; orders had no order-level note at all. The website
-- caps this at 500 characters before it ever gets here.
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS customer_instructions TEXT;

-- The charge id from Clover's HOSTED ECOMMERCE API (the website's Netlify
-- function), e.g. a bare alphanumeric id with no prefix. This is NOT a Clover
-- Flex / Cloud Pay Display payment id and NOT a Stripe PaymentIntent id.
-- Kept on the order so a web charge can be traced back to a ticket.
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS clover_ecomm_charge_id TEXT;

-- The website's own idempotency key for one checkout attempt (it generates one
-- key per attempt and reuses it for every retry, which is what stops a
-- double-click becoming two charges at Clover). Unique here, so a retried
-- server-to-server ingest returns the EXISTING ticket instead of writing a
-- second one for a single charge.
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS online_order_ref TEXT;

COMMENT ON COLUMN orders.source IS
    'Channel that created the order: ''pos'' (rung in at the till) or '
    '''online'' (narcostacos.ca). Existing rows default to ''pos'' because '
    'they are all in-store orders.';
COMMENT ON COLUMN orders.customer_phone IS
    'Pickup contact number. Required by the website checkout; NULL on in-store '
    'orders, which have no customer record.';
COMMENT ON COLUMN orders.customer_email IS
    'Optional receipt address collected by the website checkout. NULL in-store.';
COMMENT ON COLUMN orders.pickup_at IS
    'Customer-selected pickup time from the website. NULL in-store (counter '
    'orders are made now). fulfillment_type says pickup/delivery; this says when.';
COMMENT ON COLUMN orders.customer_instructions IS
    'Order-level free text from the website checkout, capped at 500 chars by '
    'the site. Distinct from order_items.notes, which is per line and till-side.';
COMMENT ON COLUMN orders.clover_ecomm_charge_id IS
    'Charge id from the Clover HOSTED ECOMMERCE API used by the website. NOT a '
    'Clover Flex/Cloud Pay Display payment id and NOT a Stripe PaymentIntent - '
    'different merchant, different product. Unique where present.';
COMMENT ON COLUMN orders.online_order_ref IS
    'The website''s idempotency key for one checkout attempt. Unique where '
    'present so a retried ingest resolves to the same ticket instead of '
    'creating a duplicate for one charge.';

-- Added as a named constraint via a catalog lookup so this file stays
-- re-runnable (ADD CONSTRAINT has no IF NOT EXISTS).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'orders_source_check'
           AND conrelid = 'orders'::regclass
    ) THEN
        ALTER TABLE orders
            ADD CONSTRAINT orders_source_check
            CHECK (source IN ('pos', 'online'));
    END IF;
END $$;

-- Partial uniques: both columns are NULL on every in-store order, and only the
-- non-null ones are ever looked up or deduped against. Same shape as
-- idx_order_refunds_clover_refund_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_clover_ecomm_charge_id
    ON orders (clover_ecomm_charge_id)
    WHERE clover_ecomm_charge_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_online_order_ref
    ON orders (online_order_ref)
    WHERE online_order_ref IS NOT NULL;

-- For "show me today's online orders" style reads, which is how Live Orders
-- and reports will want to slice this once the badges land.
CREATE INDEX IF NOT EXISTS idx_orders_source_created_at
    ON orders (source, created_at DESC);


-- ============================================================
-- ORDER_ITEMS - what the kitchen prints when there is no menu_items row
-- ============================================================

-- An online line has no POS menu UUID, so order_items.item_id will be NULL and
-- the menu_items join can supply no name. This carries the name the customer
-- actually saw and paid for, which is also the correct thing to print: it is a
-- snapshot, so renaming an item in Manage Menu later cannot rewrite history on
-- an old ticket.
ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS name_snapshot TEXT;

-- Same problem for the options. In-store, extras and removals are rows in
-- order_item_modifiers keyed to modifier_options UUIDs; a website cart cannot
-- produce those ids. This holds the kitchen-readable version (added extras and
-- "no onions" style removals) as text. Plain text or JSON text both work - the
-- kitchen display only ever reads it, never joins on it.
ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS options_snapshot TEXT;

COMMENT ON COLUMN order_items.name_snapshot IS
    'Item name as shown to the customer, for lines with no menu_items row '
    '(item_id IS NULL on online orders). Read by a later LEFT JOIN in '
    'fetchKdsOrders via COALESCE(mi.name, oi.name_snapshot); the join is still '
    'an INNER JOIN today, so this column is written before it is read.';
COMMENT ON COLUMN order_items.options_snapshot IS
    'Kitchen-readable extras and removed ingredients for lines that cannot use '
    'order_item_modifiers (no modifier_options UUIDs exist for a website cart). '
    'Text or JSON text; display only, never joined on.';


-- ============================================================
-- PAYMENTS - say which processor took the money instead of guessing
-- ============================================================

-- THE BUG THIS COLUMN EXISTS TO FIX
-- paymentProcessorOf() currently infers the processor from the shape of
-- processor_txn_id: no id => 'internal', starts with 'pi_' => 'stripe',
-- anything else => 'clover'. That was true while the Clover Flex was the only
-- non-Stripe processor. It is about to stop being true: a Clover HOSTED
-- ECOMMERCE charge id from the website does not start with 'pi_' either, so it
-- would be classified 'clover' and decideRefundSettlement would route a web
-- refund to the in-store Flex - demanding the customer bring their card to the
-- counter for a payment that never touched the terminal.
--
-- NULL MEANS "OLD ROW - KEEP USING THE PREFIX LOGIC".
-- Nothing is backfilled here and no trigger classifies historical rows. Every
-- existing Stripe and Clover Mini payment keeps working exactly as it does
-- today, through the same prefix inference, until someone deliberately
-- migrates them. Only new rows will set this.
ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS processor TEXT;

COMMENT ON COLUMN payments.processor IS
    'Which processor actually took this money: ''internal'' (cash/mocked), '
    '''stripe'', ''clover_pos'' (Flex / Cloud Pay Display, in-store) or '
    '''clover_ecomm'' (hosted iframe on the website). NULL = pre-existing row; '
    'fall back to paymentProcessorOf()''s processor_txn_id prefix logic. Not '
    'backfilled on purpose - the two Clover products refund through completely '
    'different paths and guessing which one an old row used is how a refund '
    'gets sent to the wrong terminal.';

-- IS NULL is spelled out rather than left to three-valued logic, so the next
-- person reading this does not have to work out whether NULL passes. It does.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'payments_processor_check'
           AND conrelid = 'payments'::regclass
    ) THEN
        ALTER TABLE payments
            ADD CONSTRAINT payments_processor_check
            CHECK (
                processor IS NULL
                OR processor IN ('internal', 'stripe', 'clover_pos', 'clover_ecomm')
            );
    END IF;
END $$;
