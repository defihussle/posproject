-- ============================================================
-- Narcos Tacos — Full Menu Seed Data
-- Run this AFTER schema.sql has already created the tables.
-- Wrapped in a DO block so we can reference generated UUIDs
-- across related tables (items -> variants -> modifiers) in one pass.
-- ============================================================

DO $$
DECLARE
    v_loc_id UUID;

    -- category ids
    v_cat_tacos UUID;
    v_cat_birria UUID;
    v_cat_burritos UUID;
    v_cat_quesadilla UUID;
    v_cat_nachos UUID;
    v_cat_elotes UUID;
    v_cat_sides UUID;
    v_cat_desserts UUID;
    v_cat_drinks UUID;
    v_cat_addons UUID;

    -- item ids
    v_item_tacos UUID;
    v_item_mixmatch UUID;
    v_item_taco_single UUID;
    v_item_birria UUID;
    v_item_birria_single UUID;
    v_item_burrito UUID;
    v_item_quesadilla UUID;
    v_item_nachos UUID;
    v_item_elotes UUID;
    v_item_chips UUID;
    v_item_chips_nacho UUID;
    v_item_chips_guac UUID;
    v_item_chips_salsa UUID;
    v_item_guac UUID;
    v_item_salsa_verde UUID;
    v_item_seasoned_fries UUID;
    v_item_seasoned_rice UUID;
    v_item_tres_leches UUID;
    v_item_churros UUID;
    v_item_churro_bombs UUID;
    v_item_water UUID;
    v_item_pop UUID;
    v_item_jarritos UUID;
    v_item_consome UUID;

    -- modifier group ids
    v_mg_taco_extras UUID;
    v_mg_mixmatch_protein UUID;
    v_mg_birria_extras UUID;
    v_mg_burrito_format UUID;
    v_mg_burrito_toppings UUID;
    v_mg_burrito_addons UUID;
    v_mg_nachos_base UUID;
    v_mg_churro_dip UUID;

