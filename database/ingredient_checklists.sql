-- ============================================================
-- Narcos Tacos — Standard Ingredient Checklists + Item Fixes
-- Adds a default-checked "ingredients" modifier group to every item
-- that has genuinely removable components. Also fixes two gaps:
-- Single Taco (no protein requirement) and Single Birria Taco 
-- (missing free consomé link).
-- ============================================================

DO $$
DECLARE
    v_item_tacos UUID;
    v_item_taco_single UUID;
    v_item_mixmatch UUID;
    v_item_birria UUID;
    v_item_birria_single UUID;
    v_item_quesadilla UUID;
    v_item_nachos UUID;
    v_item_elotes UUID;
    v_item_churros UUID;
    v_item_churro_bombs UUID;
    v_item_chips_nacho UUID;
    v_item_chips_guac UUID;
    v_item_chips_salsa UUID;
    v_item_consome UUID;

    v_mg_taco_ing UUID;
    v_mg_birria_ing UUID;
    v_mg_quesadilla_ing UUID;
    v_mg_nachos_ing UUID;
    v_mg_elotes_ing UUID;
    v_mg_churro_ing UUID;
    v_mg_churro_bomb_ing UUID;
    v_mg_chips_nacho_ing UUID;
    v_mg_chips_guac_ing UUID;
    v_mg_chips_salsa_ing UUID;
    v_mg_single_taco_protein UUID;
