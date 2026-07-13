require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 4000;

// --------------- Middleware ---------------
app.use(cors());
app.use(express.json());

// --------------- Postgres pool ---------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Small helper for throwing HTTP-status-carrying validation errors from
// deep inside the order transaction, caught centrally to roll back + reply.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// --------------- Rate limiter (PIN-guessing protection) ---------------
// Tracks failed login attempts per IP. After 5 failures within 60s,
// the IP is blocked for 30s before it can try again.
const loginAttempts = new Map(); // key: IP, value: { count, firstAttempt, blockedUntil }

function checkRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (!record) return { allowed: true };

  // Currently blocked?
  if (record.blockedUntil && now < record.blockedUntil) {
    const retryAfter = Math.ceil((record.blockedUntil - now) / 1000);
    return { allowed: false, retryAfter };
  }

  // Window expired — reset
  if (now - record.firstAttempt > 60_000) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }

  // Under the limit?
  if (record.count < 5) return { allowed: true };

  // Just hit the limit — start 30s block
  record.blockedUntil = now + 30_000;
  const retryAfter = 30;
  return { allowed: false, retryAfter };
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (!record || now - record.firstAttempt > 60_000) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now, blockedUntil: null });
  } else {
    record.count += 1;
  }
}

function clearAttempts(ip) {
  loginAttempts.delete(ip);
}

// --------------- Routes ---------------

// Health check — verifies DB connectivity
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    console.error("Health check failed:", err.message);
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

// Menu items (flat — kept for backward compatibility)
app.get("/api/menu", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM menu_items ORDER BY sort_order, name");
    res.json(rows);
  } catch (err) {
    console.error("Failed to fetch menu items:", err.message);
    res.status(500).json({ error: "Failed to fetch menu items" });
  }
});

// Full menu structure — categories → items → variants / modifiers / addons
app.get("/api/menu/full", async (req, res) => {
  try {
    // 1. Categories
    const { rows: categories } = await pool.query(
      "SELECT id, name, sort_order FROM menu_categories WHERE active = true ORDER BY sort_order"
    );

    // 2. Items
    const { rows: items } = await pool.query(
      "SELECT id, category_id, name, description, base_price, image_url, sort_order FROM menu_items WHERE active = true ORDER BY sort_order, name"
    );

    // 3. Variants
    const { rows: variants } = await pool.query(
      "SELECT id, item_id, name, price, sku, sort_order FROM item_variants WHERE active = true ORDER BY sort_order"
    );

    // 4. Modifier groups linked to items (join table + group details)
    const { rows: itemModGroups } = await pool.query(`
      SELECT img.item_id, img.sort_order AS link_sort,
             mg.id, mg.name, mg.min_select, mg.max_select, mg.required
      FROM item_modifier_groups img
      JOIN modifier_groups mg ON mg.id = img.modifier_group_id
      ORDER BY img.sort_order
    `);

    // 5. Modifier options
    const { rows: modOptions } = await pool.query(
      "SELECT id, group_id, name, price_delta, sort_order, max_quantity, default_selected FROM modifier_options WHERE active = true ORDER BY sort_order"
    );

    // 6. Item addons
    const { rows: addons } = await pool.query(`
      SELECT ia.id, ia.item_id, ia.addon_item_id, ia.included_quantity,
             ia.extra_price, ia.sort_order,
             mi.name AS addon_name, mi.base_price AS addon_base_price
      FROM item_addons ia
      JOIN menu_items mi ON mi.id = ia.addon_item_id
      ORDER BY ia.sort_order
    `);

    // ---------- Assemble in memory ----------

    // Index modifier options by group_id
    const optionsByGroup = {};
    for (const opt of modOptions) {
      (optionsByGroup[opt.group_id] ||= []).push(opt);
    }

    // Index modifier groups by item_id (attach options inline)
    const modGroupsByItem = {};
    for (const mg of itemModGroups) {
      const group = {
        id: mg.id,
        name: mg.name,
        min_select: mg.min_select,
        max_select: mg.max_select,
        required: mg.required,
        options: optionsByGroup[mg.id] || [],
      };
      (modGroupsByItem[mg.item_id] ||= []).push(group);
    }

    // Index variants by item_id
    const variantsByItem = {};
    for (const v of variants) {
      (variantsByItem[v.item_id] ||= []).push(v);
    }

    // Index addons by item_id
    const addonsByItem = {};
    for (const a of addons) {
      (addonsByItem[a.item_id] ||= []).push(a);
    }

    // Index items by category_id, enriching each with nested data
    const itemsByCat = {};
    for (const item of items) {
      const enriched = {
        ...item,
        variants: variantsByItem[item.id] || [],
        modifier_groups: modGroupsByItem[item.id] || [],
        addons: addonsByItem[item.id] || [],
      };
      (itemsByCat[item.category_id] ||= []).push(enriched);
    }

    // Build final response
    const result = categories.map((cat) => ({
      ...cat,
      items: itemsByCat[cat.id] || [],
    }));

    res.json(result);
  } catch (err) {
    console.error("Failed to fetch full menu:", err.message);
    res.status(500).json({ error: "Failed to fetch full menu" });
  }
});

