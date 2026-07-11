import { useState, useEffect, useMemo, useCallback } from "react";
import ItemModal from "./ItemModal";
import "./OrderEntry.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

export default function OrderEntry({ staff, onLogout }) {
  const [menu, setMenu] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeCatId, setActiveCatId] = useState(null);
  const [modalItem, setModalItem] = useState(null);
  const [cart, setCart] = useState([]);

  // Fetch full menu on mount
  useEffect(() => {
    fetch(`${API_URL}/api/menu/full`)
      .then((r) => r.json())
      .then((data) => {
        setMenu(data);
        if (data.length > 0) setActiveCatId(data[0].id);
      })
      .catch((err) => console.error("Failed to load menu:", err))
      .finally(() => setLoading(false));
  }, []);

  // Active category items
  const activeCategory = useMemo(
    () => menu.find((c) => c.id === activeCatId),
    [menu, activeCatId]
  );

  // Handle item card click
  const handleItemClick = useCallback((item) => {
    // If the item has variants, modifiers, or addons → open modal
    if (item.variants.length > 0 || item.modifier_groups.length > 0 || item.addons.length > 0) {
      setModalItem(item);
    } else {
      // Simple item — add directly to cart
      addToCart({
        itemId: item.id,
        itemName: item.name,
        variant: null,
        modifiers: [],
        addons: [],
        unitPrice: parseFloat(item.base_price),
        quantity: 1,
      });
    }
  }, []);

  // Add to cart
  const addToCart = useCallback((cartItem) => {
    setCart((prev) => [...prev, { ...cartItem, cartLineId: Date.now() + Math.random() }]);
    setModalItem(null);
  }, []);

  // Adjust quantity
  const adjustQty = useCallback((cartLineId, delta) => {
    setCart((prev) =>
      prev
        .map((item) =>
          item.cartLineId === cartLineId
            ? { ...item, quantity: Math.max(0, item.quantity + delta) }
            : item
        )
        .filter((item) => item.quantity > 0)
    );
  }, []);

  // Remove item
  const removeItem = useCallback((cartLineId) => {
    setCart((prev) => prev.filter((item) => item.cartLineId !== cartLineId));
  }, []);

  // Subtotal
  const subtotal = useMemo(
    () => cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0),
    [cart]
  );

  // Price display helper for items
  const getPriceDisplay = (item) => {
    if (item.variants.length > 0) {
      const prices = item.variants.map((v) => parseFloat(v.price));
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      return min === max ? `$${min.toFixed(2)}` : `$${min.toFixed(2)}–$${max.toFixed(2)}`;
    }
    return `$${parseFloat(item.base_price).toFixed(2)}`;
  };

  if (loading) {
    return (
      <div className="order-entry">
        <div className="oe-loading">Loading menu…</div>
      </div>
    );
  }

  return (
    <div className="order-entry">
      {/* Top Bar */}
      <div className="oe-topbar">
        <div className="oe-topbar__brand">
          <span className="dashboard__brand-narcos">NARCOS</span>
          <span className="dashboard__brand-tacos">TACOS</span>
        </div>
        <div className="oe-topbar__right">
          <span className="oe-topbar__staff">{staff.name}</span>
          <button className="oe-topbar__btn" onClick={onLogout}>
            Log Out
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="oe-body">
        {/* Menu Side */}
        <div className="oe-menu">
          {/* Category Tabs */}
          <div className="oe-categories">
            {menu.map((cat) => (
              <button
                key={cat.id}
                className={`oe-cat-tab${cat.id === activeCatId ? " oe-cat-tab--active" : ""}`}
                onClick={() => setActiveCatId(cat.id)}
              >
                {cat.name}
              </button>
            ))}
          </div>

          {/* Item Grid */}
          <div className="oe-items">
            {activeCategory?.items.map((item) => (
              <div
                key={item.id}
                className="oe-item-card"
                onClick={() => handleItemClick(item)}
              >
                <span className="oe-item-card__name">{item.name}</span>
                {item.description && (
                  <span className="oe-item-card__desc">{item.description}</span>
                )}
                <span className="oe-item-card__price">{getPriceDisplay(item)}</span>
                <div className="oe-item-card__badges">
                  {item.variants.length > 0 && (
                    <span className="oe-item-card__badge">{item.variants.length} options</span>
                  )}
                  {item.addons.length > 0 && (
                    <span className="oe-item-card__badge oe-item-card__badge--addon">
                      + free add-on
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Cart */}
        <div className="oe-cart">
          <div className="oe-cart__header">
            <h2 className="oe-cart__title">Current Order</h2>
          </div>

          <div className="oe-cart__items">
            {cart.length === 0 ? (
              <div className="oe-cart__empty">
                <span>No items yet</span>
                <span style={{ fontSize: "0.75rem" }}>Tap a menu item to add it</span>
              </div>
            ) : (
              cart.map((line) => (
                <div key={line.cartLineId} className="oe-cart-line">
                  <div className="oe-cart-line__top">
                    <div className="oe-cart-line__info">
                      <div className="oe-cart-line__name">{line.itemName}</div>
                      {line.variant && (
                        <div className="oe-cart-line__variant">{line.variant.name}</div>
                      )}
                      {line.modifiers.length > 0 && (
                        <div className="oe-cart-line__mods">
                          {line.modifiers.map((m) => m.optionName).join(", ")}
                        </div>
                      )}
                      {line.addons.filter((a) => a.includedQty > 0 || a.extraQty > 0).length > 0 && (
                        <div className="oe-cart-line__mods">
                          {line.addons.map((a) => {
                            const parts = [];
                            if (a.includedQty > 0) parts.push(`${a.addonName} (included)`);
                            if (a.extraQty > 0) parts.push(`+${a.extraQty} extra ${a.addonName}`);
                            return parts.join(", ");
                          }).join("; ")}
                        </div>
                      )}
                    </div>
                    <div className="oe-cart-line__price">
                      ${(line.unitPrice * line.quantity).toFixed(2)}
                    </div>
                  </div>
                  <div className="oe-cart-line__controls">
                    <button
                      className="oe-cart-line__qty-btn"
                      onClick={() => adjustQty(line.cartLineId, -1)}
                    >
                      −
                    </button>
                    <span className="oe-cart-line__qty">{line.quantity}</span>
                    <button
                      className="oe-cart-line__qty-btn"
                      onClick={() => adjustQty(line.cartLineId, 1)}
                    >
                      +
                    </button>
                    <button
                      className="oe-cart-line__remove"
                      onClick={() => removeItem(line.cartLineId)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {cart.length > 0 && (
            <div className="oe-cart__footer">
              <div className="oe-cart__subtotal">
                <span className="oe-cart__subtotal-label">Subtotal</span>
                <span className="oe-cart__subtotal-amount">${subtotal.toFixed(2)}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Item Modal */}
      {modalItem && (
        <ItemModal
          item={modalItem}
          onAdd={addToCart}
          onClose={() => setModalItem(null)}
        />
      )}
    </div>
  );
}