BEGIN
    SELECT id INTO v_loc_id FROM locations WHERE name = 'Narcos Tacos - Lawrence East';

    -- ============================================================
    -- CATEGORIES
    -- ============================================================
    INSERT INTO menu_categories (location_id, name, sort_order) VALUES (v_loc_id, 'Tacos', 1) RETURNING id INTO v_cat_tacos;
    INSERT INTO menu_categories (location_id, name, sort_order) VALUES (v_loc_id, 'Birria Tacos', 2) RETURNING id INTO v_cat_birria;
    INSERT INTO menu_categories (location_id, name, sort_order) VALUES (v_loc_id, 'Burritos & Bowls', 3) RETURNING id INTO v_cat_burritos;
    INSERT INTO menu_categories (location_id, name, sort_order) VALUES (v_loc_id, 'Quesadilla', 4) RETURNING id INTO v_cat_quesadilla;
    INSERT INTO menu_categories (location_id, name, sort_order) VALUES (v_loc_id, 'Nachos & Fries', 5) RETURNING id INTO v_cat_nachos;
    INSERT INTO menu_categories (location_id, name, sort_order) VALUES (v_loc_id, 'Elotes', 6) RETURNING id INTO v_cat_elotes;
    INSERT INTO menu_categories (location_id, name, sort_order) VALUES (v_loc_id, 'Sides', 7) RETURNING id INTO v_cat_sides;
    INSERT INTO menu_categories (location_id, name, sort_order) VALUES (v_loc_id, 'Desserts', 8) RETURNING id INTO v_cat_desserts;
    INSERT INTO menu_categories (location_id, name, sort_order) VALUES (v_loc_id, 'Drinks', 9) RETURNING id INTO v_cat_drinks;
    INSERT INTO menu_categories (location_id, name, sort_order) VALUES (v_loc_id, 'Add-ons', 10) RETURNING id INTO v_cat_addons;

    -- ============================================================
    -- ADD-ONS (standalone sellable items referenced elsewhere)
    -- ============================================================
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_addons, 'Consomé', 'Birria dipping broth', 1.50, 1) RETURNING id INTO v_item_consome;

    -- ============================================================
    -- TACOS
    -- ============================================================
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_tacos, 'Tacos (3pc)', '3 tacos served w/ salsa verde + lime wedge', 13.99, 1)
    RETURNING id INTO v_item_tacos;

    INSERT INTO item_variants (item_id, name, price, sort_order) VALUES
        (v_item_tacos, 'Pollo', 13.99, 1),
        (v_item_tacos, 'Pescado', 14.99, 2),
        (v_item_tacos, 'Carne Asada', 14.99, 3),
        (v_item_tacos, 'Camaron', 15.99, 4),
        (v_item_tacos, 'Barbacoa', 15.99, 5),
        (v_item_tacos, 'Veggie Chorizo', 14.99, 6);

    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Taco Extras', 0, 5, false) RETURNING id INTO v_mg_taco_extras;

    INSERT INTO modifier_options (group_id, name, price_delta, sort_order) VALUES
        (v_mg_taco_extras, 'Extra Taco', 4.49, 1),
        (v_mg_taco_extras, 'Add Cheese', 1.00, 2);

    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
    VALUES (v_item_tacos, v_mg_taco_extras, 1);

    -- Mix & Match Any 3 Tacos — flat price, pick any 3 proteins
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_tacos, 'Mix & Match Any 3 Tacos', 'Pick any 3 proteins', 17.99, 2)
    RETURNING id INTO v_item_mixmatch;

    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Choose 3 Proteins', 3, 3, true) RETURNING id INTO v_mg_mixmatch_protein;

    INSERT INTO modifier_options (group_id, name, price_delta, sort_order) VALUES
        (v_mg_mixmatch_protein, 'Pollo', 0, 1),
        (v_mg_mixmatch_protein, 'Pescado', 0, 2),
        (v_mg_mixmatch_protein, 'Carne Asada', 0, 3),
        (v_mg_mixmatch_protein, 'Camaron', 0, 4),
        (v_mg_mixmatch_protein, 'Barbacoa', 0, 5),
        (v_mg_mixmatch_protein, 'Veggie Chorizo', 0, 6);

    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
    VALUES (v_item_mixmatch, v_mg_mixmatch_protein, 1);

    -- Single Taco à la carte
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_tacos, 'Single Taco', 'One taco, à la carte', 6.00, 3)
    RETURNING id INTO v_item_taco_single;

    -- ============================================================
    -- BIRRIA TACOS
    -- ============================================================
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_birria, 'Birria Tacos (3pc)', 'Pulled beef, melted cheese, onion, cilantro', 16.99, 1)
    RETURNING id INTO v_item_birria;

    -- comes with 1 free consomé
    INSERT INTO item_addons (item_id, addon_item_id, included_quantity, extra_price, sort_order)
    VALUES (v_item_birria, v_item_consome, 1, NULL, 1);

    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Birria Extras', 0, 3, false) RETURNING id INTO v_mg_birria_extras;

    INSERT INTO modifier_options (group_id, name, price_delta, sort_order) VALUES
        (v_mg_birria_extras, 'Extra Birria (added meat)', 5.49, 1);

    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
    VALUES (v_item_birria, v_mg_birria_extras, 1);

    -- Single Birria Taco à la carte
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_birria, 'Single Birria Taco', 'One birria taco, à la carte', 6.49, 2)
    RETURNING id INTO v_item_birria_single;

    -- ============================================================
    -- BURRITOS & BOWLS
    -- ============================================================
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_burritos, 'Burrito or Bowl', 'Choice of format, same price either way', 14.49, 1)
    RETURNING id INTO v_item_burrito;

    INSERT INTO item_variants (item_id, name, price, sort_order) VALUES
        (v_item_burrito, 'Pollo', 14.49, 1),
        (v_item_burrito, 'Pescado', 15.49, 2),
        (v_item_burrito, 'Carne Asada', 15.49, 3),
        (v_item_burrito, 'Camaron', 16.49, 4),
        (v_item_burrito, 'Barbacoa', 16.49, 5),
        (v_item_burrito, 'Veggie Chorizo', 15.49, 6);

    -- Format: Burrito or Bowl — free choice
    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Format', 1, 1, true) RETURNING id INTO v_mg_burrito_format;

    INSERT INTO modifier_options (group_id, name, price_delta, sort_order) VALUES
        (v_mg_burrito_format, 'Burrito', 0, 1),
        (v_mg_burrito_format, 'Bowl', 0, 2);

    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
    VALUES (v_item_burrito, v_mg_burrito_format, 1);

    -- Toppings — free customization, multi-select
    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Toppings', 0, 13, false) RETURNING id INTO v_mg_burrito_toppings;

    INSERT INTO modifier_options (group_id, name, price_delta, sort_order) VALUES
        (v_mg_burrito_toppings, 'Cheese', 0, 1),
        (v_mg_burrito_toppings, 'Lettuce', 0, 2),
        (v_mg_burrito_toppings, 'Rice', 0, 3),
        (v_mg_burrito_toppings, 'Corn', 0, 4),
        (v_mg_burrito_toppings, 'Beans', 0, 5),
        (v_mg_burrito_toppings, 'Cilantro', 0, 6),
        (v_mg_burrito_toppings, 'Onions', 0, 7),
        (v_mg_burrito_toppings, 'Green Onions', 0, 8),
        (v_mg_burrito_toppings, 'Bell Peppers', 0, 9),
        (v_mg_burrito_toppings, 'Tomatoes', 0, 10),
        (v_mg_burrito_toppings, 'Sour Cream', 0, 11),
        (v_mg_burrito_toppings, 'Narcos Sauce', 0, 12),
        (v_mg_burrito_toppings, 'Salsa Verde', 0, 13);

    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
    VALUES (v_item_burrito, v_mg_burrito_toppings, 2);

    -- Add Guac — paid upcharge
    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Add-ons', 0, 1, false) RETURNING id INTO v_mg_burrito_addons;

    INSERT INTO modifier_options (group_id, name, price_delta, sort_order) VALUES
        (v_mg_burrito_addons, 'Add Guac', 3.00, 1);

    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
    VALUES (v_item_burrito, v_mg_burrito_addons, 3);

    -- ============================================================
    -- QUESADILLA
    -- ============================================================
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_quesadilla, 'Quesadilla', 'Cheese, onions, green peppers, Narcos sauce + sour cream', 12.99, 1)
    RETURNING id INTO v_item_quesadilla;

    INSERT INTO item_variants (item_id, name, price, sort_order) VALUES
        (v_item_quesadilla, 'Cheese', 12.99, 1),
        (v_item_quesadilla, 'Pollo', 15.99, 2),
        (v_item_quesadilla, 'Carne Asada', 16.99, 3),
        (v_item_quesadilla, 'Veggie Chorizo', 16.99, 4),
        (v_item_quesadilla, 'Barbacoa', 17.99, 5),
        (v_item_quesadilla, 'Camaron', 17.99, 6);

    -- ============================================================
    -- NACHOS OR FRIES SUPREME
    -- ============================================================
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_nachos, 'Nachos or Fries Supreme', 'Cheese, green onions, tomatoes, sour cream', 9.99, 1)
    RETURNING id INTO v_item_nachos;

    INSERT INTO item_variants (item_id, name, price, sort_order) VALUES
        (v_item_nachos, 'Classic', 9.99, 1),
        (v_item_nachos, 'Pollo', 12.99, 2),
        (v_item_nachos, 'Carne Asada', 13.99, 3),
        (v_item_nachos, 'Veggie Chorizo', 13.99, 4);

    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Base', 1, 1, true) RETURNING id INTO v_mg_nachos_base;

    INSERT INTO modifier_options (group_id, name, price_delta, sort_order) VALUES
        (v_mg_nachos_base, 'Nachos', 0, 1),
        (v_mg_nachos_base, 'Fries', 0, 2);

    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
    VALUES (v_item_nachos, v_mg_nachos_base, 1);

    -- ============================================================
    -- ELOTES
    -- ============================================================
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_elotes, 'Elotes', 'Mexican street corn, cilantro lime crema, cotija, chili powder', 6.99, 1)
    RETURNING id INTO v_item_elotes;

    -- ============================================================
    -- SIDES
    -- ============================================================
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_sides, 'Chips', NULL, 1.99, 1) RETURNING id INTO v_item_chips;
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_sides, 'Chips & Nacho Cheese', NULL, 4.99, 2) RETURNING id INTO v_item_chips_nacho;
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_sides, 'Chips & Guac', NULL, 4.99, 3) RETURNING id INTO v_item_chips_guac;
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_sides, 'Chips & Salsa Verde', NULL, 3.99, 4) RETURNING id INTO v_item_chips_salsa;
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_sides, 'Seasoned Fries', NULL, 4.99, 5) RETURNING id INTO v_item_seasoned_fries;
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_sides, 'Seasoned Rice', NULL, 4.99, 6) RETURNING id INTO v_item_seasoned_rice;

    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_sides, 'Guacamole', NULL, 2.99, 7) RETURNING id INTO v_item_guac;
    INSERT INTO item_variants (item_id, name, price, sort_order) VALUES
        (v_item_guac, 'Small', 2.99, 1),
        (v_item_guac, 'Large', 5.99, 2);

    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_sides, 'Salsa Verde', NULL, 1.99, 8) RETURNING id INTO v_item_salsa_verde;
    INSERT INTO item_variants (item_id, name, price, sort_order) VALUES
        (v_item_salsa_verde, 'Small', 1.99, 1),
        (v_item_salsa_verde, 'Large', 3.99, 2);

    -- ============================================================
    -- DESSERTS
    -- ============================================================
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_desserts, 'Tres Leches', 'Sponge cake soaked in 3 kinds of milk, whipped creme + dulce de leche', 7.99, 1)
    RETURNING id INTO v_item_tres_leches;

    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_desserts, 'Churros', 'Fried dough, dusted with cinnamon sugar', 6.99, 2)
    RETURNING id INTO v_item_churros;
    INSERT INTO item_variants (item_id, name, price, sort_order) VALUES
        (v_item_churros, '3pc', 6.99, 1),
        (v_item_churros, '6pc', 11.99, 2),
        (v_item_churros, '9pc', 16.99, 3);

    INSERT INTO modifier_groups (name, min_select, max_select, required)
    VALUES ('Dipping Sauce', 0, 3, false) RETURNING id INTO v_mg_churro_dip;
    INSERT INTO modifier_options (group_id, name, price_delta, sort_order) VALUES
        (v_mg_churro_dip, 'Chocolate', 1.00, 1),
        (v_mg_churro_dip, 'Dulce de Leche', 1.00, 2),
        (v_mg_churro_dip, 'Strawberry', 1.00, 3);
    INSERT INTO item_modifier_groups (item_id, modifier_group_id, sort_order)
    VALUES (v_item_churros, v_mg_churro_dip, 1);

    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_desserts, 'Churro Bombs', 'Fried doughnuts filled with dulce de leche, cinnamon sugar', 5.99, 3)
    RETURNING id INTO v_item_churro_bombs;
    INSERT INTO item_variants (item_id, name, price, sort_order) VALUES
        (v_item_churro_bombs, '3pc', 5.99, 1),
        (v_item_churro_bombs, '6pc', 10.99, 2),
        (v_item_churro_bombs, '9pc', 15.99, 3);

    -- ============================================================
    -- DRINKS
    -- ============================================================
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_drinks, 'Water', NULL, 2.50, 1) RETURNING id INTO v_item_water;
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_drinks, 'Pop', NULL, 2.00, 2) RETURNING id INTO v_item_pop;
    INSERT INTO menu_items (category_id, name, description, base_price, sort_order)
    VALUES (v_cat_drinks, 'Jarritos', NULL, 3.00, 3) RETURNING id INTO v_item_jarritos;

END $$;
