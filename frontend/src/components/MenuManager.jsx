import { useState, useEffect, useCallback, useMemo } from "react";
import { API_URL } from "../config";
import "./MenuManager.css";

const fmtPrice = (p) => `$${parseFloat(p).toFixed(2)}`;

/**
 * Menu management — shared by Back Office (owner/admin nav section) and the
 * POS-reachable "Manage Menu" page (see ManageMenu.jsx). Same component,
 * same backend routes, both places — a two-pane editor inspired by
 * Shopify's product editor: a browsable list on the left, a focused detail
 * panel for whatever's selected on the right, inline editing throughout.
 *
 * Shows ALL items including inactive ones (86'd items stay visible, greyed
 * out, so owners/admins can reactivate them). All writes go through the
 * /api/backoffice endpoints, which re-verify owner/admin role server-side —
 * this file has zero client-side role gating of its own to duplicate, and
 * zero new backend routes.
 */
export default function MenuManager({ staff }) {
  const [menu, setMenu] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Modifier groups are read-only in this UI (no backend write route exists
  // for them) — sourced from the public menu endpoint purely for display,
  // indexed by item id. Active items only (the public route hides inactive
  // ones), which is fine since 86'd items aren't being sold either way.
  const [modGroupsByItem, setModGroupsByItem] = useState({});
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [creatingInCat, setCreatingInCat] = useState(null); // category id, or null
  const [togglingIds, setTogglingIds] = useState(() => new Set());

  const load = useCallback(async () => {
    try {
      const [menuRes, publicRes] = await Promise.all([
        fetch(`${API_URL}/api/backoffice/menu?staffId=${staff.id}`),
        fetch(`${API_URL}/api/menu/full`),
      ]);
      const menuData = await menuRes.json();
      if (!menuRes.ok) throw new Error(menuData.error || `HTTP ${menuRes.status}`);
      setMenu(menuData);

      if (publicRes.ok) {
        const publicData = await publicRes.json();
        const byItem = {};
        for (const cat of publicData) {
          for (const it of cat.items) {
            if (it.modifier_groups?.length) byItem[it.id] = it.modifier_groups;
          }
        }
        setModGroupsByItem(byItem);
      }
      setError(null);
      // First load: auto-select the first item so the detail panel isn't blank
      setSelectedItemId((prev) => prev ?? menuData.find((c) => c.items.length)?.items[0]?.id ?? null);
    } catch (err) {
      setError(err.message || "Failed to load menu");
    } finally {
      setLoading(false);
    }
  }, [staff.id]);

  useEffect(() => {
    load();
  }, [load]);

  // Flat lookup of the selected item + its category, across all categories
  const { selectedItem, selectedCat } = useMemo(() => {
    for (const cat of menu) {
      const item = cat.items.find((i) => i.id === selectedItemId);
      if (item) return { selectedItem: item, selectedCat: cat };
    }
    return { selectedItem: null, selectedCat: null };
  }, [menu, selectedItemId]);

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

  if (loading) return <div className="menued__notice">Loading menu…</div>;

  return (
    <div className="menued">
      {error && <div className="menued__error">{error}</div>}

      <div className="menued__shell">
        <aside className="menued__list">
          {menu.map((cat) => (
            <section key={cat.id} className="menued__cat">
              <div className="menued__cat-head">
                <span className="menued__cat-name">{cat.name}</span>
                <span className="menued__cat-count">{cat.items.length}</span>
              </div>
              {cat.items.map((item) => (
                <button
                  key={item.id}
                  className={`menued__list-item${
                    item.id === selectedItemId && !creatingInCat ? " menued__list-item--active" : ""
                  }${item.active ? "" : " menued__list-item--inactive"}`}
                  onClick={() => {
                    setCreatingInCat(null);
                    setSelectedItemId(item.id);
                  }}
                >
                  <span className="menued__list-item-name">{item.name}</span>
                  <span className="menued__list-item-meta">
                    {item.variants.length > 0 ? `${item.variants.length} options` : fmtPrice(item.base_price)}
                  </span>
                  {!item.active && <span className="menued__list-item-dot" title="Inactive" />}
                </button>
              ))}
              <button
                className={`menued__add-item${creatingInCat === cat.id ? " menued__add-item--active" : ""}`}
                onClick={() => {
                  setSelectedItemId(null);
                  setCreatingInCat(cat.id);
                }}
              >
                + Add item
              </button>
            </section>
          ))}
        </aside>

        <main className="menued__detail">
          {creatingInCat ? (
            <NewItemDetail
              staff={staff}
              categoryId={creatingInCat}
              categoryName={menu.find((c) => c.id === creatingInCat)?.name || ""}
              onCreated={(created) => {
                applyItem(created);
                setCreatingInCat(null);
                setSelectedItemId(created.id);
              }}
              onCancel={() => setCreatingInCat(null)}
              onError={setError}
            />
          ) : selectedItem ? (
            <ItemDetail
              key={selectedItem.id}
              item={selectedItem}
              category={selectedCat}
              staff={staff}
              busy={togglingIds.has(selectedItem.id)}
              modifierGroups={modGroupsByItem[selectedItem.id] || []}
              onToggle86={() => toggle86(selectedItem)}
              onSaved={applyItem}
              onVariantSaved={applyVariant}
              onError={setError}
            />
          ) : (
            <div className="menued__empty">
              <div className="menued__empty-title">No items yet</div>
              <div className="menued__empty-sub">Add one from a category on the left</div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ---------- Detail panel: existing item ----------
function ItemDetail({ item, category, staff, busy, modifierGroups, onToggle86, onSaved, onVariantSaved, onError }) {
  const [draft, setDraft] = useState(() => ({
    name: item.name,
    description: item.description || "",
    base_price: String(item.base_price),
  }));
  const [saving, setSaving] = useState(false);
  const [addingVariant, setAddingVariant] = useState(false);
  const hasVariants = item.variants.length > 0;

  // New item selected — reset the draft to match it
  useEffect(() => {
    setDraft({
      name: item.name,
      description: item.description || "",
      base_price: String(item.base_price),
    });
  }, [item.id, item.name, item.description, item.base_price]);

  const dirty =
    draft.name !== item.name ||
    draft.description !== (item.description || "") ||
    (!hasVariants && draft.base_price !== String(item.base_price));

  const discard = () =>
    setDraft({ name: item.name, description: item.description || "", base_price: String(item.base_price) });

  const save = async () => {
    if (saving || !dirty) return;
    if (!draft.name.trim()) {
      onError("Item name can't be empty");
      return;
    }
    const price = hasVariants ? parseFloat(item.base_price) : Number(draft.base_price);
    if (!Number.isFinite(price) || price <= 0) {
      onError("Price must be a positive number");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/backoffice/menu-items/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: staff.id,
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          base_price: price,
          active: item.active,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onSaved(data);
      onError(null);
    } catch (err) {
      onError(err.message || "Failed to save item");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="menued__panel">
      <div className="menued__panel-eyebrow">{category?.name}</div>

      <div className="menued__panel-head">
        <input
          className="menued__name-input"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          placeholder="Item name"
        />
        <div className="menued__status-cluster">
          <span className={`menued__status-pill${item.active ? "" : " menued__status-pill--off"}`}>
            {item.active ? "Active" : "Inactive"}
          </span>
          <button className="menued__86-btn" onClick={onToggle86} disabled={busy}>
            {busy ? "…" : item.active ? "86 It" : "Reactivate"}
          </button>
        </div>
      </div>

      <label className="menued__field-label" htmlFor="menued-desc">
        Description
      </label>
      <textarea
        id="menued-desc"
        className="menued__desc-input"
        value={draft.description}
        onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
        placeholder="No description"
        rows={2}
      />

      {hasVariants ? (
        <div className="menued__price-note">Priced by variant — see below</div>
      ) : (
        <>
          <label className="menued__field-label" htmlFor="menued-price">
            Base price
          </label>
          <div className="menued__price-input-wrap">
            <span className="menued__price-prefix">$</span>
            <input
              id="menued-price"
              className="menued__price-input"
              value={draft.base_price}
              onChange={(e) => setDraft((d) => ({ ...d, base_price: e.target.value }))}
              inputMode="decimal"
            />
          </div>
        </>
      )}

      {dirty && (
        <div className="menued__savebar">
          <span>Unsaved changes</span>
          <div className="menued__savebar-actions">
            <button className="menued__cancel" onClick={discard} disabled={saving}>
              Discard
            </button>
            <button className="menued__save" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      <div className="menued__section">
        <div className="menued__section-title">Variants</div>
        {hasVariants ? (
          <div className="menued__variant-table">
            {item.variants.map((v) => (
              <VariantRow key={v.id} variant={v} staff={staff} onSaved={onVariantSaved} onError={onError} />
            ))}
          </div>
        ) : (
          <div className="menued__section-empty">No variants — this item has a single price</div>
        )}
        {addingVariant ? (
          <VariantRow
            staff={staff}
            itemId={item.id}
            isNew
            onSaved={(created) => {
              onVariantSaved(created);
              setAddingVariant(false);
            }}
            onCancel={() => setAddingVariant(false)}
            onError={onError}
          />
        ) : (
          <button className="menued__add-variant" onClick={() => setAddingVariant(true)}>
            + Add variant
          </button>
        )}
      </div>

      {modifierGroups.length > 0 && (
        <div className="menued__section">
          <div className="menued__section-title">
            Modifier Groups <span className="menued__readonly-tag">View only</span>
          </div>
          <div className="menued__modgroups">
            {modifierGroups.map((g) => (
              <div key={g.id} className="menued__modgroup">
                <div className="menued__modgroup-name">
                  {g.name}
                  {g.required && <span className="menued__modgroup-required">Required</span>}
                </div>
                <div className="menued__modgroup-options">
                  {g.options.map((o) => (
                    <span key={o.id} className="menued__modgroup-option">
                      {o.name}
                      {parseFloat(o.price_delta) > 0 && (
                        <span className="menued__modgroup-price"> +{fmtPrice(o.price_delta)}</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// One variant row — inline-editable in place, or (isNew) an inline
// creation row. No modal either way.
function VariantRow({ variant, itemId, isNew, staff, onSaved, onCancel, onError }) {
  const [name, setName] = useState(variant?.name || "");
  const [price, setPrice] = useState(variant ? String(variant.price) : "");
  const [saving, setSaving] = useState(false);

  const dirty = !isNew && (name !== variant.name || price !== String(variant.price));

  const discard = () => {
    setName(variant.name);
    setPrice(String(variant.price));
  };

  const save = async () => {
    if (saving) return;
    if (!name.trim()) {
      onError("Variant name can't be empty");
      return;
    }
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) {
      onError("Variant price must be a positive number");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        isNew
          ? `${API_URL}/api/backoffice/item-variants`
          : `${API_URL}/api/backoffice/item-variants/${variant.id}`,
        {
          method: isNew ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isNew
              ? { staffId: staff.id, item_id: itemId, name: name.trim(), price: p }
              : { staffId: staff.id, name: name.trim(), price: p }
          ),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onSaved(data);
      onError(null);
      if (isNew) {
        setName("");
        setPrice("");
      }
    } catch (err) {
      onError(err.message || "Failed to save variant");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`menued__variant-row${isNew ? " menued__variant-row--new" : ""}`}>
      <input
        className="menued__variant-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Variant name"
      />
      <div className="menued__price-input-wrap menued__price-input-wrap--sm">
        <span className="menued__price-prefix">$</span>
        <input
          className="menued__price-input"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
        />
      </div>
      {isNew ? (
        <>
          <button className="menued__save menued__save--sm" onClick={save} disabled={saving}>
            {saving ? "…" : "Add"}
          </button>
          <button className="menued__cancel menued__cancel--sm" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        </>
      ) : (
        dirty && (
          <>
            <button className="menued__save menued__save--sm" onClick={save} disabled={saving}>
              {saving ? "…" : "Save"}
            </button>
            <button className="menued__cancel menued__cancel--sm" onClick={discard} disabled={saving}>
              Discard
            </button>
          </>
        )
      )}
    </div>
  );
}

// ---------- Detail panel: creating a new item ----------
function NewItemDetail({ staff, categoryId, categoryName, onCreated, onCancel, onError }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    if (!name.trim()) {
      onError("Item name is required");
      return;
    }
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) {
      onError("Base price must be a positive number");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/backoffice/menu-items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: staff.id,
          category_id: categoryId,
          name: name.trim(),
          description: description.trim() || null,
          base_price: p,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onError(null);
      onCreated(data);
    } catch (err) {
      onError(err.message || "Failed to create item");
      setSaving(false);
    }
  };

  return (
    <div className="menued__panel">
      <div className="menued__panel-eyebrow">New item in {categoryName}</div>

      <div className="menued__panel-head">
        <input
          className="menued__name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Item name"
          autoFocus
        />
      </div>

      <label className="menued__field-label" htmlFor="menued-new-desc">
        Description
      </label>
      <textarea
        id="menued-new-desc"
        className="menued__desc-input"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="No description"
        rows={2}
      />

      <label className="menued__field-label" htmlFor="menued-new-price">
        Base price
      </label>
      <div className="menued__price-input-wrap">
        <span className="menued__price-prefix">$</span>
        <input
          id="menued-new-price"
          className="menued__price-input"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
        />
      </div>

      <div className="menued__savebar menued__savebar--create">
        <span>New items start active</span>
        <div className="menued__savebar-actions">
          <button className="menued__cancel" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button className="menued__save" onClick={save} disabled={saving}>
            {saving ? "Creating…" : "Create item"}
          </button>
        </div>
      </div>
    </div>
  );
}
