-- ============================================================
-- Narcos Tacos — Menu UX Enhancements
-- 1. Adds quantity-stepper support for modifier options
-- 2. Adds default-checked support (for standard/included toppings)
-- 3. Translates protein variant names for new-employee clarity
-- 4. Renames "Dulce de Leche" -> "Caramel"
-- ============================================================

-- --------------------------------------------------------------
-- 1. SCHEMA CHANGES
-- --------------------------------------------------------------

-- How many of this option can be added (1 = simple on/off toggle,
-- >1 = show a +/- stepper up to this number)
ALTER TABLE modifier_options
    ADD COLUMN max_quantity INTEGER NOT NULL DEFAULT 1;

-- Whether this option should start pre-selected (e.g. standard toppings
-- that come on an item by default, which the customer can remove)
ALTER TABLE modifier_options
    ADD COLUMN default_selected BOOLEAN NOT NULL DEFAULT FALSE;

-- How many of this modifier option were chosen on a given order line
-- (previously implied to always be 1 — now supports "2x Extra Taco")
ALTER TABLE order_item_modifiers
    ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;

-- --------------------------------------------------------------
-- 2. ENABLE QUANTITY STEPPER on the two approved options
-- --------------------------------------------------------------

UPDATE modifier_options
SET max_quantity = 5
WHERE name = 'Extra Taco'
  AND group_id = (SELECT id FROM modifier_groups WHERE name = 'Taco Extras');

UPDATE modifier_options
SET max_quantity = 5
WHERE group_id = (SELECT id FROM modifier_groups WHERE name = 'Dipping Sauce');

-- --------------------------------------------------------------
-- 3. RENAME "Dulce de Leche" -> "Caramel"
-- --------------------------------------------------------------

UPDATE modifier_options
SET name = 'Caramel'
WHERE name = 'Dulce de Leche';

-- --------------------------------------------------------------
-- 4. DEFAULT-CHECKED TOPPINGS (Burritos & Bowls)
-- Customer sees them already included; unchecking = removing
-- --------------------------------------------------------------

UPDATE modifier_options
SET default_selected = true
WHERE group_id = (SELECT id FROM modifier_groups WHERE name = 'Toppings');

-- --------------------------------------------------------------
-- 5. PROTEIN NAME TRANSLATIONS (item_variants — used by Tacos,
-- Burritos & Bowls, Quesadilla, Nachos or Fries Supreme)
-- --------------------------------------------------------------

UPDATE item_variants SET name = 'Chicken (Pollo)'          WHERE name = 'Pollo';
UPDATE item_variants SET name = 'Fish (Pescado)'           WHERE name = 'Pescado';
UPDATE item_variants SET name = 'Steak (Carne Asada)'      WHERE name = 'Carne Asada';
UPDATE item_variants SET name = 'Shrimp (Camaron)'         WHERE name = 'Camaron';
UPDATE item_variants SET name = 'Pulled Beef (Barbacoa)'   WHERE name = 'Barbacoa';
UPDATE item_variants SET name = 'Plant-Based (Veggie Chorizo)' WHERE name = 'Veggie Chorizo';

-- Same translations for the Mix & Match "Choose 3 Proteins" modifier group,
-- since customers pick proteins there too
UPDATE modifier_options SET name = 'Chicken (Pollo)'
    WHERE name = 'Pollo' AND group_id = (SELECT id FROM modifier_groups WHERE name = 'Choose 3 Proteins');
UPDATE modifier_options SET name = 'Fish (Pescado)'
    WHERE name = 'Pescado' AND group_id = (SELECT id FROM modifier_groups WHERE name = 'Choose 3 Proteins');
UPDATE modifier_options SET name = 'Steak (Carne Asada)'
    WHERE name = 'Carne Asada' AND group_id = (SELECT id FROM modifier_groups WHERE name = 'Choose 3 Proteins');
UPDATE modifier_options SET name = 'Shrimp (Camaron)'
    WHERE name = 'Camaron' AND group_id = (SELECT id FROM modifier_groups WHERE name = 'Choose 3 Proteins');
UPDATE modifier_options SET name = 'Pulled Beef (Barbacoa)'
    WHERE name = 'Barbacoa' AND group_id = (SELECT id FROM modifier_groups WHERE name = 'Choose 3 Proteins');
UPDATE modifier_options SET name = 'Plant-Based (Veggie Chorizo)'
    WHERE name = 'Veggie Chorizo' AND group_id = (SELECT id FROM modifier_groups WHERE name = 'Choose 3 Proteins');
