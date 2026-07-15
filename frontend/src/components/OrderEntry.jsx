import { useState, useEffect, useMemo, useCallback } from "react";
import ItemModal from "./ItemModal";
import { StaffAddForm } from "./StaffManager";
import logoImg from "../assets/narcos-tacos-logo.png";
import { API_URL } from "../config";
import "./OrderEntry.css";
import "./StaffManager.css";

// Roles allowed to quick-add staff from the POS account dropdown
const STAFF_QUICKADD_ROLES = ["owner", "admin", "manager"];

const TAX_RATE = 0.13; // Ontario HST — display only; the server is the source of truth
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export default function OrderEntry({ staff, theme, onToggleTheme, onLogout }) {
  const [menu, setMenu] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeCatId, setActiveCatId] = useState(null);
  const [modalItem, setModalItem] = useState(null);
  const [modalVariant, setModalVariant] = useState(null);
  const [cart, setCart] = useState([]);
  const [cartCollapsed, setCartCollapsed] = useState(true);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [staffModalOpen, setStaffModalOpen] = useState(false);
  const [staffAddedName, setStaffAddedName] = useState(null); // brief success note

  // Checkout flow state
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState(null);
  const [confirmation, setConfirmation] = useState(null); // { orderNumber }

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

  // Tax + total for the checkout screen (display only — server recomputes)
  const tax = useMemo(() => round2(subtotal * TAX_RATE), [subtotal]);
  const total = useMemo(() => round2(subtotal + tax), [subtotal, tax]);

  // Map the cart into the /api/orders payload. Only sends WHAT was selected
  // (ids + quantities) — never prices; the server recomputes those.
  const buildOrderPayload = useCallback(
    (method) => ({
      staffId: staff.id,
      paymentMethod: method,
      items: cart.map((line) => ({
        itemId: line.itemId,
        variantId: line.variant ? line.variant.id : null,
        quantity: line.quantity,
        notes: line.notes || null,
        modifiers: line.modifiers.map((m) => ({
          optionId: m.optionId,
          quantity: m.quantity,
        })),
        addons: line.addons.map((a) => ({
          addonId: a.addonId,
          extraQty: a.extraQty,
        })),
      })),
    }),
    [cart, staff.id]
  );

  const openCheckout = useCallback(() => {
    setCheckoutError(null);
    setConfirmation(null);
    setCheckoutOpen(true);
  }, []);

  const closeCheckout = useCallback(() => {
    if (submitting) return; // don't allow closing mid-submit
    setCheckoutOpen(false);
    setCheckoutError(null);
  }, [submitting]);

  // Submit the order with the chosen payment method
  const handleCheckout = useCallback(
    async (method) => {
      if (submitting) return;
      setSubmitting(true);
      setCheckoutError(null);
      try {
        const res = await fetch(`${API_URL}/api/orders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildOrderPayload(method)),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Something went wrong. Please try again.");
        }
        // Success — clear the cart, show a brief confirmation, auto-dismiss
        setConfirmation({ orderNumber: data.order_number });
        setCart([]);
        setTimeout(() => {
          setConfirmation(null);
          setCheckoutOpen(false);
          setSubmitting(false);
        }, 2000);
      } catch (err) {
        // Failure — keep the cart intact so nothing is lost, let staff retry
        setCheckoutError(err.message || "Network error. Please try again.");
        setSubmitting(false);
      }
    },
    [submitting, buildOrderPayload]
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
                  {STAFF_QUICKADD_ROLES.includes(staff.role) && (
                    <>
                      <button
                        className="oe-account-menu-item"
                        onClick={() => {
                          setAccountMenuOpen(false);
                          setStaffModalOpen(true);
                        }}
                      >
                        Staff Management
                      </button>
                      <div className="oe-account-menu-divider" />
                    </>
                  )}
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
                  <button className="oe-cart__checkout-btn" onClick={openCheckout}>
                    Checkout · ${total.toFixed(2)}
                  </button>
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

      {/* Staff quick-add modal — add-only by design; list/edit/deactivate/PIN
          reset live in Back Office, keeping the counter screen simple */}
      {staffModalOpen && (
        <div className="staffmgr__overlay" onClick={() => setStaffModalOpen(false)}>
          <div className="staffmgr__modal" onClick={(e) => e.stopPropagation()}>
            <div className="staffmgr__modal-head">
              <h3 className="staffmgr__modal-title">Add Staff</h3>
              <button
                className="staffmgr__modal-close"
                onClick={() => setStaffModalOpen(false)}
                aria-label="Close"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <StaffAddForm
              staff={staff}
              onCreated={(created) => {
                setStaffModalOpen(false);
                setStaffAddedName(created.name);
                setTimeout(() => setStaffAddedName(null), 2500);
              }}
              onCancel={() => setStaffModalOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Brief confirmation after quick-adding staff */}
      {staffAddedName && (
        <div className="oe-staff-added-toast">✓ {staffAddedName} added to staff</div>
      )}

      {/* Checkout Modal */}
      {checkoutOpen && (
        <div
          className="oe-checkout-overlay"
          onClick={confirmation ? undefined : closeCheckout}
        >
          <div className="oe-checkout" onClick={(e) => e.stopPropagation()}>
            {confirmation ? (
              <div className="oe-checkout__success">
                <div className="oe-checkout__success-check">
                  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </div>
                <div className="oe-checkout__success-title">
                  Order #{confirmation.orderNumber}
                </div>
                <div className="oe-checkout__success-sub">sent to kitchen</div>
              </div>
            ) : (
              <>
                <div className="oe-checkout__header">
                  <h2 className="oe-checkout__title">Payment</h2>
                  <button
                    className="oe-checkout__close"
                    onClick={closeCheckout}
                    disabled={submitting}
                    aria-label="Close"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                <div className="oe-checkout__summary">
                  <div className="oe-checkout__row">
                    <span>Subtotal</span>
                    <span>${subtotal.toFixed(2)}</span>
                  </div>
                  <div className="oe-checkout__row">
                    <span>Tax (13%)</span>
                    <span>${tax.toFixed(2)}</span>
                  </div>
                  <div className="oe-checkout__row oe-checkout__row--total">
                    <span>Total</span>
                    <span>${total.toFixed(2)}</span>
                  </div>
                </div>

                {checkoutError && (
                  <div className="oe-checkout__error">{checkoutError}</div>
                )}

                <div className="oe-checkout__methods">
                  <button
                    className="oe-checkout__method"
                    onClick={() => handleCheckout("cash")}
                    disabled={submitting}
                  >
                    <span className="oe-checkout__method-icon">💵</span>
                    <span>Cash</span>
                  </button>
                  <button
                    className="oe-checkout__method"
                    onClick={() => handleCheckout("card")}
                    disabled={submitting}
                  >
                    <span className="oe-checkout__method-icon">💳</span>
                    <span>Card</span>
                  </button>
                </div>

                {submitting && (
                  <div className="oe-checkout__processing">Processing…</div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
