import { useState, useEffect, useCallback } from "react";
import "./MenuManager.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

const fmtPrice = (p) => `$${parseFloat(p).toFixed(2)}`;

/**
 * Back Office → Menu tab: full menu management.
 * Shows ALL items including inactive ones (86'd items stay visible, greyed
 * out, so owners can reactivate them). All writes go through the
 * /api/backoffice endpoints, which re-verify owner/admin role server-side.
 */
export default function MenuManager({ staff }) {
  const [menu, setMenu] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openCats, setOpenCats] = useState(() => new Set());
  const [editingItem, setEditingItem] = useState(null); // item being edited in the modal
  const [addingToCat, setAddingToCat] = useState(null); // category id for "+ Add Item"
  const [togglingIds, setTogglingIds] = useState(() => new Set()); // in-flight 86 toggles

  const loadMenu = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/backoffice/menu?staffId=${staff.id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setMenu(data);
      setError(null);
      // First load: open every category so the whole menu is scannable
      setOpenCats((prev) => (prev.size === 0 ? new Set(data.map((c) => c.id)) : prev));
    } catch (err) {
      setError(err.message || "Failed to load menu");
    } finally {
      setLoading(false);
    }
  }, [staff.id]);

  useEffect(() => {
    loadMenu();
  }, [loadMenu]);

  const toggleCat = (catId) => {
    setOpenCats((prev) => {
      const s = new Set(prev);
      s.has(catId) ? s.delete(catId) : s.add(catId);
      return s;
    });
  };

  // Replace one item in local state (from a PUT/POST response)
  const applyItem = useCallback((updated) => {
    setMenu((prev) =>
      prev.map((cat) =>
        cat.id !== updated.category_id
          ? cat
          : {
              ...cat,
              items: cat.items.some((i) => i.id === updated.id)
                ? cat.items.map((i) => (i.id === updated.id ? { ...i, ...updated } : i))
                : [...cat.items, { ...updated, variants: [] }],
            }
      )
    );
  }, []);

  // Quick "86 It" — flips active with no form
  const toggle86 = useCallback(
    async (item) => {
      if (togglingIds.has(item.id)) return;
      setTogglingIds((prev) => new Set(prev).add(item.id));
      try {
        const res = await fetch(`${API_URL}/api/backoffice/menu-items/${item.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            staffId: staff.id,
            name: item.name,
            description: item.description,
            base_price: item.base_price,
            active: !item.active,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        applyItem(data);
        setError(null);
      } catch (err) {
        setError(err.message || "Failed to update item");
      } finally {
        setTogglingIds((prev) => {
          const s = new Set(prev);
          s.delete(item.id);
          return s;
        });
      }
    },
    [staff.id, applyItem, togglingIds]
  );

  // Replace one variant in local state
  const applyVariant = useCallback((updated) => {
    setMenu((prev) =>
      prev.map((cat) => ({
        ...cat,
        items: cat.items.map((it) =>
          it.id !== updated.item_id
            ? it
            : {
                ...it,
                variants: it.variants.some((v) => v.id === updated.id)
                  ? it.variants.map((v) => (v.id === updated.id ? updated : v))
                  : [...it.variants, updated],
              }
        ),
      }))
    );
  }, []);

  if (loading) return <div className="menumgr__notice">Loading menu…</div>;

  return (
    <div className="menumgr">
      {error && <div className="menumgr__error">{error}</div>}

      {menu.map((cat) => {
        const open = openCats.has(cat.id);
        return (
          <section key={cat.id} className="menumgr__cat">
            <button className="menumgr__cat-head" onClick={() => toggleCat(cat.id)}>
              <span className={`menumgr__cat-chev${open ? " menumgr__cat-chev--open" : ""}`}>
                ›
              </span>
              <h2 className="menumgr__cat-name">{cat.name}</h2>
              <span className="menumgr__cat-count">
                {cat.items.length} item{cat.items.length === 1 ? "" : "s"}
              </span>
            </button>

            {open && (
              <div className="menumgr__items">
                {cat.items.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    staff={staff}
                    busy={togglingIds.has(item.id)}
                    onToggle86={() => toggle86(item)}
                    onEdit={() => setEditingItem(item)}
                    onVariantSaved={applyVariant}
                    onError={setError}
                  />
                ))}
                <button className="menumgr__add-btn" onClick={() => setAddingToCat(cat.id)}>
                  + Add Item
                </button>
              </div>
            )}
          </section>
        );
      })}

      {editingItem && (
        <ItemEditModal
          item={editingItem}
          staff={staff}
          onSaved={(updated) => {
            applyItem(updated);
            setEditingItem(null);
          }}
          onClose={() => setEditingItem(null)}
        />
      )}

      {addingToCat && (
        <ItemAddModal
          categoryId={addingToCat}
          categoryName={menu.find((c) => c.id === addingToCat)?.name || ""}
          staff={staff}
          onSaved={(created) => {
            applyItem(created);
            setAddingToCat(null);
          }}
          onClose={() => setAddingToCat(null)}
        />
      )}
    </div>
  );
}

function ItemRow({ item, staff, busy, onToggle86, onEdit, onVariantSaved, onError }) {
  const [addingVariant, setAddingVariant] = useState(false);
  const hasVariants = item.variants.length > 0;

  return (
    <div className={`menumgr-item${item.active ? "" : " menumgr-item--inactive"}`}>
      <div className="menumgr-item__row">
        <div className="menumgr-item__info">
          <span className="menumgr-item__name">{item.name}</span>
          {!item.active && <span className="menumgr-item__badge">INACTIVE</span>}
          {item.description && (
            <span className="menumgr-item__desc">{item.description}</span>
          )}
        </div>
        <span className="menumgr-item__price">
          {hasVariants ? `${item.variants.length} options` : fmtPrice(item.base_price)}
        </span>
        <div className="menumgr-item__actions">
          <button
            className={`menumgr-item__btn86${item.active ? "" : " menumgr-item__btn86--off"}`}
            onClick={onToggle86}
            disabled={busy}
            title={item.active ? "Mark unavailable (86)" : "Reactivate"}
          >
            {busy ? "…" : item.active ? "86 It" : "Reactivate"}
          </button>
          <button className="menumgr-item__btn-edit" onClick={onEdit}>
            Edit
          </button>
        </div>
      </div>

      {hasVariants && (
        <div className="menumgr-item__variants">
          {item.variants.map((v) => (
            <VariantRow key={v.id} variant={v} staff={staff} onSaved={onVariantSaved} onError={onError} />
          ))}
          {addingVariant ? (
            <VariantForm
              staff={staff}
              itemId={item.id}
              onSaved={(created) => {
                onVariantSaved(created);
                setAddingVariant(false);
              }}
              onCancel={() => setAddingVariant(false)}
              onError={onError}
            />
          ) : (
            <button className="menumgr__add-variant" onClick={() => setAddingVariant(true)}>
              + Add Variant
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function VariantRow({ variant, staff, onSaved, onError }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <VariantForm
        staff={staff}
        variant={variant}
        onSaved={(updated) => {
          onSaved(updated);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
        onError={onError}
      />
    );
  }

  return (
    <div className="menumgr-variant">
      <span className="menumgr-variant__name">{variant.name}</span>
      <span className="menumgr-variant__price">{fmtPrice(variant.price)}</span>
      <button className="menumgr-variant__edit" onClick={() => setEditing(true)}>
        Edit
      </button>
    </div>
  );
}

// Inline variant form — edit (variant set) or add (itemId set)
function VariantForm({ staff, variant, itemId, onSaved, onCancel, onError }) {
  const [name, setName] = useState(variant?.name || "");
  const [price, setPrice] = useState(variant ? String(variant.price) : "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const isEdit = !!variant;
      const res = await fetch(
        isEdit
          ? `${API_URL}/api/backoffice/item-variants/${variant.id}`
          : `${API_URL}/api/backoffice/item-variants`,
        {
          method: isEdit ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isEdit
              ? { staffId: staff.id, name, price: Number(price) }
              : { staffId: staff.id, item_id: itemId, name, price: Number(price) }
          ),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onSaved(data);
    } catch (err) {
      onError(err.message || "Failed to save variant");
      setSaving(false);
    }
  };

  return (
    <div className="menumgr-variant menumgr-variant--form">
      <input
        className="menumgr__input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Variant name"
      />
      <input
        className="menumgr__input menumgr__input--price"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        placeholder="0.00"
        inputMode="decimal"
      />
      <button className="menumgr__save" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
      <button className="menumgr__cancel" onClick={onCancel} disabled={saving}>
        Cancel
      </button>
    </div>
  );
}

function ItemEditModal({ item, staff, onSaved, onClose }) {
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description || "");
  const [price, setPrice] = useState(String(item.base_price));
  const [active, setActive] = useState(item.active);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`${API_URL}/api/backoffice/menu-items/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: staff.id,
          name,
          description: description.trim() || null,
          base_price: Number(price),
          active,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onSaved(data);
    } catch (e) {
      setErr(e.message || "Failed to save");
      setSaving(false);
    }
  };

  return (
    <ModalShell title={`Edit — ${item.name}`} onClose={onClose}>
      {err && <div className="menumgr__error">{err}</div>}
      <label className="menumgr__label">
        Name
        <input className="menumgr__input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="menumgr__label">
        Description
        <textarea
          className="menumgr__input menumgr__input--area"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </label>
      <label className="menumgr__label">
        Base price
        <input
          className="menumgr__input menumgr__input--price"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          inputMode="decimal"
        />
      </label>
      <label className="menumgr__toggle-row">
        <span>Active (available to order)</span>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
      </label>
      <div className="menumgr__modal-actions">
        <button className="menumgr__cancel" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button className="menumgr__save" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}

function ItemAddModal({ categoryId, categoryName, staff, onSaved, onClose }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`${API_URL}/api/backoffice/menu-items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: staff.id,
          category_id: categoryId,
          name,
          description: description.trim() || null,
          base_price: Number(price),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onSaved(data);
    } catch (e) {
      setErr(e.message || "Failed to create item");
      setSaving(false);
    }
  };

  return (
    <ModalShell title={`Add Item — ${categoryName}`} onClose={onClose}>
      {err && <div className="menumgr__error">{err}</div>}
      <label className="menumgr__label">
        Name
        <input
          className="menumgr__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Horchata"
        />
      </label>
      <label className="menumgr__label">
        Description
        <textarea
          className="menumgr__input menumgr__input--area"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </label>
      <label className="menumgr__label">
        Base price
        <input
          className="menumgr__input menumgr__input--price"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
        />
      </label>
      <div className="menumgr__modal-actions">
        <button className="menumgr__cancel" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button className="menumgr__save" onClick={save} disabled={saving}>
          {saving ? "Adding…" : "Add Item"}
        </button>
      </div>
    </ModalShell>
  );
}

function ModalShell({ title, children, onClose }) {
  return (
    <div className="menumgr__overlay" onClick={onClose}>
      <div className="menumgr__modal" onClick={(e) => e.stopPropagation()}>
        <div className="menumgr__modal-head">
          <h3 className="menumgr__modal-title">{title}</h3>
          <button className="menumgr__modal-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="menumgr__modal-body">{children}</div>
      </div>
    </div>
  );
}
