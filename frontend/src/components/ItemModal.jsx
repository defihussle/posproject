import { useState, useMemo } from "react";
import "./ItemModal.css";

export default function ItemModal({ item, initialVariant, onAdd, onClose }) {
  // --- Variant selection (radio — pick exactly one) ---
  const [selectedVariant, setSelectedVariant] = useState(initialVariant || null);
  const hasVariants = item.variants.length > 0;
  const hideVariantSelector = !!initialVariant;

  // Helper to format variant + item name (e.g., Chicken (Pollo) Tacos)
  const getFormattedVariantItemName = (itemName, variantName) => {
    let cleanItemName = itemName;
    if (cleanItemName.endsWith(" (3pc)")) {
      cleanItemName = cleanItemName.slice(0, -6);
    }
    if (cleanItemName.endsWith(" or Bowl")) {
      cleanItemName = cleanItemName.slice(0, -8);
    }
    return `${variantName} ${cleanItemName}`;
  };

  // --- Modifier selections keyed by group id ---
  // { [groupId]: Map<optionId, quantity> }
  // quantity=0 means unselected, quantity>=1 means selected
  const [modSelections, setModSelections] = useState(() => {
    const init = {};
    for (const g of item.modifier_groups) {
      const optMap = new Map();
      for (const opt of g.options) {
        // Pre-check options that have default_selected = true
        optMap.set(opt.id, opt.default_selected ? 1 : 0);
      }
      init[g.id] = optMap;
    }
    return init;
  });

  // --- Toggle modifier option (for simple on/off, max_quantity === 1) ---
  const toggleModOption = (group, optionId) => {
    setModSelections((prev) => {
      const optMap = new Map(prev[group.id]);
      const currentQty = optMap.get(optionId) || 0;

      if (currentQty > 0) {
        // Turn off
        optMap.set(optionId, 0);
      } else {
        // If max_select is 1, clear others first (radio behavior)
        if (group.max_select === 1) {
          for (const [key] of optMap) {
            optMap.set(key, 0);
          }
        }
        // Count currently selected
        let selectedCount = 0;
        for (const [, qty] of optMap) {
          if (qty > 0) selectedCount++;
        }
        // Only add if under max
        if (selectedCount < group.max_select) {
          optMap.set(optionId, 1);
        }
      }
      return { ...prev, [group.id]: optMap };
    });
  };

  // --- Adjust stepper quantity (for max_quantity > 1) ---
  const adjustModQty = (group, optionId, delta, maxQty) => {
    setModSelections((prev) => {
      const optMap = new Map(prev[group.id]);
      const currentQty = optMap.get(optionId) || 0;
      const newQty = Math.max(0, Math.min(maxQty, currentQty + delta));
      optMap.set(optionId, newQty);
      return { ...prev, [group.id]: optMap };
    });
  };

  // --- Addon extra quantities (beyond included) ---
  // { [addonId]: extra qty }
  const [addonExtras, setAddonExtras] = useState(() => {
    const init = {};
    for (const a of item.addons) {
      init[a.id] = 0;
    }
    return init;
  });

  // --- Addon quantity ---
  const adjustAddonQty = (addonId, delta) => {
    setAddonExtras((prev) => ({
      ...prev,
      [addonId]: Math.max(0, (prev[addonId] || 0) + delta),
    }));
  };

  // Helper: count selected options in a group
  const getSelectedCount = (groupId) => {
    const optMap = modSelections[groupId];
    if (!optMap) return 0;
    let count = 0;
    for (const [, qty] of optMap) {
      if (qty > 0) count++;
    }
    return count;
  };

  // --- Validation ---
  const validationErrors = useMemo(() => {
    const errors = [];
    if (hasVariants && !selectedVariant) {
      errors.push("Please select a variant");
    }
    for (const g of item.modifier_groups) {
      const count = getSelectedCount(g.id);
      if (g.required && count < g.min_select) {
        errors.push(`"${g.name}" requires at least ${g.min_select} selection${g.min_select > 1 ? "s" : ""}`);
      }
    }
    return errors;
  }, [hasVariants, selectedVariant, modSelections, item.modifier_groups]);

  const canAdd = validationErrors.length === 0;

  // --- Compute running price ---
  const computedPrice = useMemo(() => {
    let price = hasVariants && selectedVariant
      ? parseFloat(selectedVariant.price)
      : parseFloat(item.base_price);

    // Add modifier deltas (multiply by quantity)
    for (const g of item.modifier_groups) {
      for (const opt of g.options) {
        const qty = modSelections[g.id]?.get(opt.id) || 0;
        if (qty > 0) {
          price += parseFloat(opt.price_delta) * qty;
        }
      }
    }

    // Add extra addon costs
    for (const addon of item.addons) {
      const extraQty = addonExtras[addon.id] || 0;
      if (extraQty > 0) {
        const unitPrice = addon.extra_price
          ? parseFloat(addon.extra_price)
          : parseFloat(addon.addon_base_price);
        price += extraQty * unitPrice;
      }
    }

    return price;
  }, [hasVariants, selectedVariant, item, modSelections, addonExtras]);

  // --- Handle add to cart ---
  const handleAdd = () => {
    if (!canAdd) return;

    // Build selected modifiers list (include quantity), and separately
    // track default-included options the customer unchecked (e.g. "no
    // onion") — mirrors the server's own removed_ingredients logic
    // (fetchKdsOrders in backend/server.js: a default option with no
    // matching selection is "removed"), so the cart shows the same signal
    // KDS does instead of just silently dropping it from the modifier list.
    const selectedModifiers = [];
    const removedIngredients = [];
    for (const g of item.modifier_groups) {
      for (const opt of g.options) {
        const qty = modSelections[g.id]?.get(opt.id) || 0;
        if (qty > 0) {
          selectedModifiers.push({
            groupName: g.name,
            optionId: opt.id,
            optionName: opt.name,
            priceDelta: parseFloat(opt.price_delta),
            quantity: qty,
          });
        } else if (opt.default_selected) {
          removedIngredients.push(opt.name);
        }
      }
    }

    // Build addons list
    const selectedAddons = item.addons.map((a) => ({
      addonId: a.id,
      addonItemId: a.addon_item_id,
      addonName: a.addon_name,
      includedQty: a.included_quantity,
      extraQty: addonExtras[a.id] || 0,
      unitPrice: a.extra_price
        ? parseFloat(a.extra_price)
        : parseFloat(a.addon_base_price),
      isComplimentary: true,
    }));

    onAdd({
      itemId: item.id,
      itemName: selectedVariant
        ? getFormattedVariantItemName(item.name, selectedVariant.name)
        : item.name,
      variant: selectedVariant
        ? { id: selectedVariant.id, name: selectedVariant.name, price: parseFloat(selectedVariant.price) }
        : null,
      modifiers: selectedModifiers,
      removedIngredients,
      addons: selectedAddons,
      unitPrice: computedPrice,
      quantity: 1,
    });
  };

  return (
    <div className="item-modal-overlay" onClick={onClose}>
      <div className="item-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="item-modal__header">
          <div className="item-modal__header-info">
            <h2 className="item-modal__name">
              {selectedVariant ? getFormattedVariantItemName(item.name, selectedVariant.name) : item.name}
            </h2>
            {item.description && (
              <p className="item-modal__desc">{item.description}</p>
            )}
            <div className="item-modal__base-price">
              ${computedPrice.toFixed(2)}
            </div>
          </div>
          <button className="item-modal__close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="item-modal__body">
          {/* Variants */}
          {hasVariants && !hideVariantSelector && (
            <div className="item-modal__section">
              <div className="item-modal__section-header">
                <span className="item-modal__section-title">Choose Option</span>
                <span className="item-modal__section-badge item-modal__section-badge--required">Required</span>
              </div>
              {item.variants.map((v) => (
                <div
                  key={v.id}
                  className={`item-modal__option${selectedVariant?.id === v.id ? " item-modal__option--selected" : ""}`}
                  onClick={() => setSelectedVariant(v)}
                >
                  <div className={`item-modal__indicator${selectedVariant?.id === v.id ? " item-modal__indicator--selected" : ""}`} />
                  <span className="item-modal__option-name">{v.name}</span>
                  <span className="item-modal__option-price">${parseFloat(v.price).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Modifier Groups */}
          {item.modifier_groups.map((group) => {
            const isRadio = group.max_select === 1;
            const selectedCount = getSelectedCount(group.id);

            return (
              <div key={group.id} className="item-modal__section">
                <div className="item-modal__section-header">
                  <span className="item-modal__section-title">{group.name}</span>
                  <span className={`item-modal__section-badge ${group.required ? "item-modal__section-badge--required" : "item-modal__section-badge--optional"}`}>
                    {group.required ? "Required" : "Optional"}
                  </span>
                  {group.max_select > 1 && (
                    <span className="item-modal__section-hint">
                      {selectedCount}/{group.max_select}
                    </span>
                  )}
                </div>
                {group.options.map((opt) => {
                  const qty = modSelections[group.id]?.get(opt.id) || 0;
                  const isSelected = qty > 0;
                  const delta = parseFloat(opt.price_delta);
                  const maxQty = opt.max_quantity || 1;
                  const isStepper = maxQty > 1;

                  if (isStepper) {
                    // ---- Stepper UI (Pill-shaped, no checkbox) ----
                    return (
                      <div
                        key={opt.id}
                        className={`item-modal__option${isSelected ? " item-modal__option--selected" : ""}`}
                        style={{ cursor: "default" }}
                      >
                        <span className="item-modal__option-name">{opt.name}</span>
                        <div className="item-modal__stepper-pill">
                          <button
                            className="item-modal__stepper-pill-btn"
                            onClick={() => adjustModQty(group, opt.id, -1, maxQty)}
                            disabled={qty === 0}
                          >
                            −
                          </button>
                          <span className="item-modal__stepper-pill-qty">{qty}</span>
                          <button
                            className="item-modal__stepper-pill-btn"
                            onClick={() => adjustModQty(group, opt.id, 1, maxQty)}
                            disabled={qty >= maxQty}
                          >
                            +
                          </button>
                        </div>
                        <span className={`item-modal__option-price${delta === 0 ? " item-modal__option-price--free" : ""}`}>
                          {delta === 0
                            ? "Included"
                            : `+$${(delta * Math.max(1, qty)).toFixed(2)}`}
                        </span>
                      </div>
                    );
                  }

                  // ---- Standard toggle/radio UI ----
                  // Price/state label, delta === 0 only (a non-zero delta
                  // always shows its "+$X.XX" regardless of group type):
                  //  - radio groups (Protein, Format, Base, ...): no label
                  //    at all — the section's own "Required" badge already
                  //    says everything that needs saying, and a static
                  //    "Included" next to every option regardless of which
                  //    one is picked was actively misleading.
                  //  - default-selected checkbox options (Onion, Cilantro,
                  //    ... — starts checked, removable): dynamic
                  //    Included/Removed reflecting the LIVE toggle state.
                  //  - non-default checkbox options (e.g. "Choose 3
                  //    Proteins", nothing pre-checked): unchanged, static
                  //    "Included" — not a reported bug, left as-is.
                  let priceLabel = null;
                  if (delta !== 0) {
                    priceLabel = `+$${delta.toFixed(2)}`;
                  } else if (!isRadio && opt.default_selected) {
                    priceLabel = isSelected ? "Included" : "Removed";
                  } else if (!isRadio) {
                    priceLabel = "Included";
                  }

                  return (
                    <div
                      key={opt.id}
                      className={`item-modal__option${isSelected ? " item-modal__option--selected" : ""}`}
                      onClick={() => toggleModOption(group, opt.id)}
                    >
                      <div className={`item-modal__indicator${isRadio ? "" : " item-modal__indicator--checkbox"}${isSelected ? " item-modal__indicator--selected" : ""}`} />
                      <span className="item-modal__option-name">{opt.name}</span>
                      {priceLabel && (
                        <span
                          className={`item-modal__option-price${
                            delta !== 0
                              ? ""
                              : isSelected
                              ? " item-modal__option-price--free"
                              : " item-modal__option-price--removed"
                          }`}
                        >
                          {priceLabel}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Addons */}
          {item.addons.length > 0 && (
            <div className="item-modal__section">
              <div className="item-modal__section-header">
                <span className="item-modal__section-title">Included Add-ons</span>
              </div>
              {item.addons.map((addon) => {
                const extraQty = addonExtras[addon.id] || 0;
                const unitPrice = addon.extra_price
                  ? parseFloat(addon.extra_price)
                  : parseFloat(addon.addon_base_price);
                return (
                  <div key={addon.id} className="item-modal__addon-row">
                    <div className="item-modal__addon-info">
                      <div className="item-modal__addon-name">{addon.addon_name}</div>
                      <div className="item-modal__addon-detail">
                        {addon.included_quantity} included free • Extra +${unitPrice.toFixed(2)} each
                      </div>
                    </div>
                    <div className="item-modal__addon-extra">
                      <button
                        className="item-modal__addon-qty-btn"
                        onClick={() => adjustAddonQty(addon.id, -1)}
                        disabled={extraQty === 0}
                      >
                        −
                      </button>
                      <span className="item-modal__addon-qty">{extraQty}</span>
                      <button
                        className="item-modal__addon-qty-btn"
                        onClick={() => adjustAddonQty(addon.id, 1)}
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Validation message */}
        {!canAdd && validationErrors.length > 0 && (
          <div className="item-modal__validation">
            {validationErrors[0]}
          </div>
        )}

        {/* Footer */}
        <div className="item-modal__footer">
          <button
            className="item-modal__add-btn"
            onClick={handleAdd}
            disabled={!canAdd}
          >
            Add to Order — ${computedPrice.toFixed(2)}
          </button>
        </div>
      </div>
    </div>
  );
}
