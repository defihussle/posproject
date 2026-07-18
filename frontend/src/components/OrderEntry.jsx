import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import ItemModal from "./ItemModal";
import { StaffAddForm } from "./StaffManager";
import logoImg from "../assets/narcos-tacos-logo.png";
import { API_URL } from "../config";
import "./OrderEntry.css";
import "./StaffManager.css";

// Roles allowed to quick-add staff from the POS account dropdown
const STAFF_QUICKADD_ROLES = ["owner", "admin", "manager"];
// Roles allowed onto the POS-side "Manage Menu" page — owner/admin only,
// same as Back Office's Menu Management section (real enforcement is
// server-side on every write; this only controls what the dropdown offers)
const MANAGE_MENU_ROLES = ["owner", "admin"];

const TAX_RATE = 0.13; // Ontario HST — display only; the server is the source of truth
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Discount — available to every role that can check out (owner/admin/
// manager/cashier), closing the "discounts" capability that was part of
// the original role design but never built. Presets + a manual custom %;
// a reason is REQUIRED (server rejects a percent with no valid reason —
// this list is a client-side mirror, kept in sync with DISCOUNT_REASONS
// in backend/server.js).
const DISCOUNT_PRESETS = [10, 20, 50];
const DISCOUNT_REASONS = [
  { key: "family", label: "Family" },
  { key: "friend", label: "Friend" },
  { key: "employee", label: "Employee" },
  { key: "neighbouring_store", label: "Neighbouring Store" },
];
const DISCOUNT_REASON_LABEL = Object.fromEntries(DISCOUNT_REASONS.map((r) => [r.key, r.label]));

// Swipe-to-delete tuning (cart line rows) — px of leftward drag.
const SWIPE_REVEAL_PX = 76; // how far a partial swipe reveals the delete icon
const SWIPE_DELETE_PX = 140; // swipe past this and release = delete immediately
const SWIPE_MAX_PX = 220; // hard clamp so a fast/long drag can't overshoot

export default function OrderEntry({ staff, theme, onToggleTheme, onLogout }) {
  const navigate = useNavigate();
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

  // Discount — { percent, reason } | null. Cleared on successful checkout,
  // same lifecycle as the cart itself.
  const [discount, setDiscount] = useState(null);
  const [discountFormOpen, setDiscountFormOpen] = useState(false);

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

  // Discount + tax + total for the checkout screen — all display only, the
  // server ALWAYS recomputes from its own subtotal and never trusts a
  // dollar amount from the client (same principle as item/modifier
  // pricing). Tax is charged on the discounted amount, matching how HST is
  // actually applied at point of sale when a % discount is given.
  const discountAmount = useMemo(
    () => (discount ? round2(subtotal * (discount.percent / 100)) : 0),
    [subtotal, discount]
  );
  const discountedSubtotal = useMemo(
    () => round2(subtotal - discountAmount),
    [subtotal, discountAmount]
  );
  const tax = useMemo(() => round2(discountedSubtotal * TAX_RATE), [discountedSubtotal]);
  const total = useMemo(() => round2(discountedSubtotal + tax), [discountedSubtotal, tax]);

  // Map the cart into the /api/orders payload. Only sends WHAT was selected
  // (ids + quantities) — never prices; the server recomputes those. Same
  // for the discount: only percent + reason are sent, never a dollar figure.
  const buildOrderPayload = useCallback(
    (method) => ({
      staffId: staff.id,
      paymentMethod: method,
      ...(discount ? { discount: { percent: discount.percent, reason: discount.reason } } : {}),
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
    [cart, staff.id, discount]
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
        // Success — clear the cart + discount, show a brief confirmation, auto-dismiss
        setConfirmation({ orderNumber: data.order_number });
        setCart([]);
        setDiscount(null);
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
                  {MANAGE_MENU_ROLES.includes(staff.role) && (
                    <button
                      className="oe-account-menu-item"
                      onClick={() => {
                        setAccountMenuOpen(false);
                        navigate("/manage-menu");
                      }}
                    >
                      Manage Menu
                    </button>
                  )}
                  {STAFF_QUICKADD_ROLES.includes(staff.role) && (
                    <button
                      className="oe-account-menu-item"
                      onClick={() => {
                        setAccountMenuOpen(false);
                        setStaffModalOpen(true);
                      }}
                    >
                      Staff Management
                    </button>
                  )}
                  {(MANAGE_MENU_ROLES.includes(staff.role) || STAFF_QUICKADD_ROLES.includes(staff.role)) && (
                    <div className="oe-account-menu-divider" />
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
                      ${parseFloat(v.price).toFixed(2)} +tax
                    </span>
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
                  <span className="oe-item-card__price">{getPriceDisplay(item)} +tax</span>
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
                  <h2 className="oe-cart__title">Cart</h2>
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
                    <CartLine
                      key={line.cartLineId}
                      line={line}
                      onAdjustQty={adjustQty}
                      onRemove={removeItem}
                    />
                  ))
                )}
              </div>

              {cart.length > 0 && (
                <div className="oe-cart__footer">
                  <DiscountControl
                    discount={discount}
                    open={discountFormOpen}
                    onOpenChange={setDiscountFormOpen}
                    onApply={(d) => {
                      setDiscount(d);
                      setDiscountFormOpen(false);
                    }}
                    onClear={() => setDiscount(null)}
                  />

                  <div className="oe-cart__subtotal">
                    <span className="oe-cart__subtotal-label">Subtotal</span>
                    <span className="oe-cart__subtotal-amount">${subtotal.toFixed(2)}</span>
                  </div>
                  {discount && (
                    <div className="oe-cart__subtotal oe-cart__subtotal--discount">
                      <span className="oe-cart__subtotal-label">
                        Discount ({discount.percent}%)
                      </span>
                      <span className="oe-cart__subtotal-amount">
                        −${discountAmount.toFixed(2)}
                      </span>
                    </div>
                  )}
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
              endpoint="/api/staff/quick-add"
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
                  {discount && (
                    <div className="oe-checkout__row oe-checkout__row--discount">
                      <span>
                        Discount — {discount.percent}% · {DISCOUNT_REASON_LABEL[discount.reason]}
                      </span>
                      <span>−${discountAmount.toFixed(2)}</span>
                    </div>
                  )}
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

/**
 * One cart row — swipe left to reveal a delete icon (tap it to remove), or
 * swipe far enough and release to delete immediately, matching common
 * native list conventions. Replaces the old persistent "Remove" button.
 *
 * Gesture handling:
 * - The first ~8px of movement decides the axis (horizontal vs vertical).
 *   Once locked to vertical, this row does nothing for the rest of the
 *   gesture — the cart list's normal scroll takes over untouched.
 * - Horizontal drag only ever moves leftward (rightward attempts clamp to
 *   the current resting position) and is hard-capped at SWIPE_MAX_PX so a
 *   fast flick can't overshoot visually.
 * - Releasing mid-drag always resolves to one of three resting states:
 *   fully closed, revealed (delete icon showing), or deleted — never stuck
 *   at an arbitrary offset, per the "no broken state on an incomplete swipe"
 *   requirement.
 */
function CartLine({ line, onAdjustQty, onRemove }) {
  const [dragX, setDragX] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const touchRef = useRef({ startX: 0, startY: 0, axis: null });

  const handleTouchStart = (e) => {
    const t = e.touches[0];
    touchRef.current = { startX: t.clientX, startY: t.clientY, axis: null };
    setDragging(true);
  };

  const handleTouchMove = (e) => {
    const ts = touchRef.current;
    const t = e.touches[0];
    const dx = t.clientX - ts.startX;
    const dy = t.clientY - ts.startY;

    if (ts.axis === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; // too small to tell yet
      ts.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (ts.axis !== "x") return; // vertical gesture — let the list scroll normally

    // No preventDefault() here: React attaches touch listeners as passive, so
    // calling it would just throw and do nothing. `touch-action: pan-y` on
    // .oe-cart-line (see CSS) is what actually stops the browser from also
    // scrolling/rubber-banding during a horizontal drag — that's handled at
    // the compositor level before JS ever runs.
    const base = revealed ? -SWIPE_REVEAL_PX : 0;
    setDragX(Math.max(Math.min(base + dx, 0), -SWIPE_MAX_PX));
  };

  const resolveSwipe = () => {
    const ts = touchRef.current;
    if (ts.axis === "x") {
      if (dragX <= -SWIPE_DELETE_PX) {
        onRemove(line.cartLineId);
        return; // row is gone — nothing left to settle
      }
      if (dragX <= -SWIPE_REVEAL_PX / 2) {
        setDragX(-SWIPE_REVEAL_PX);
        setRevealed(true);
      } else {
        setDragX(0);
        setRevealed(false);
      }
    }
    touchRef.current = { startX: 0, startY: 0, axis: null };
    setDragging(false);
  };

  return (
    <div className="oe-cart-line-wrap">
      <button
        className="oe-cart-line__delete-reveal"
        onClick={() => onRemove(line.cartLineId)}
        aria-label={`Remove ${line.itemName}`}
        tabIndex={revealed ? 0 : -1}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>

      <div
        className="oe-cart-line"
        style={{ transform: `translateX(${dragX}px)`, transition: dragging ? "none" : undefined }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={resolveSwipe}
        onTouchCancel={resolveSwipe}
      >
        <div className="oe-cart-line__top">
          <div className="oe-cart-line__info">
            <div className="oe-cart-line__name">{line.itemName}</div>
            {line.variant && (
              <div className="oe-cart-line__variant">{line.variant.name}</div>
            )}
            {/* Removed default ingredients (e.g. "no onion") — same signal
                KDS shows on the ticket, mirrored here so it isn't only
                visible after the order's already been sent to the kitchen. */}
            {line.removedIngredients?.length > 0 && (
              <div className="oe-cart-line__removed">
                {line.removedIngredients.map((name) => (
                  <span key={name} className="oe-cart-line__removed-tag">
                    NO {name}
                  </span>
                ))}
              </div>
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
            onClick={() => onAdjustQty(line.cartLineId, -1)}
          >
            −
          </button>
          <span className="oe-cart-line__qty">{line.quantity}</span>
          <button
            className="oe-cart-line__qty-btn"
            onClick={() => onAdjustQty(line.cartLineId, 1)}
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Cart-level discount control. Three states:
 *  - nothing applied, panel closed → a plain "+ Add Discount" link
 *  - applied, panel closed → a compact chip showing percent + reason, with
 *    Edit (reopens pre-filled) and × (clears immediately) actions
 *  - panel open → preset buttons (10/20/50%) + a custom % field + the 4
 *    required reason categories + Apply/Cancel
 *
 * A reason is mandatory by construction here: Apply stays disabled until
 * both a valid percent AND a reason are set, so the cart can never reach
 * checkout in a "percent but no reason" state — the server enforces the
 * same rule independently as the real backstop.
 */
function DiscountControl({ discount, open, onOpenChange, onApply, onClear }) {
  const [percent, setPercent] = useState("");
  const [reason, setReason] = useState(null);

  // Opening the panel seeds it from whatever's currently applied (or blank)
  useEffect(() => {
    if (open) {
      setPercent(discount ? String(discount.percent) : "");
      setReason(discount ? discount.reason : null);
    }
  }, [open, discount]);

  const numericPercent = Number(percent);
  const canApply = percent !== "" && numericPercent > 0 && numericPercent <= 100 && !!reason;

  if (open) {
    return (
      <div className="oe-discount-panel">
        <div className="oe-discount-panel__title">Apply Discount</div>

        <div className="oe-discount-presets">
          {DISCOUNT_PRESETS.map((p) => (
            <button
              key={p}
              className={`oe-discount-preset${numericPercent === p ? " oe-discount-preset--active" : ""}`}
              onClick={() => setPercent(String(p))}
            >
              {p}%
            </button>
          ))}
          <div className="oe-discount-custom">
            <input
              className="oe-discount-custom-input"
              value={percent}
              onChange={(e) => setPercent(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="Custom"
              inputMode="decimal"
            />
            <span className="oe-discount-custom-suffix">%</span>
          </div>
        </div>

        <div className="oe-discount-panel__label">Reason — required</div>
        <div className="oe-discount-reasons">
          {DISCOUNT_REASONS.map((r) => (
            <button
              key={r.key}
              className={`oe-discount-reason${reason === r.key ? " oe-discount-reason--active" : ""}`}
              onClick={() => setReason(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>

        <div className="oe-discount-panel__actions">
          <button className="oe-discount-cancel" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button
            className="oe-discount-apply"
            disabled={!canApply}
            onClick={() => onApply({ percent: numericPercent, reason })}
          >
            Apply
          </button>
        </div>
      </div>
    );
  }

  if (discount) {
    return (
      <div className="oe-discount-chip">
        <span className="oe-discount-chip__icon">🏷</span>
        <span className="oe-discount-chip__text">
          {discount.percent}% off — {DISCOUNT_REASON_LABEL[discount.reason]}
        </span>
        <button className="oe-discount-chip__edit" onClick={() => onOpenChange(true)}>
          Edit
        </button>
        <button className="oe-discount-chip__remove" onClick={onClear} aria-label="Remove discount">
          ×
        </button>
      </div>
    );
  }

  return (
    <button className="oe-discount-add" onClick={() => onOpenChange(true)}>
      + Add Discount
    </button>
  );
}
