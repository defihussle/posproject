-- ============================================================
-- Plain ingredients/toppings are checkboxes, never quantity steppers
-- ------------------------------------------------------------
-- SYMPTOM
--   Toppings on the new Burrito/Bowl items rendered as "− 1 +" steppers
--   instead of the Included/Removed checkboxes Quesadilla Ingredients use.
--
-- CAUSE (fixed in server.js alongside this)
--   Order Entry renders a stepper when modifier_options.max_quantity > 1
--   (ItemModal: `const isStepper = maxQty > 1`). Every option created through
--   Back Office → Menu Management was given DEFAULT_OPTION_MAX_QUANTITY = 5,
--   regardless of group. That default is right for a paid add-on (Extra Taco,
--   Dipping Sauce) and wrong for an ingredient list — nobody orders three
--   lettuces. Seeded toppings came from SQL with max_quantity = 1, so only
--   OWNER-ADDED toppings drifted, which is why this shows in production and
--   not in a freshly seeded database.
--
-- SCOPE — deliberately narrow
--   Only groups named "Ingredients" or "Toppings", matching the existing
--   isPricelessGroupName() classifier in server.js (PRICELESS_GROUP_NAMES).
--   Those groups are already forced to price_delta = 0, so by definition they
--   are not paid quantity choices. Genuine quantity groups are untouched:
--   Dipping Sauce, Taco Extras (Extra Taco), Birria Extras, Add-ons — none is
--   named Ingredients or Toppings, and the WHERE clause cannot reach them.
--
-- Idempotent: re-running matches zero rows.
-- ============================================================

UPDATE modifier_options o
   SET max_quantity = 1
  FROM modifier_groups g
 WHERE g.id = o.group_id
   AND g.name ~* '^(ingredients|toppings)$'
   AND o.max_quantity <> 1;
