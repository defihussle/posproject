-- ============================================================
-- Menu restructure — split combined categories, promote proteins to items
-- ------------------------------------------------------------
-- WHY
--   "Burritos & Bowls" and "Nachos & Fries" each crammed two menu concepts
--   into one category, with the real choice hidden in a modifier group
--   (Format / Base). And Quesadillas/Burritos/Bowls kept every protein as a
--   VARIANT of one parent item, so an owner editing "the chicken burrito
--   price" had to dig into a variant list, and a cashier saw one card where
--   the menu board shows six.
--
--   After this, each protein is its own item — the same shape Birria Tacos
--   already used ("Birria Tacos (3pc)" and "Single Birria Taco" as siblings).
--
-- NOTHING IS DELETED
--   order_items.item_id and .variant_id point at these rows, so the old
--   parents/categories are deactivated, never removed — same "never
--   hard-delete history" rule as staff and devices. The menu API filters
--   active = true, so they disappear from the POS while every past order,
--   report and refund still resolves its item name.
--
-- MODIFIER GROUPS ARE SHARED, NOT COPIED
--   item_modifier_groups is many-to-many, so all six quesadilla items point
--   at the SAME Ingredients group and all twelve burrito/bowl items share
--   Toppings + Add-ons. An owner editing a topping edits it once. Format and
--   Base are deactivated — the category now answers what they used to ask.
--
-- Idempotent: re-running changes nothing.
-- ============================================================

BEGIN;

