import { useState, useMemo } from "react";
import "./ItemModal.css";

export default function ItemModal({ item, initialVariant, onAdd, onClose }) {
  // --- Variant selection (radio — pick exactly one) ---
  const [selectedVariant, setSelectedVariant] = useState(initialVariant || null);
  const hasVariants = item.variants.length > 0;
  const hideVariantSelector = !!initialVariant;

  // Helper to format variant + item name (e.g., Pollo Tacos)
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
  // { [groupId]: Set of selected option ids }
  const [modSelections, setModSelections] = useState(() => {
    const init = {};
    for (const g of item.modifier_groups) {
      init[g.id] = new Set();
    }
    return init;
  });

  // --- Addon extra quantities (beyond included) ---
  // { [addonId]: extra qty }
  const [addonExtras, setAddonExtras] = useState(() => {
    const init = {};
    for (const a of item.addons) {
      init[a.id] = 0;
    }
    return init;
  });

  // --- Toggle modifier option ---
  const toggleModOption = (group, optionId) => {
    setModSelections((prev) => {
      const sel = new Set(prev[group.id]);
      if (sel.has(optionId)) {
        sel.delete(optionId);
      } else {
        // If max_select is 1, replace (radio behavior)
        if (group.max_select === 1) {
          sel.clear();
        }
        // If at max, don't add more
        if (sel.size < group.max_select) {
          sel.add(optionId);
        }
      }
      return { ...prev, [group.id]: sel };
    });
  };

  // --- Addon quantity ---
  const adjustAddonQty = (addonId, delta) => {
    setAddonExtras((prev) => ({
      ...prev,
      [addonId]: Math.max(0, (prev[addonId] || 0) + delta),
    }));
  };

  // --- Validation ---
  const validationErrors = useMemo(() => {
    const errors = [];
    if (hasVariants && !selectedVariant) {
      errors.push("Please select a variant");
    }
    for (const g of item.modifier_groups) {
      const count = modSelections[g.id]?.size || 0;
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

    // Add modifier deltas
    for (const g of item.modifier_groups) {
      for (const opt of g.options) {
        if (modSelections[g.id]?.has(opt.id)) {
          price += parseFloat(opt.price_delta);
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

    // Build selected modifiers list
    const selectedModifiers = [];
    for (const g of item.modifier_groups) {
      for (const opt of g.options) {
        if (modSelections[g.id]?.has(opt.id)) {
          selectedModifiers.push({
            groupName: g.name,
            optionId: opt.id,
            optionName: opt.name,
            priceDelta: parseFloat(opt.price_delta),
          });
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
            const sel = modSelections[group.id] || new Set();

            return (
              <div key={group.id} className="item-modal__section">
                <div className="item-modal__section-header">
                  <span className="item-modal__section-title">{group.name}</span>
                  <span className={`item-modal__section-badge ${group.required ? "item-modal__section-badge--required" : "item-modal__section-badge--optional"}`}>
                    {group.required ? "Required" : "Optional"}
                  </span>
                  {group.max_select > 1 && (
                    <span className="item-modal__section-hint">
                      {sel.size}/{group.max_select}
                    </span>
                  )}
                </div>
                {group.options.map((opt) => {
                  const isSelected = sel.has(opt.id);
                  const delta = parseFloat(opt.price_delta);
                  return (
                    <div
                      key={opt.id}
                      className={`item-modal__option${isSelected ? " item-modal__option--selected" : ""}`}
                      onClick={() => toggleModOption(group, opt.id)}
                    >
                      <div className={`item-modal__indicator${isRadio ? "" : " item-modal__indicator--checkbox"}${isSelected ? " item-modal__indicator--selected" : ""}`} />
                      <span className="item-modal__option-name">{opt.name}</span>
                      <span className={`item-modal__option-price${delta === 0 ? " item-modal__option-price--free" : ""}`}>
                        {delta === 0 ? "Free" : `+$${delta.toFixed(2)}`}
                      </span>
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