BEGIN
    SELECT id INTO v_item_tacos FROM menu_items WHERE name = 'Tacos (3pc)';
    SELECT id INTO v_item_taco_single FROM menu_items WHERE name = 'Single Taco';
    SELECT id INTO v_item_mixmatch FROM menu_items WHERE name = 'Mix & Match Any 3 Tacos';
    SELECT id INTO v_item_birria FROM menu_items WHERE name = 'Birria Tacos (3pc)';
    SELECT id INTO v_item_birria_single FROM menu_items WHERE name = 'Single Birria Taco';
    SELECT id INTO v_item_quesadilla FROM menu_items WHERE name = 'Quesadilla';
    SELECT id INTO v_item_nachos FROM menu_items WHERE name = 'Nachos or Fries Supreme';
    SELECT id INTO v_item_elotes FROM menu_items WHERE name = 'Elotes';
    SELECT id INTO v_item_churros FROM menu_items WHERE name = 'Churros';
    SELECT id INTO v_item_churro_bombs FROM menu_items WHERE name = 'Churro Bombs';
    SELECT id INTO v_item_chips_nacho FROM menu_items WHERE name = 'Chips & Nacho Cheese';
    SELECT id INTO v_item_chips_guac FROM menu_items WHERE name = 'Chips & Guac';
    SELECT id INTO v_item_chips_salsa FROM menu_items WHERE name = 'Chips & Salsa Verde';
    SELECT id INTO v_item_consome FROM menu_items WHERE name = 'Consomé';

    -- ============================================================
    -- TACO INGREDIENTS (Tacos 3pc, Single Taco, Mix & Match)
    -- ============================================================
    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Ingredients', 0, 5, false) RETURNING id INTO v_mg_taco_ing;

    INSERT INTO modifier_options (group_id, name, price_delta, sort_order, max_quantity, default_selected) VALUES
        (v_mg_taco_ing, 'Onion', 0, 1, 1, true),
        (v_mg_taco_ing, 'Cilantro', 0, 2, 1, true),
        (v_mg_taco_ing, 'Tomato', 0, 3, 1, true),
        (v_mg_taco_ing, 'Narcos Sauce', 0, 4, 1, true),
        (v_mg_taco_ing, 'Salsa Verde', 0, 5, 1, true);

    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order) VALUES
        (v_item_tacos, v_mg_taco_ing, 2),
        (v_item_taco_single, v_mg_taco_ing, 2),
        (v_item_mixmatch, v_mg_taco_ing, 2);

    -- Single Taco needs a required protein choice (flat price, $0 delta)
    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Protein', 1, 1, true) RETURNING id INTO v_mg_single_taco_protein;

    INSERT INTO modifier_options (group_id, name, price_delta, sort_order) VALUES
        (v_mg_single_taco_protein, 'Chicken (Pollo)', 0, 1),
        (v_mg_single_taco_protein, 'Fish (Pescado)', 0, 2),
        (v_mg_single_taco_protein, 'Steak (Carne Asada)', 0, 3),
        (v_mg_single_taco_protein, 'Shrimp (Camaron)', 0, 4),
        (v_mg_single_taco_protein, 'Pulled Beef (Barbacoa)', 0, 5),
        (v_mg_single_taco_protein, 'Plant-Based (Veggie Chorizo)', 0, 6);

    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
    VALUES (v_item_taco_single, v_mg_single_taco_protein, 1);

    -- ============================================================
    -- BIRRIA INGREDIENTS (Birria Tacos 3pc, Single Birria Taco)
    -- ============================================================
    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Ingredients', 0, 3, false) RETURNING id INTO v_mg_birria_ing;

    INSERT INTO modifier_options (group_id, name, price_delta, sort_order, max_quantity, default_selected) VALUES
        (v_mg_birria_ing, 'Melted Cheese', 0, 1, 1, true),
        (v_mg_birria_ing, 'Onion', 0, 2, 1, true),
        (v_mg_birria_ing, 'Cilantro', 0, 3, 1, true);

    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order) VALUES
        (v_item_birria, v_mg_birria_ing, 2),
        (v_item_birria_single, v_mg_birria_ing, 1);

    -- Single Birria Taco was missing the free consomé link that the 3pc version has
    INSERT INTO item_addons (item_id, addon_item_id, included_quantity, extra_price, sort_order)
    VALUES (v_item_birria_single, v_item_consome, 1, NULL, 1);

    -- ============================================================
    -- QUESADILLA INGREDIENTS
    -- ============================================================
    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Ingredients', 0, 5, false) RETURNING id INTO v_mg_quesadilla_ing;

    INSERT INTO modifier_options (group_id, name, price_delta, sort_order, max_quantity, default_selected) VALUES
        (v_mg_quesadilla_ing, 'Cheese', 0, 1, 1, true),
        (v_mg_quesadilla_ing, 'Onions', 0, 2, 1, true),
        (v_mg_quesadilla_ing, 'Green Peppers', 0, 3, 1, true),
        (v_mg_quesadilla_ing, 'Narcos Sauce', 0, 4, 1, true),
        (v_mg_quesadilla_ing, 'Sour Cream', 0, 5, 1, true);

    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
    VALUES (v_item_quesadilla, v_mg_quesadilla_ing, 1);

    -- ============================================================
    -- NACHOS OR FRIES SUPREME INGREDIENTS
    -- ============================================================
    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Ingredients', 0, 4, false) RETURNING id INTO v_mg_nachos_ing;

    INSERT INTO modifier_options (group_id, name, price_delta, sort_order, max_quantity, default_selected) VALUES
        (v_mg_nachos_ing, 'Cheese', 0, 1, 1, true),
        (v_mg_nachos_ing, 'Green Onions', 0, 2, 1, true),
        (v_mg_nachos_ing, 'Tomatoes', 0, 3, 1, true),
        (v_mg_nachos_ing, 'Sour Cream', 0, 4, 1, true);

    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
    VALUES (v_item_nachos, v_mg_nachos_ing, 2);

    -- ============================================================
    -- ELOTES INGREDIENTS
    -- ============================================================
    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Ingredients', 0, 3, false) RETURNING id INTO v_mg_elotes_ing;

    INSERT INTO modifier_options (group_id, name, price_delta, sort_order, max_quantity, default_selected) VALUES
        (v_mg_elotes_ing, 'Cilantro Lime Crema', 0, 1, 1, true),
        (v_mg_elotes_ing, 'Cotija Cheese', 0, 2, 1, true),
        (v_mg_elotes_ing, 'Chili Powder', 0, 3, 1, true);

    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
    VALUES (v_item_elotes, v_mg_elotes_ing, 1);

    -- ============================================================
    -- CHURROS / CHURRO BOMBS INGREDIENTS
    -- ============================================================
    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Ingredients', 0, 1, false) RETURNING id INTO v_mg_churro_ing;
    INSERT INTO modifier_options (group_id, name, price_delta, sort_order, max_quantity, default_selected) VALUES
        (v_mg_churro_ing, 'Cinnamon Sugar', 0, 1, 1, true);
    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
    VALUES (v_item_churros, v_mg_churro_ing, 2);

    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Ingredients', 0, 2, false) RETURNING id INTO v_mg_churro_bomb_ing;
    INSERT INTO modifier_options (group_id, name, price_delta, sort_order, max_quantity, default_selected) VALUES
        (v_mg_churro_bomb_ing, 'Cinnamon Sugar', 0, 1, 1, true),
        (v_mg_churro_bomb_ing, 'Dulce de Leche Filling', 0, 2, 1, true);
    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
    VALUES (v_item_churro_bombs, v_mg_churro_bomb_ing, 1);

    -- ============================================================
    -- CHIPS COMBOS — the one added ingredient beyond plain chips
    -- ============================================================
    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Ingredients', 0, 1, false) RETURNING id INTO v_mg_chips_nacho_ing;
    INSERT INTO modifier_options (group_id, name, price_delta, sort_order, max_quantity, default_selected) VALUES
        (v_mg_chips_nacho_ing, 'Nacho Cheese', 0, 1, 1, true);
    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
    VALUES (v_item_chips_nacho, v_mg_chips_nacho_ing, 1);

    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Ingredients', 0, 1, false) RETURNING id INTO v_mg_chips_guac_ing;
    INSERT INTO modifier_options (group_id, name, price_delta, sort_order, max_quantity, default_selected) VALUES
        (v_mg_chips_guac_ing, 'Guacamole', 0, 1, 1, true);
    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
    VALUES (v_item_chips_guac, v_mg_chips_guac_ing, 1);

    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Ingredients', 0, 1, false) RETURNING id INTO v_mg_chips_salsa_ing;
    INSERT INTO modifier_options (group_id, name, price_delta, sort_order, max_quantity, default_selected) VALUES
        (v_mg_chips_salsa_ing, 'Salsa Verde', 0, 1, 1, true);
    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
    VALUES (v_item_chips_salsa, v_mg_chips_salsa_ing, 1);

END $$;