-- ---------- 0. Normalize protein names FIRST (order independence) ----------
-- The new item names are derived from variant names, so this migration would
-- produce "Pollo Burrito" instead of "Chicken (Pollo) Burrito" if it ran
-- before menu_ux_enhancements.sql — which it does when a fresh database
-- applies database/*.sql in filename order ("menu_restructure" sorts before
-- "menu_ux_enhancements"). These are the same idempotent renames that file
-- performs, repeated here so the outcome does not depend on ordering. On an
-- already-migrated database every one of them matches zero rows.
UPDATE item_variants SET name = 'Chicken (Pollo)'              WHERE name = 'Pollo';
UPDATE item_variants SET name = 'Fish (Pescado)'               WHERE name = 'Pescado';
UPDATE item_variants SET name = 'Steak (Carne Asada)'          WHERE name = 'Carne Asada';
UPDATE item_variants SET name = 'Shrimp (Camaron)'             WHERE name = 'Camaron';
UPDATE item_variants SET name = 'Pulled Beef (Barbacoa)'       WHERE name = 'Barbacoa';
UPDATE item_variants SET name = 'Plant-Based (Veggie Chorizo)' WHERE name = 'Veggie Chorizo';

-- ---------- 1. New categories ----------
INSERT INTO menu_categories (location_id, name, sort_order)
SELECT l.id, v.name, v.sort_order
  FROM locations l
 CROSS JOIN (VALUES ('Burritos', 3), ('Bowls', 4), ('Nachos', 6), ('Fries', 7))
       AS v(name, sort_order)
 WHERE l.active = true
   AND NOT EXISTS (
     SELECT 1 FROM menu_categories c
      WHERE c.location_id = l.id AND c.name = v.name
   );

-- Singular -> plural, matching the other category names.
UPDATE menu_categories SET name = 'Quesadillas' WHERE name = 'Quesadilla';

-- ---------- 2. Re-sort so the new categories slot in naturally ----------
UPDATE menu_categories c SET sort_order = v.sort_order
  FROM (VALUES
    ('Tacos', 1), ('Birria Tacos', 2), ('Burritos', 3), ('Bowls', 4),
    ('Quesadillas', 5), ('Nachos', 6), ('Fries', 7), ('Elotes', 8),
    ('Sides', 9), ('Desserts', 10), ('Drinks', 11), ('Add-ons', 12)
  ) AS v(name, sort_order)
 WHERE c.name = v.name AND c.sort_order IS DISTINCT FROM v.sort_order;

-- ---------- 3. Quesadillas: one item per protein ----------
-- Names come straight from the variant ("Cheese" -> "Cheese Quesadilla",
-- "Chicken (Pollo)" -> "Chicken (Pollo) Quesadilla"), price from the variant
-- price, order from the variant order — so the new cards read in the same
-- sequence staff already know.
INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
SELECT c.id,
       v.name || ' Quesadilla',
       p.description,
       v.price,
       v.sort_order
  FROM menu_items p
  JOIN item_variants v ON v.item_id = p.id
  JOIN menu_categories c ON c.name = 'Quesadillas'
 WHERE p.name = 'Quesadilla'
   AND NOT EXISTS (
     SELECT 1 FROM menu_items x
      WHERE x.category_id = c.id AND x.name = v.name || ' Quesadilla'
   );

-- ---------- 4. Burritos and Bowls: one item per protein, in each ----------
-- Category is plural, the item name is singular: the Burritos category holds
-- "Chicken (Pollo) Burrito". description is left NULL deliberately — the old
-- "Choice of format, same price either way" describes a choice that no longer
-- exists, and inventing replacement menu copy isn't this migration's job.
INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
SELECT c.id,
       v.name || ' ' || f.suffix,
       NULL,
       v.price,
       v.sort_order
  FROM menu_items p
  JOIN item_variants v ON v.item_id = p.id
 CROSS JOIN (VALUES ('Burritos', 'Burrito'), ('Bowls', 'Bowl')) AS f(cat, suffix)
  JOIN menu_categories c ON c.name = f.cat
 WHERE p.name = 'Burrito or Bowl'
   AND NOT EXISTS (
     SELECT 1 FROM menu_items x
      WHERE x.category_id = c.id AND x.name = v.name || ' ' || f.suffix
   );

-- ---------- 5. Nachos and Fries: one item each, proteins stay variants ----------
INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
SELECT c.id, c.name || ' Supreme', p.description, p.base_price, 1
  FROM menu_items p
  JOIN menu_categories c ON c.name IN ('Nachos', 'Fries')
 WHERE p.name = 'Nachos or Fries Supreme'
   AND NOT EXISTS (
     SELECT 1 FROM menu_items x
      WHERE x.category_id = c.id AND x.name = c.name || ' Supreme'
   );

-- Fresh variant rows for the new items. The originals stay bound to the
-- deactivated parent because order_items.variant_id still references them.
INSERT INTO item_variants (item_id, name, price, sort_order)
SELECT n.id, v.name, v.price, v.sort_order
  FROM menu_items p
  JOIN item_variants v ON v.item_id = p.id
  JOIN menu_items n ON n.name IN ('Nachos Supreme', 'Fries Supreme')
 WHERE p.name = 'Nachos or Fries Supreme'
   AND NOT EXISTS (
     SELECT 1 FROM item_variants x WHERE x.item_id = n.id AND x.name = v.name
   );

-- ---------- 6. Attach the SHARED modifier groups ----------
-- Quesadilla Ingredients -> every new quesadilla item.
INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
SELECT n.id, img.modifier_group_id, img.sort_order
  FROM menu_items n
  JOIN menu_categories c ON c.id = n.category_id AND c.name = 'Quesadillas'
  JOIN menu_items p ON p.name = 'Quesadilla'
  JOIN item_modifier_groups img ON img.item_id = p.id
 WHERE NOT EXISTS (
   SELECT 1 FROM item_modifier_groups x
    WHERE x.item_id = n.id AND x.modifier_group_id = img.modifier_group_id
 );

-- Burrito/Bowl Toppings + Add-ons -> every new burrito and bowl item.
-- Format is excluded: the category now says whether it's a burrito or a bowl.
INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
SELECT n.id, img.modifier_group_id, img.sort_order
  FROM menu_items n
  JOIN menu_categories c ON c.id = n.category_id AND c.name IN ('Burritos', 'Bowls')
  JOIN menu_items p ON p.name = 'Burrito or Bowl'
  JOIN item_modifier_groups img ON img.item_id = p.id
  JOIN modifier_groups g ON g.id = img.modifier_group_id AND g.name <> 'Format'
 WHERE NOT EXISTS (
   SELECT 1 FROM item_modifier_groups x
    WHERE x.item_id = n.id AND x.modifier_group_id = img.modifier_group_id
 );

-- Nachos/Fries Ingredients -> the two new Supreme items. Base is excluded for
-- the same reason as Format.
INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
SELECT n.id, img.modifier_group_id, img.sort_order
  FROM menu_items n
  JOIN menu_items p ON p.name = 'Nachos or Fries Supreme'
  JOIN item_modifier_groups img ON img.item_id = p.id
  JOIN modifier_groups g ON g.id = img.modifier_group_id AND g.name <> 'Base'
 WHERE n.name IN ('Nachos Supreme', 'Fries Supreme')
   AND NOT EXISTS (
     SELECT 1 FROM item_modifier_groups x
      WHERE x.item_id = n.id AND x.modifier_group_id = img.modifier_group_id
   );

-- ---------- 7. Retire the old structure (deactivate, never delete) ----------
UPDATE menu_items SET active = false
 WHERE name IN ('Quesadilla', 'Burrito or Bowl', 'Nachos or Fries Supreme');

UPDATE menu_categories SET active = false
 WHERE name IN ('Burritos & Bowls', 'Nachos & Fries');

-- Format/Base are now attached to nothing. The option rows stay for
-- order_item_modifiers history; deactivating the group keeps them off the POS.
UPDATE modifier_groups SET active = false WHERE name IN ('Format', 'Base');

COMMIT;
