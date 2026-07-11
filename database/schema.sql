-- ============================================================
-- Restaurant POS Database Schema (PostgreSQL)
-- Counter-service model, multi-location-ready, ingredient-level inventory
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- ============================================================
-- ENUMS
-- ============================================================
CREATE TYPE staff_role AS ENUM ('owner', 'admin', 'manager', 'cashier', 'kitchen');
CREATE TYPE order_status AS ENUM ('open', 'preparing', 'ready', 'completed', 'cancelled');
CREATE TYPE order_item_status AS ENUM ('pending', 'preparing', 'ready', 'served');
CREATE TYPE fulfillment_type AS ENUM ('pickup', 'delivery'); -- room to grow beyond counter-only
CREATE TYPE payment_method AS ENUM ('card', 'cash', 'gift_card', 'other');
CREATE TYPE payment_status AS ENUM ('pending', 'authorized', 'captured', 'failed', 'refunded');

-- ============================================================
-- LOCATIONS & STAFF
-- ============================================================
CREATE TABLE locations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    address         TEXT,
    phone           TEXT,
    timezone        TEXT NOT NULL DEFAULT 'America/New_York',
    tax_rate        NUMERIC(5,4) NOT NULL DEFAULT 0.0000, -- e.g. 0.0825 = 8.25%
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE staff (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id     UUID REFERENCES locations(id), -- NULL = owner, access to all locations
    name            TEXT NOT NULL,
    title           TEXT,          -- "Cashier", "Cook", "Manager" — display only, does NOT control access
    phone           TEXT,          -- shift contact + identity verification for PIN resets
    email           TEXT,
    photo_url       TEXT,          -- optional, shown as a tile on the PIN login screen
    pin_hash        TEXT NOT NULL, -- hashed 4-digit PIN, not plaintext. Every staff member (incl. owners) gets a unique PIN.
    role            staff_role NOT NULL DEFAULT 'cashier', -- controls system ACCESS level
    hourly_rate     NUMERIC(8,2),  -- used to calculate bi-weekly pay from shifts.clock_in/clock_out; NULL for owners not on payroll
    hire_date       DATE,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deliberately NOT stored here: SIN, banking/direct-deposit details, tax withholding
-- elections (TD1). Actual pay processing, tax remittance, and T4s belong in a real
-- payroll provider (e.g. Wagepoint, Push, ADP) — this system exports hours × hourly_rate
-- per pay period; it does not run payroll itself.

-- PIN must be unique among active staff AT a given location (two people at different
-- locations could coincidentally pick the same 4-digit PIN; that's fine, they never log
-- into each other's terminal). Enforce uniqueness at the app layer during PIN assignment.

CREATE TABLE shifts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id        UUID NOT NULL REFERENCES staff(id),
    location_id     UUID NOT NULL REFERENCES locations(id),
    clock_in        TIMESTAMPTZ NOT NULL DEFAULT now(),
    clock_out       TIMESTAMPTZ
);

-- ============================================================
-- MENU STRUCTURE
-- ============================================================
CREATE TABLE menu_categories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id     UUID NOT NULL REFERENCES locations(id),
    name            TEXT NOT NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    active          BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE menu_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id     UUID NOT NULL REFERENCES menu_categories(id),
    name            TEXT NOT NULL,
    description     TEXT,
    base_price      NUMERIC(10,2) NOT NULL, -- price when no variant applies
    image_url       TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- e.g. Small/Medium/Large, or 8oz/12oz
CREATE TABLE item_variants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id         UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,           -- "Large"
    price            NUMERIC(10,2) NOT NULL, -- absolute price for this variant
    sku             TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    active          BOOLEAN NOT NULL DEFAULT TRUE
);

-- e.g. "Choose your toppings", "Choose sauce"
CREATE TABLE modifier_groups (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    min_select      INTEGER NOT NULL DEFAULT 0,
    max_select      INTEGER NOT NULL DEFAULT 1, -- e.g. 1 for radio-style, >1 for checkboxes
    required        BOOLEAN NOT NULL DEFAULT FALSE
);

-- individual options within a group, e.g. "Extra Cheese" +$1.00
CREATE TABLE modifier_options (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id        UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    price_delta     NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    active          BOOLEAN NOT NULL DEFAULT TRUE
);

-- join table: which modifier groups apply to which items
CREATE TABLE item_modifier_groups (
    item_id         UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    modifier_group_id UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (item_id, modifier_group_id)
);

-- ============================================================
-- ADD-ONS (items that come bundled free with another item,
-- and are ALSO independently orderable/sellable at their own price
-- e.g. Birria Tacos come with a free cup of consomé + lemon;
-- a customer can also order extra consomé on its own for a charge)
-- ============================================================