// PIN login
app.post("/api/auth/login", async (req, res) => {
  const ip = req.ip;

  // Rate-limit check
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      success: false,
      message: "Too many failed attempts. Try again shortly.",
      retryAfter: rateCheck.retryAfter,
    });
  }

  const { pin } = req.body;
  if (!pin || typeof pin !== "string") {
    return res.status(400).json({ success: false, message: "PIN is required" });
  }

  try {
    // Fetch all active staff with their hashed PINs
    const { rows } = await pool.query(
      "SELECT id, name, role, location_id, pin_hash FROM staff WHERE active = true"
    );

    // Compare submitted PIN against each hash
    let matchedStaff = null;
    for (const staff of rows) {
      const isMatch = await bcrypt.compare(pin, staff.pin_hash);
      if (isMatch) {
        matchedStaff = staff;
        break;
      }
    }

    if (!matchedStaff) {
      recordFailedAttempt(ip);
      return res.status(401).json({ success: false, message: "PIN not recognized" });
    }

    // Success — clear rate-limit record for this IP
    clearAttempts(ip);

    // Return staff info WITHOUT pin_hash
    const { pin_hash, ...staffData } = matchedStaff;
    return res.json({ success: true, staff: staffData });
  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// --------------- Checkout: create an order ---------------
// POST /api/orders
// Body: {
//   staffId, paymentMethod ("cash" | "card"),
//   items: [{ itemId, variantId|null, quantity, notes|null,
//             modifiers: [{ optionId, quantity }],
//             addons:    [{ addonId, extraQty }] }]
// }
//
// SECURITY: prices are ALWAYS recomputed from the live database. The
// payload only tells us WHAT was selected, never what it costs — so a
// tampered client can't change the total. The entire write runs inside
// a single transaction; any validation failure rolls the whole thing back.

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

app.post("/api/orders", async (req, res) => {
  const { staffId, paymentMethod, items } = req.body || {};

  // ---- Shape validation (cheap checks before touching the DB) ----
  if (!staffId || typeof staffId !== "string") {
    return res.status(400).json({ error: "staffId is required" });
  }
  if (paymentMethod !== "cash" && paymentMethod !== "card") {
    return res.status(400).json({ error: "paymentMethod must be 'cash' or 'card'" });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Order must contain at least one item" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ---- Resolve staff + location (source of the tax rate) ----
    const { rows: staffRows } = await client.query(
      "SELECT id, location_id FROM staff WHERE id = $1 AND active = true",
      [staffId]
    );
    if (staffRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Unknown or inactive staff member" });
    }
    const staff = staffRows[0];

    // Owners have location_id = NULL (all locations) — fall back to the
    // single active location for a concrete order/tax context.
    const locResult = staff.location_id
      ? await client.query("SELECT id, tax_rate FROM locations WHERE id = $1", [staff.location_id])
      : await client.query(
          "SELECT id, tax_rate FROM locations WHERE active = true ORDER BY created_at LIMIT 1"
        );
    if (locResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No location available for this order" });
    }
    const location = locResult.rows[0];
    const taxRate = parseFloat(location.tax_rate);

    // ---- Recompute every line from the database ----
    // We build a fully-priced structure first (validating as we go), then
    // do the inserts. Nothing is written until all lines pass validation.
    const pricedLines = [];
    let subtotal = 0;

    for (let i = 0; i < items.length; i++) {
      const line = items[i] || {};
      const { itemId, variantId, modifiers, addons, notes } = line;
      const quantity = Number(line.quantity);

      if (!itemId || typeof itemId !== "string") {
        throw new HttpError(400, `Line ${i + 1}: itemId is required`);
      }
      if (!Number.isInteger(quantity) || quantity < 1) {
        throw new HttpError(400, `Line ${i + 1}: quantity must be a positive integer`);
      }

      // Menu item (authoritative base price)
      const { rows: itemRows } = await client.query(
        "SELECT id, name, base_price FROM menu_items WHERE id = $1 AND active = true",
        [itemId]
      );
      if (itemRows.length === 0) {
        throw new HttpError(400, `Line ${i + 1}: menu item not found or unavailable`);
      }
      const menuItem = itemRows[0];

      // Base unit price = variant price (if any) else item base_price
      let unitPrice = parseFloat(menuItem.base_price);

      // Does this item have active variants? If so, a variant is required.
      const { rows: itemVariants } = await client.query(
        "SELECT id, price FROM item_variants WHERE item_id = $1 AND active = true",
        [itemId]
      );
      let resolvedVariantId = null;
      if (itemVariants.length > 0) {
        if (!variantId) {
          throw new HttpError(400, `Line ${i + 1}: "${menuItem.name}" requires a variant selection`);
        }
        const variant = itemVariants.find((v) => v.id === variantId);
        if (!variant) {
          throw new HttpError(400, `Line ${i + 1}: invalid variant for "${menuItem.name}"`);
        }
        unitPrice = parseFloat(variant.price);
        resolvedVariantId = variant.id;
      } else if (variantId) {
        throw new HttpError(400, `Line ${i + 1}: "${menuItem.name}" has no variants`);
      }

      // ---- Modifiers ----
      // Which modifier groups are valid for this item?
      const { rows: itemGroups } = await client.query(
        `SELECT mg.id, mg.name, mg.min_select, mg.max_select, mg.required
           FROM item_modifier_groups img
           JOIN modifier_groups mg ON mg.id = img.modifier_group_id
          WHERE img.item_id = $1`,
        [itemId]
      );
      const groupById = new Map(itemGroups.map((g) => [g.id, g]));
      const selectedPerGroup = new Map(); // groupId -> count of distinct selected options

      const pricedModifiers = [];
      const submittedMods = Array.isArray(modifiers) ? modifiers : [];
      for (const mod of submittedMods) {
        const optionId = mod?.optionId;
        const modQty = Number(mod?.quantity);
        if (!optionId || typeof optionId !== "string") {
          throw new HttpError(400, `Line ${i + 1}: modifier optionId is required`);
        }
        if (!Number.isInteger(modQty) || modQty < 1) {
          throw new HttpError(400, `Line ${i + 1}: modifier quantity must be a positive integer`);
        }

        const { rows: optRows } = await client.query(
          "SELECT id, group_id, price_delta, max_quantity FROM modifier_options WHERE id = $1 AND active = true",
          [optionId]
        );
        if (optRows.length === 0) {
          throw new HttpError(400, `Line ${i + 1}: modifier option not found`);
        }
        const opt = optRows[0];

        // The option's group must actually apply to this item
        if (!groupById.has(opt.group_id)) {
          throw new HttpError(400, `Line ${i + 1}: modifier does not belong to "${menuItem.name}"`);
        }
        const maxQ = opt.max_quantity || 1;
        if (modQty > maxQ) {
          throw new HttpError(400, `Line ${i + 1}: modifier quantity exceeds its limit`);
        }

        selectedPerGroup.set(opt.group_id, (selectedPerGroup.get(opt.group_id) || 0) + 1);
        const priceDelta = parseFloat(opt.price_delta);
        unitPrice += priceDelta * modQty;
        pricedModifiers.push({ optionId: opt.id, priceDelta, quantity: modQty });
      }

      // Enforce each group's min/max selection rules
      for (const g of itemGroups) {
        const count = selectedPerGroup.get(g.id) || 0;
        if (g.required && count < g.min_select) {
          throw new HttpError(
            400,
            `Line ${i + 1}: "${g.name}" requires at least ${g.min_select} selection${g.min_select > 1 ? "s" : ""}`
          );
        }
        if (count > g.max_select) {
          throw new HttpError(400, `Line ${i + 1}: "${g.name}" allows at most ${g.max_select}`);
        }
      }

      // ---- Add-ons ----
      // Driven by the item's actual add-ons in the DB (authoritative), so
      // complimentary items are always recorded even if the client omits them.
      // Paid extras come from the extraQty the client submitted per add-on.
      const { rows: itemAddons } = await client.query(
        `SELECT ia.id, ia.addon_item_id, ia.included_quantity, ia.extra_price,
                mi.base_price AS addon_base_price
           FROM item_addons ia
           JOIN menu_items mi ON mi.id = ia.addon_item_id
          WHERE ia.item_id = $1`,
        [itemId]
      );
      const submittedAddons = Array.isArray(addons) ? addons : [];
      const extraByAddonId = new Map();
      for (const a of submittedAddons) {
        if (!a || typeof a.addonId !== "string") continue;
        const extraQty = Number(a.extraQty) || 0;
        if (!Number.isInteger(extraQty) || extraQty < 0) {
          throw new HttpError(400, `Line ${i + 1}: addon extraQty must be a non-negative integer`);
        }
        // Reject add-ons that don't belong to this item
        if (!itemAddons.some((ia) => ia.id === a.addonId)) {
          throw new HttpError(400, `Line ${i + 1}: addon does not belong to "${menuItem.name}"`);
        }
        extraByAddonId.set(a.addonId, extraQty);
      }

      const pricedAddons = [];
      for (const ia of itemAddons) {
        const extraUnitPrice =
          ia.extra_price != null ? parseFloat(ia.extra_price) : parseFloat(ia.addon_base_price);
        const includedQty = ia.included_quantity;
        const extraQty = extraByAddonId.get(ia.id) || 0;

        // Complimentary portion (free, recorded for the kitchen)
        if (includedQty > 0) {
          pricedAddons.push({
            addonItemId: ia.addon_item_id,
            quantity: includedQty,
            unitPrice: 0,
            isComplimentary: true,
          });
        }
        // Paid extras beyond the included quantity
        if (extraQty > 0) {
          unitPrice += extraUnitPrice * extraQty;
          pricedAddons.push({
            addonItemId: ia.addon_item_id,
            quantity: extraQty,
            unitPrice: round2(extraUnitPrice),
            isComplimentary: false,
          });
        }
      }

      unitPrice = round2(unitPrice);
      subtotal += unitPrice * quantity;

      pricedLines.push({
        itemId: menuItem.id,
        variantId: resolvedVariantId,
        quantity,
        unitPrice,
        notes: typeof notes === "string" && notes.trim() ? notes.trim() : null,
        modifiers: pricedModifiers,
        addons: pricedAddons,
      });
    }

    // ---- Totals ----
    subtotal = round2(subtotal);
    const tax = round2(subtotal * taxRate);
    const tip = 0;
    const total = round2(subtotal + tax + tip);

    // ---- Insert order ----
    const { rows: orderRows } = await client.query(
      `INSERT INTO orders (location_id, staff_id, status, subtotal, tax, tip, total)
       VALUES ($1, $2, 'open', $3, $4, $5, $6)
       RETURNING id, order_number`,
      [location.id, staff.id, subtotal, tax, tip, total]
    );
    const order = orderRows[0];

    // ---- Insert lines, modifiers, addons ----
    for (const line of pricedLines) {
      const { rows: oiRows } = await client.query(
        `INSERT INTO order_items (order_id, item_id, variant_id, quantity, unit_price, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [order.id, line.itemId, line.variantId, line.quantity, line.unitPrice, line.notes]
      );
      const orderItemId = oiRows[0].id;

      for (const mod of line.modifiers) {
        await client.query(
          `INSERT INTO order_item_modifiers (order_item_id, modifier_option_id, price_delta, quantity)
           VALUES ($1, $2, $3, $4)`,
          [orderItemId, mod.optionId, mod.priceDelta, mod.quantity]
        );
      }

      for (const addon of line.addons) {
        await client.query(
          `INSERT INTO order_item_addons (order_item_id, addon_item_id, quantity, unit_price, is_complimentary)
           VALUES ($1, $2, $3, $4, $5)`,
          [orderItemId, addon.addonItemId, addon.quantity, addon.unitPrice, addon.isComplimentary]
        );
      }
    }

    // ---- Insert payment (mocked — captured immediately, no processor) ----
    await client.query(
      `INSERT INTO payments (order_id, method, amount, status)
       VALUES ($1, $2, $3, 'captured')`,
      [order.id, paymentMethod, total]
    );

    await client.query("COMMIT");
    return res.status(201).json({
      id: order.id,
      order_number: order.order_number,
      subtotal,
      tax,
      tip,
      total,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Order creation failed:", err);
    return res.status(500).json({ error: "Failed to create order" });
  } finally {
    client.release();
  }
});

// --------------- Kitchen Display System (KDS) ---------------
// These two routes are additive and intentionally price/customer-free.
// KDS is a no-auth "open book" screen, so neither route has auth middleware.

// Fetch orders (by id) in the nested shape the KDS renders. Deliberately
// omits ALL prices + customer/payment fields — the kitchen never sees those.
// Orders are returned in the SAME order as `orderIds` — the caller decides
// sort (the live queue passes FIFO oldest-first; history passes most-recent
// -first). A planned elapsed-time UI depends on the live queue's ordering, so
// don't change the caller's sort there without flagging.
// Pass { includeCompletedAt: true } to add completed_at to each order (used by
// history); the live queue omits it to keep its response unchanged.
//
// Per item we split the modifiers into distinct buckets:
//   - selected_options[]: choices from REQUIRED groups (Format=Burrito/Bowl,
//     Base=Nachos/Fries, Protein, Choose 3 Proteins, ...) — these define what
//     the item fundamentally IS, so they get { group, choice } and are never
//     run through the optional add/remove diff. One entry per choice made.
//   - removed_ingredients[]: default options from NON-required groups with NO
//     matching order row (the "NO onions" cases) — name only
//   - added_modifiers[]: non-default options from NON-required groups present
//     on the line — name + quantity, no price
//   - addons[]: name, quantity, is_complimentary — no price
// Kept defaults (default AND present) are the normal build and appear in none
// of these. All output is price-free.
async function fetchKdsOrders(client, orderIds, { includeCompletedAt = false } = {}) {
  if (orderIds.length === 0) return [];

  const { rows: orders } = await client.query(
    `SELECT id, order_number, status, fulfillment_type, created_at, completed_at
       FROM orders
      WHERE id = ANY($1::uuid[])`,
    [orderIds]
  );

  const { rows: items } = await client.query(
    `SELECT oi.id, oi.order_id, oi.item_id, oi.quantity, oi.notes, oi.status,
            mi.name AS item_name, iv.name AS variant_name
       FROM order_items oi
       JOIN menu_items mi ON mi.id = oi.item_id
       LEFT JOIN item_variants iv ON iv.id = oi.variant_id
      WHERE oi.order_id = ANY($1::uuid[])
      ORDER BY oi.created_at ASC`,
    [orderIds]
  );

  const itemIds = items.map((i) => i.id);
  const menuItemIds = [...new Set(items.map((i) => i.item_id))];

  // Modifiers actually on each order line, tagged with their group's name +
  // required flag (to split required choices out) and whether they're a
  // default (standard) ingredient or a customer addition.
  const { rows: mods } = itemIds.length
    ? await client.query(
        `SELECT oim.order_item_id, oim.modifier_option_id,
                mo.name AS option_name, mo.default_selected, oim.quantity,
                mg.name AS group_name, mg.required AS group_required
           FROM order_item_modifiers oim
           JOIN modifier_options mo ON mo.id = oim.modifier_option_id
           JOIN modifier_groups mg ON mg.id = mo.group_id
          WHERE oim.order_item_id = ANY($1::uuid[])
          ORDER BY mo.sort_order`,
        [itemIds]
      )
    : { rows: [] };

  // The default modifier set for each menu item (config, not order-specific):
  // every option flagged default_selected in a NON-required group linked to
  // that item. Required groups are excluded here so a mutually-exclusive
  // choice can never be reported as a "removed" ingredient.
  const { rows: defaults } = menuItemIds.length
    ? await client.query(
        `SELECT img.item_id, mo.id AS option_id, mo.name AS option_name
           FROM item_modifier_groups img
           JOIN modifier_groups mg ON mg.id = img.modifier_group_id
           JOIN modifier_options mo ON mo.group_id = mg.id
          WHERE img.item_id = ANY($1::uuid[])
            AND mg.required = false
            AND mo.default_selected = true
            AND mo.active = true
          ORDER BY mo.sort_order`,
        [menuItemIds]
      )
    : { rows: [] };

  const { rows: addons } = itemIds.length
    ? await client.query(
        `SELECT oa.order_item_id, mi.name AS addon_name,
                oa.quantity, oa.is_complimentary
           FROM order_item_addons oa
           JOIN menu_items mi ON mi.id = oa.addon_item_id
          WHERE oa.order_item_id = ANY($1::uuid[])
          ORDER BY oa.is_complimentary DESC`,
        [itemIds]
      )
    : { rows: [] };

  // Per order line: option ids present, required-group choices, and the added
  // (non-default, non-required) modifiers.
  const presentOptByItem = {}; // order_item_id -> Set(option_id)
  const selectedByItem = {}; // order_item_id -> [{ group, choice }]
  const addedByItem = {}; // order_item_id -> [{ name, quantity }]
  for (const m of mods) {
    (presentOptByItem[m.order_item_id] ||= new Set()).add(m.modifier_option_id);
    if (m.group_required) {
      // Required choice — defines what the item IS. Surfaced on its own; never
      // an optional add and never a removal. One entry per choice made.
      (selectedByItem[m.order_item_id] ||= []).push({
        group: m.group_name,
        choice: m.option_name,
      });
    } else if (!m.default_selected) {
      (addedByItem[m.order_item_id] ||= []).push({
        name: m.option_name,
        quantity: m.quantity,
      });
    }
  }

  // Per menu item: its full default option set (for the removed-ingredient diff).
  const defaultsByMenuItem = {}; // item_id -> [{ option_id, name }]
  for (const d of defaults) {
    (defaultsByMenuItem[d.item_id] ||= []).push({
      option_id: d.option_id,
      name: d.option_name,
    });
  }

  const addonsByItem = {};
  for (const a of addons) {
    (addonsByItem[a.order_item_id] ||= []).push({
      name: a.addon_name,
      quantity: a.quantity,
      is_complimentary: a.is_complimentary,
    });
  }

  const itemsByOrder = {};
  for (const it of items) {
    const present = presentOptByItem[it.id] || new Set();
    const itemDefaults = defaultsByMenuItem[it.item_id] || [];
    const removed_ingredients = itemDefaults
      .filter((d) => !present.has(d.option_id))
      .map((d) => d.name);

    (itemsByOrder[it.order_id] ||= []).push({
      id: it.id,
      name: it.item_name,
      variant: it.variant_name, // null when the item has no variant
      quantity: it.quantity,
      notes: it.notes,
      status: it.status,
      selected_options: selectedByItem[it.id] || [],
      removed_ingredients,
      added_modifiers: addedByItem[it.id] || [],
      addons: addonsByItem[it.id] || [],
    });
  }

  // Build a lookup, then emit in the caller's requested order (order of orderIds).
  const byId = {};
  for (const o of orders) {
    byId[o.id] = {
      id: o.id,
      order_number: o.order_number,
      status: o.status,
      fulfillment_type: o.fulfillment_type,
      created_at: o.created_at,
      ...(includeCompletedAt ? { completed_at: o.completed_at } : {}),
      items: itemsByOrder[o.id] || [],
    };
  }
  return orderIds.map((id) => byId[id]).filter(Boolean);
}

const KDS_ALLOWED_STATUSES = ["open", "preparing", "ready", "completed", "cancelled"];

// GET /api/orders?status=open,preparing  (defaults to open,preparing)
app.get("/api/orders", async (req, res) => {
  const statusParam = (req.query.status ?? "open,preparing").toString();
  const statuses = statusParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const invalid = statuses.filter((s) => !KDS_ALLOWED_STATUSES.includes(s));
  if (statuses.length === 0 || invalid.length > 0) {
    return res.status(400).json({
      error:
        invalid.length > 0
          ? `Invalid status value(s): ${invalid.join(", ")}`
          : "No status values provided",
    });
  }

  const client = await pool.connect();
  try {
    // KDS is per-location; today there is a single active location.
    const { rows: locRows } = await client.query(
      "SELECT id FROM locations WHERE active = true ORDER BY created_at LIMIT 1"
    );
    if (locRows.length === 0) {
      return res.status(500).json({ error: "No active location" });
    }
    const locationId = locRows[0].id;

    const { rows: idRows } = await client.query(
      `SELECT id FROM orders
        WHERE location_id = $1 AND status::text = ANY($2::text[])
        ORDER BY created_at ASC`, // FIFO oldest-first
      [locationId, statuses]
    );

    const orders = await fetchKdsOrders(client, idRows.map((r) => r.id));
    res.json(orders);
  } catch (err) {
    console.error("KDS list failed:", err.message);
    res.status(500).json({ error: "Failed to fetch orders" });
  } finally {
    client.release();
  }
});

// GET /api/orders/history?sinceHours=4  (default 4)
// Recently-completed (status='ready') orders whose completed_at falls within
// the last N hours, MOST-RECENT-FIRST (opposite of the live queue). Same nested
// price-free shape, plus created_at + completed_at so the frontend can compute
// prep time (placed → ready). No auth, single active location.
app.get("/api/orders/history", async (req, res) => {
  const sinceHours = req.query.sinceHours === undefined ? 4 : Number(req.query.sinceHours);
  if (!Number.isFinite(sinceHours) || sinceHours <= 0) {
    return res.status(400).json({ error: "sinceHours must be a positive number" });
  }

  const client = await pool.connect();
  try {
    const { rows: locRows } = await client.query(
      "SELECT id FROM locations WHERE active = true ORDER BY created_at LIMIT 1"
    );
    if (locRows.length === 0) {
      return res.status(500).json({ error: "No active location" });
    }
    const locationId = locRows[0].id;

    const { rows: idRows } = await client.query(
      `SELECT id FROM orders
        WHERE location_id = $1
          AND status = 'ready'
          AND completed_at >= now() - ($2::numeric * interval '1 hour')
        ORDER BY completed_at DESC`, // most-recent-first
      [locationId, sinceHours]
    );

    const orders = await fetchKdsOrders(client, idRows.map((r) => r.id), {
      includeCompletedAt: true,
    });
    res.json(orders);
  } catch (err) {
    console.error("KDS history failed:", err.message);
    res.status(500).json({ error: "Failed to fetch order history" });
  } finally {
    client.release();
  }
});

// PATCH /api/orders/:id/status   body: { status: "preparing" | "ready" }
// Advances the whole order one step and keeps order_items.status in lockstep,
// all inside one transaction so the two can never drift out of sync.
app.patch("/api/orders/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};

  if (status !== "preparing" && status !== "ready") {
    return res.status(400).json({ error: "status must be 'preparing' or 'ready'" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the order row for the duration of the transition
    const { rows } = await client.query(
      "SELECT status FROM orders WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    const current = rows[0].status;
    // Only forward, one step at a time: open→preparing, preparing→ready
    const allowed =
      (current === "open" && status === "preparing") ||
      (current === "preparing" && status === "ready");
    if (!allowed) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `Cannot transition order from '${current}' to '${status}'`,
      });
    }

    // Update the order. 'ready' is treated as complete → stamp completed_at.
    if (status === "ready") {
      await client.query(
        "UPDATE orders SET status = $1, completed_at = now() WHERE id = $2",
        [status, id]
      );
    } else {
      await client.query("UPDATE orders SET status = $1 WHERE id = $2", [status, id]);
    }

    // Cascade the same status to every line (no per-item status in this UI —
    // order_items.status must always match orders.status after this call).
    // Mapping is 1:1: preparing→preparing, ready→ready.
    await client.query("UPDATE order_items SET status = $1 WHERE order_id = $2", [
      status,
      id,
    ]);

    await client.query("COMMIT");

    const [order] = await fetchKdsOrders(client, [id]);
    res.json(order);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("KDS status update failed:", err.message);
    res.status(500).json({ error: "Failed to update order status" });
  } finally {
    client.release();
  }
});

// --------------- Back Office: menu management ---------------
// Every route here re-verifies ON THE SERVER that the caller is an active
// owner/admin (403 otherwise) — same principle as checkout's server-side
// price recomputation: never trust the frontend to have hidden the button.

// Resolve staffId → active staff row with one of `allowedRoles`, or throw
// 401/403. The requester's role is ALWAYS looked up in the DB — a role sent
// in the request body/headers is never trusted.
async function requireBackofficeStaff(staffId, allowedRoles = ["owner", "admin"]) {
  const denied = `Access restricted to ${allowedRoles.join("/")}`;
  if (!staffId || typeof staffId !== "string") {
    throw new HttpError(401, "staffId is required");
  }
  let rows;
  try {
    ({ rows } = await pool.query(
      "SELECT id, name, role FROM staff WHERE id = $1 AND active = true",
      [staffId]
    ));
  } catch {
    // Malformed UUID etc. — treat as unknown staff
    throw new HttpError(403, denied);
  }
  const staff = rows[0];
  if (!staff || !allowedRoles.includes(staff.role)) {
    throw new HttpError(403, denied);
  }
  return staff;
}

const sendHttpError = (res, err, fallbackMsg) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(fallbackMsg, err);
  return res.status(500).json({ error: fallbackMsg });
};

// GET /api/backoffice/menu?staffId=...
// Full menu tree INCLUDING inactive items (the public /api/menu/full keeps
// hiding them) — owners need to see and reactivate 86'd items.
app.get("/api/backoffice/menu", async (req, res) => {
  try {
    await requireBackofficeStaff(req.query.staffId);

    const { rows: categories } = await pool.query(
      "SELECT id, name, sort_order FROM menu_categories WHERE active = true ORDER BY sort_order"
    );
    const { rows: items } = await pool.query(
      `SELECT id, category_id, name, description, base_price, active, sort_order
         FROM menu_items ORDER BY sort_order, name`
    );
    const { rows: variants } = await pool.query(
      `SELECT id, item_id, name, price, active, sort_order
         FROM item_variants WHERE active = true ORDER BY sort_order`
    );

    const variantsByItem = {};
    for (const v of variants) (variantsByItem[v.item_id] ||= []).push(v);

    const itemsByCat = {};
    for (const it of items) {
      (itemsByCat[it.category_id] ||= []).push({
        ...it,
        variants: variantsByItem[it.id] || [],
      });
    }

    res.json(categories.map((c) => ({ ...c, items: itemsByCat[c.id] || [] })));
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch back office menu");
  }
});

// Shared field validation for menu item create/update
function validateItemFields({ name, base_price }) {
  if (typeof name !== "string" || !name.trim()) {
    throw new HttpError(400, "name is required");
  }
  const price = Number(base_price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new HttpError(400, "base_price must be a positive number");
  }
  return { name: name.trim(), price };
}

// PUT /api/backoffice/menu-items/:id
// Body: { staffId, name, description, base_price, active }
app.put("/api/backoffice/menu-items/:id", async (req, res) => {
  try {
    const { staffId, description, active } = req.body || {};
    await requireBackofficeStaff(staffId);
    const { name, price } = validateItemFields(req.body || {});
    if (typeof active !== "boolean") {
      throw new HttpError(400, "active must be a boolean");
    }

    const { rows } = await pool.query(
      `UPDATE menu_items
          SET name = $1, description = $2, base_price = $3, active = $4
        WHERE id = $5
        RETURNING id, category_id, name, description, base_price, active, sort_order`,
      [name, description || null, price, active, req.params.id]
    );
    if (rows.length === 0) throw new HttpError(404, "Menu item not found");
    res.json(rows[0]);
  } catch (err) {
    sendHttpError(res, err, "Failed to update menu item");
  }
});

// POST /api/backoffice/menu-items
// Body: { staffId, category_id, name, description, base_price }
app.post("/api/backoffice/menu-items", async (req, res) => {
  try {
    const { staffId, category_id, description } = req.body || {};
    await requireBackofficeStaff(staffId);
    const { name, price } = validateItemFields(req.body || {});
    if (!category_id || typeof category_id !== "string") {
      throw new HttpError(400, "category_id is required");
    }

    const { rows: catRows } = await pool.query(
      "SELECT id FROM menu_categories WHERE id = $1 AND active = true",
      [category_id]
    );
    if (catRows.length === 0) throw new HttpError(400, "Unknown category");

    const { rows } = await pool.query(
      `INSERT INTO menu_items (category_id, name, description, base_price, active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, category_id, name, description, base_price, active, sort_order`,
      [category_id, name, description || null, price]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    sendHttpError(res, err, "Failed to create menu item");
  }
});

// Shared field validation for variant create/update
function validateVariantFields({ name, price }) {
  if (typeof name !== "string" || !name.trim()) {
    throw new HttpError(400, "name is required");
  }
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) {
    throw new HttpError(400, "price must be a positive number");
  }
  return { name: name.trim(), price: p };
}

// PUT /api/backoffice/item-variants/:id
// Body: { staffId, name, price }
app.put("/api/backoffice/item-variants/:id", async (req, res) => {
  try {
    await requireBackofficeStaff((req.body || {}).staffId);
    const { name, price } = validateVariantFields(req.body || {});

    const { rows } = await pool.query(
      `UPDATE item_variants SET name = $1, price = $2
        WHERE id = $3
        RETURNING id, item_id, name, price, active, sort_order`,
      [name, price, req.params.id]
    );
    if (rows.length === 0) throw new HttpError(404, "Variant not found");
    res.json(rows[0]);
  } catch (err) {
    sendHttpError(res, err, "Failed to update variant");
  }
});

// POST /api/backoffice/item-variants
// Body: { staffId, item_id, name, price }
app.post("/api/backoffice/item-variants", async (req, res) => {
  try {
    const { staffId, item_id } = req.body || {};
    await requireBackofficeStaff(staffId);
    const { name, price } = validateVariantFields(req.body || {});
    if (!item_id || typeof item_id !== "string") {
      throw new HttpError(400, "item_id is required");
    }

    const { rows: itemRows } = await pool.query(
      "SELECT id FROM menu_items WHERE id = $1",
      [item_id]
    );
    if (itemRows.length === 0) throw new HttpError(400, "Unknown menu item");

    const { rows } = await pool.query(
      `INSERT INTO item_variants (item_id, name, price)
       VALUES ($1, $2, $3)
       RETURNING id, item_id, name, price, active, sort_order`,
      [item_id, name, price]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    sendHttpError(res, err, "Failed to create variant");
  }
});

// --------------- Back Office: staff management ---------------
// All routes verify the REQUESTER's role server-side (owner/admin/manager),
// then apply hierarchy protection based on the TARGET row's current role:
//   target owner   → only an owner may act on it
//   target admin   → only owner or admin (managers can't touch admin rows)
//   target manager/cashier/kitchen → owner, admin, or manager
// Raw PINs are hashed server-side and never logged, echoed, or returned.

const STAFF_MANAGER_ROLES = ["owner", "admin", "manager"];
const STAFF_ROLES = ["owner", "admin", "manager", "cashier", "kitchen"];
// Columns safe to return — pin_hash is NEVER selected.
const STAFF_SAFE_COLS =
  "id, location_id, name, title, phone, email, role, hourly_rate, hire_date, active, created_at";

function canManageTarget(requesterRole, targetRole) {
  if (targetRole === "owner") return requesterRole === "owner";
  if (targetRole === "admin") return requesterRole === "owner" || requesterRole === "admin";
  return true; // manager/cashier/kitchen rows
}

// Only owners may hand out the owner or admin role (create OR promote) —
// prevents privilege escalation by admins/managers.
function assertRoleAssignable(requesterRole, newRole) {
  if ((newRole === "owner" || newRole === "admin") && requesterRole !== "owner") {
    throw new HttpError(403, "Only an owner can assign the owner or admin role");
  }
}

function validatePin(pin) {
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
    throw new HttpError(400, "PIN must be exactly 4 digits");
  }
}

// PINs must be unique among ACTIVE staff (login matches the PIN against all
// active hashes, so a duplicate would log in as whoever matches first).
// Compares against every active hash; excludeId skips the row being updated.
async function assertPinAvailable(pin, excludeId = null) {
  const { rows } = await pool.query(
    "SELECT id, pin_hash FROM staff WHERE active = true"
  );
  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue;
    if (await bcrypt.compare(pin, row.pin_hash)) {
      throw new HttpError(409, "That PIN is already in use — choose another");
    }
  }
}

// GET /api/backoffice/staff?staffId=...
// All staff, active AND inactive, without pin_hash.
app.get("/api/backoffice/staff", async (req, res) => {
  try {
    await requireBackofficeStaff(req.query.staffId, STAFF_MANAGER_ROLES);
    const { rows } = await pool.query(
      `SELECT ${STAFF_SAFE_COLS} FROM staff
        ORDER BY active DESC, array_position(ARRAY['owner','admin','manager','cashier','kitchen'], role::text), name`
    );
    res.json(rows);
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch staff");
  }
});

// POST /api/backoffice/staff
// Body: { staffId, name, role, hourly_rate, pin }
app.post("/api/backoffice/staff", async (req, res) => {
  try {
    const { staffId, name, role, hourly_rate, pin } = req.body || {};
    const requester = await requireBackofficeStaff(staffId, STAFF_MANAGER_ROLES);

    if (typeof name !== "string" || !name.trim()) {
      throw new HttpError(400, "name is required");
    }
    if (!STAFF_ROLES.includes(role)) {
      throw new HttpError(400, "role must be one of owner/admin/manager/cashier/kitchen");
    }
    assertRoleAssignable(requester.role, role);
    const rate = Number(hourly_rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new HttpError(400, "hourly_rate must be a positive number");
    }
    validatePin(pin);
    await assertPinAvailable(pin);

    // Owners span all locations (location_id NULL, per schema design);
    // everyone else is scoped to the single active location.
    let locationId = null;
    if (role !== "owner") {
      const { rows: locRows } = await pool.query(
        "SELECT id FROM locations WHERE active = true ORDER BY created_at LIMIT 1"
      );
      if (locRows.length === 0) throw new HttpError(500, "No active location");
      locationId = locRows[0].id;
    }

    const pinHash = await bcrypt.hash(pin, 10);
    const title = role.charAt(0).toUpperCase() + role.slice(1);
    const { rows } = await pool.query(
      `INSERT INTO staff (location_id, name, title, pin_hash, role, hourly_rate, active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING ${STAFF_SAFE_COLS}`,
      [locationId, name.trim(), title, pinHash, role, rate]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    sendHttpError(res, err, "Failed to create staff member");
  }
});

// Fetch the target row + enforce hierarchy, shared by the two PUT routes.
async function requireManagedTarget(requester, targetId) {
  let rows;
  try {
    ({ rows } = await pool.query(
      "SELECT id, name, role, active FROM staff WHERE id = $1",
      [targetId]
    ));
  } catch {
    throw new HttpError(404, "Staff member not found");
  }
  const target = rows[0];
  if (!target) throw new HttpError(404, "Staff member not found");
  if (!canManageTarget(requester.role, target.role)) {
    throw new HttpError(
      403,
      `Your role (${requester.role}) cannot manage a staff member with role '${target.role}'`
    );
  }
  return target;
}

// PUT /api/backoffice/staff/:id
// Body: { staffId, name?, role?, hourly_rate?, active? } — partial update.
// Hierarchy protection applies to EVERY field, not just `active`.
// Deactivation = active:false; staff rows are never hard-deleted (historical
// orders reference them).
app.put("/api/backoffice/staff/:id", async (req, res) => {
  try {
    const body = req.body || {};
    const requester = await requireBackofficeStaff(body.staffId, STAFF_MANAGER_ROLES);
    await requireManagedTarget(requester, req.params.id);

    const sets = [];
    const vals = [];
    let i = 1;

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        throw new HttpError(400, "name must be a non-empty string");
      }
      sets.push(`name = $${i++}`);
      vals.push(body.name.trim());
    }
    if (body.role !== undefined) {
      if (!STAFF_ROLES.includes(body.role)) {
        throw new HttpError(400, "role must be one of owner/admin/manager/cashier/kitchen");
      }
      assertRoleAssignable(requester.role, body.role);
      sets.push(`role = $${i++}`);
      vals.push(body.role);
    }
    if (body.hourly_rate !== undefined) {
      const rate = Number(body.hourly_rate);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new HttpError(400, "hourly_rate must be a positive number");
      }
      sets.push(`hourly_rate = $${i++}`);
      vals.push(rate);
    }
    if (body.active !== undefined) {
      if (typeof body.active !== "boolean") {
        throw new HttpError(400, "active must be a boolean");
      }
      sets.push(`active = $${i++}`);
      vals.push(body.active);
    }
    if (sets.length === 0) {
      throw new HttpError(400, "No updatable fields provided");
    }

    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE staff SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${STAFF_SAFE_COLS}`,
      vals
    );
    res.json(rows[0]);
  } catch (err) {
    sendHttpError(res, err, "Failed to update staff member");
  }
});

// PUT /api/backoffice/staff/:id/pin
// Body: { staffId, pin } — validate, hash server-side, never echo the pin.
app.put("/api/backoffice/staff/:id/pin", async (req, res) => {
  try {
    const { staffId, pin } = req.body || {};
    const requester = await requireBackofficeStaff(staffId, STAFF_MANAGER_ROLES);
    const target = await requireManagedTarget(requester, req.params.id);

    validatePin(pin);
    await assertPinAvailable(pin, target.id);

    const pinHash = await bcrypt.hash(pin, 10);
    await pool.query("UPDATE staff SET pin_hash = $1 WHERE id = $2", [
      pinHash,
      target.id,
    ]);
    res.json({ success: true, id: target.id });
  } catch (err) {
    sendHttpError(res, err, "Failed to reset PIN");
  }
});

// --------------- Start server ---------------
app.listen(PORT, () => {
  console.log(`Narcos Tacos POS API running on http://localhost:${PORT}`);
});
