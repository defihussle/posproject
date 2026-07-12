import { useState, useEffect, useMemo, useCallback } from "react";
import ItemModal from "./ItemModal";
import logoImg from "../assets/narcos-tacos-logo.png";
import "./OrderEntry.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

export default function OrderEntry({ staff, theme, onToggleTheme, onLogout }) {
  const [menu, setMenu] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeCatId, setActiveCatId] = useState(null);
  const [modalItem, setModalItem] = useState(null);
  const [modalVariant, setModalVariant] = useState(null);
  const [cart, setCart] = useState([]);
  const [cartCollapsed, setCartCollapsed] = useState(true);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);

  // Total cart items count
  const cartItemsCount = useMemo(
    () => cart.reduce((sum, item) => sum + item.quantity, 0),
    [cart]
  );

  // Auto-collapse when cart is empty
  useEffect(() => {
    if (cart.length === 0) {
      setCartCollapsed(true);
    }
  }, [cart.length]);

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
  const handleItemClick = useCallback((item, variant = null) => {
    setModalItem(item);
    setModalVariant(variant);
  }, []);

  // Add to cart
  const addToCart = useCallback((cartItem) => {
    setCart((prev) => [...prev, { ...cartItem, cartLineId: Date.now() + Math.random() }]);
    setModalItem(null);
    setModalVariant(null);
    setCartCollapsed(false); // auto-expand
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
          <img src={logoImg} alt="NARCOS TACOS" className="oe-topbar__logo" />
        </div>
        <div className="oe-topbar__right">
          <span className="oe-topbar__staff">{staff.name}</span>
          <div className="oe-account-menu-container">
            <button 
              className="oe-account-menu-btn" 
              onClick={() => setAccountMenuOpen(prev => !prev)}
              aria-label="Account menu"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
              </svg>
            </button>
            {accountMenuOpen && (
              <>
                <div className="oe-account-menu-backdrop" onClick={() => setAccountMenuOpen(false)} />
                <div className="oe-account-menu-dropdown">
                  {staff.role === "owner" && (
                    <div className="oe-account-menu-row">
                      <span>Dark Mode</span>
                      <label className="oe-switch">
                        <input 
                          type="checkbox" 
                          checked={theme === "dark"} 
                          onChange={onToggleTheme} 
                        />
                        <span className="oe-switch-slider"></span>
                      </label>
                    </div>
                  )}
                  {staff.role === "owner" && <div className="oe-account-menu-divider" />}
                  <button 
                    className="oe-account-menu-logout" 
                    onClick={() => { setAccountMenuOpen(false); onLogout(); }}
                  >
                    Log Out
                  </button>
                </div>
              </>
            )}
          </div>
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
            {activeCategory?.items.flatMap((item) => {
              if (item.variants.length > 0) {
                return item.variants.map((v) => (
                  <div
                    key={`${item.id}-${v.id}`}
                    className="oe-item-card"
                    onClick={() => handleItemClick(item, v)}
                  >
                    <span className="oe-item-card__name">
                      {getFormattedVariantItemName(item.name, v.name)}
                    </span>
                    {item.description && (
                      <span className="oe-item-card__desc">{item.description}</span>
                    )}
                    <span className="oe-item-card__price">
                      ${parseFloat(v.price).toFixed(2)}
                    </span>
                    <div className="oe-item-card__badges">
                      {item.addons.length > 0 && (
                        <span className="oe-item-card__badge oe-item-card__badge--addon">
                          + free add-on
                        </span>
                      )}
                    </div>
                  </div>
                ));
              }
              return (
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
                    {item.addons.length > 0 && (
                      <span className="oe-item-card__badge oe-item-card__badge--addon">
                        + free add-on
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Cart */}
        <div className={`oe-cart${cartCollapsed ? " oe-cart--collapsed" : ""}`}>
          {cartCollapsed ? (
            <div className="oe-cart__collapsed-view" onClick={() => setCartCollapsed(false)}>
              <div className="oe-cart__collapsed-icon">🛒</div>
              <div className="oe-cart__collapsed-badge">{cartItemsCount}</div>
            </div>
          ) : (
            <>
              <div className="oe-cart__header">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
                  <h2 className="oe-cart__title">Current Order</h2>
                  <button 
                    className="oe-cart__collapse-btn" 
                    onClick={() => setCartCollapsed(true)}
                    title="Collapse Cart"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6"></polyline>
                    </svg>
                  </button>
                </div>
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
                              {line.modifiers.map((m) => m.quantity > 1 ? `${m.quantity}× ${m.optionName}` : m.optionName).join(", ")}
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
            </>
          )}
        </div>
      </div>

      {/* Item Modal */}
      {modalItem && (
        <ItemModal
          item={modalItem}
          initialVariant={modalVariant}
          onAdd={addToCart}
          onClose={() => {
            setModalItem(null);
            setModalVariant(null);
          }}
        />
      )}
    </div>
  );
}