CREATE TABLE item_addons (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id         UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE, -- e.g. Birria Tacos
    addon_item_id   UUID NOT NULL REFERENCES menu_items(id),                   -- e.g. Consomé
    included_quantity INTEGER NOT NULL DEFAULT 1, -- how many come free automatically
    extra_price     NUMERIC(10,2),        -- price per unit beyond included_quantity;
                                           -- NULL = fall back to addon_item's own base_price
    sort_order      INTEGER NOT NULL DEFAULT 0,
    UNIQUE (item_id, addon_item_id)
);

-- ============================================================
-- INVENTORY (ingredient-level)
-- ============================================================
CREATE TABLE ingredients (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id     UUID NOT NULL REFERENCES locations(id),
    name            TEXT NOT NULL,
    unit            TEXT NOT NULL,          -- 'oz', 'g', 'each', etc.
    quantity_on_hand NUMERIC(12,3) NOT NULL DEFAULT 0,
    reorder_threshold NUMERIC(12,3) NOT NULL DEFAULT 0,
    cost_per_unit   NUMERIC(10,4) NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE item_ingredients (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id         UUID REFERENCES menu_items(id) ON DELETE CASCADE,
    variant_id      UUID REFERENCES item_variants(id) ON DELETE CASCADE,
    ingredient_id   UUID NOT NULL REFERENCES ingredients(id),
    quantity_used   NUMERIC(12,3) NOT NULL,
    CHECK (item_id IS NOT NULL OR variant_id IS NOT NULL)
);

CREATE TABLE modifier_ingredients (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    modifier_option_id UUID NOT NULL REFERENCES modifier_options(id) ON DELETE CASCADE,
    ingredient_id   UUID NOT NULL REFERENCES ingredients(id),
    quantity_used   NUMERIC(12,3) NOT NULL
);

-- ============================================================
-- ORDERS
-- ============================================================
CREATE TABLE orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id     UUID NOT NULL REFERENCES locations(id),
    order_number    SERIAL,
    status          order_status NOT NULL DEFAULT 'open',
    fulfillment_type fulfillment_type NOT NULL DEFAULT 'pickup',
    customer_name   TEXT,
    staff_id        UUID NOT NULL REFERENCES staff(id),
    subtotal        NUMERIC(10,2) NOT NULL DEFAULT 0,
    tax             NUMERIC(10,2) NOT NULL DEFAULT 0,
    tip             NUMERIC(10,2) NOT NULL DEFAULT 0,
    discount        NUMERIC(10,2) NOT NULL DEFAULT 0,
    total           NUMERIC(10,2) NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
);

CREATE TABLE order_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    item_id         UUID REFERENCES menu_items(id),
    variant_id      UUID REFERENCES item_variants(id),
    quantity        INTEGER NOT NULL DEFAULT 1,
    unit_price      NUMERIC(10,2) NOT NULL,
    notes           TEXT,
    status          order_item_status NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_item_modifiers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_item_id   UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    modifier_option_id UUID NOT NULL REFERENCES modifier_options(id),
    price_delta     NUMERIC(10,2) NOT NULL
);

CREATE TABLE order_item_addons (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_item_id   UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    addon_item_id   UUID NOT NULL REFERENCES menu_items(id),
    quantity        INTEGER NOT NULL DEFAULT 1,
    unit_price      NUMERIC(10,2) NOT NULL DEFAULT 0,
    is_complimentary BOOLEAN NOT NULL DEFAULT FALSE
);

-- ============================================================
-- PAYMENTS
-- ============================================================
CREATE TABLE payments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id),
    method          payment_method NOT NULL,
    amount          NUMERIC(10,2) NOT NULL,
    processor_txn_id TEXT,
    status          payment_status NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_staff_location ON staff(location_id);
CREATE INDEX idx_menu_categories_location ON menu_categories(location_id);
CREATE INDEX idx_menu_items_category ON menu_items(category_id);
CREATE INDEX idx_item_variants_item ON item_variants(item_id);
CREATE INDEX idx_modifier_options_group ON modifier_options(group_id);
CREATE INDEX idx_item_addons_item ON item_addons(item_id);
CREATE INDEX idx_item_addons_addon_item ON item_addons(addon_item_id);
CREATE INDEX idx_ingredients_location ON ingredients(location_id);
CREATE INDEX idx_orders_location_status ON orders(location_id, status);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_item_modifiers_order_item ON order_item_modifiers(order_item_id);
CREATE INDEX idx_order_item_addons_order_item ON order_item_addons(order_item_id);
CREATE INDEX idx_payments_order ON payments(order_id);

-- ============================================================
-- SEED: first location
-- ============================================================
INSERT INTO locations (name, address, timezone, tax_rate)
VALUES ('Narcos Tacos - Lawrence East', 'Lawrence Ave East, Scarborough, ON', 'America/Toronto', 0.1300);
