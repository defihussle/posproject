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
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [creatingInCat, setCreatingInCat] = useState(null); // category id, or null
  const [togglingIds, setTogglingIds] = useState(() => new Set());

  // GET /api/backoffice/menu is now the ONE authoritative source for
  // everything shown here, including modifier groups/options (full CRUD —
  // it used to be view-only data fetched separately from the public menu
  // endpoint; that's gone now that groups/options are editable in place).
  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/backoffice/menu?staffId=${staff.id}`);
      const menuData = await res.json();
      if (!res.ok) throw new Error(menuData.error || `HTTP ${res.status}`);
      setMenu(menuData);
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
                : [...cat.items, { ...updated, variants: [], modifier_groups: [] }],
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

  // ---- Modifier group/option local-state helpers ----
  // A group's OWN fields (name/required/min/max/active) are one shared row,
  // so an edit must update every item that currently shows it, not just the
  // item it was edited from. A brand-new group is always created scoped to
  // one item (creation always includes item_id), so it's added there only.
  const applyModifierGroupEverywhere = useCallback((updated) => {
    setMenu((prev) =>
      prev.map((cat) => ({
        ...cat,
        items: cat.items.map((it) => ({
          ...it,
          modifier_groups: it.modifier_groups.map((g) =>
            g.id === updated.id ? { ...g, ...updated } : g
          ),
        })),
      }))
    );
  }, []);

  const addModifierGroupToItem = useCallback((itemId, created) => {
    setMenu((prev) =>
      prev.map((cat) => ({
        ...cat,
        items: cat.items.map((it) =>
          it.id !== itemId
            ? it
            : { ...it, modifier_groups: [...it.modifier_groups, { ...created, options: created.options || [] }] }
        ),
      }))
    );
  }, []);

  // Delete-entirely removes the group from every item that had it (matches
  // the ON DELETE CASCADE on the server). Unlink removes it from one item
  // only — the group and its options keep existing for whoever else uses it.
  const removeModifierGroupEverywhere = useCallback((groupId) => {
    setMenu((prev) =>
      prev.map((cat) => ({
        ...cat,
        items: cat.items.map((it) => ({
          ...it,
          modifier_groups: it.modifier_groups.filter((g) => g.id !== groupId),
        })),
      }))
    );
  }, []);

  const unlinkModifierGroupFromItem = useCallback((itemId, groupId) => {
    setMenu((prev) =>
      prev.map((cat) => ({
        ...cat,
        items: cat.items.map((it) =>
          it.id !== itemId
            ? it
            : { ...it, modifier_groups: it.modifier_groups.filter((g) => g.id !== groupId) }
        ),
      }))
    );
  }, []);

  // An option belongs to exactly one group, but that group may be shared
  // across items, so option changes are applied everywhere that group appears.
  const applyModifierOptionEverywhere = useCallback((updated) => {
    setMenu((prev) =>
      prev.map((cat) => ({
        ...cat,
        items: cat.items.map((it) => ({
          ...it,
          modifier_groups: it.modifier_groups.map((g) =>
            g.id !== updated.group_id
              ? g
              : {
                  ...g,
                  options: g.options.some((o) => o.id === updated.id)
                    ? g.options.map((o) => (o.id === updated.id ? updated : o))
                    : [...g.options, updated],
                }
          ),
        })),
      }))
    );
  }, []);

  const removeModifierOptionEverywhere = useCallback((groupId, optionId) => {
    setMenu((prev) =>
      prev.map((cat) => ({
        ...cat,
        items: cat.items.map((it) => ({
          ...it,
          modifier_groups: it.modifier_groups.map((g) =>
            g.id !== groupId ? g : { ...g, options: g.options.filter((o) => o.id !== optionId) }
          ),
        })),
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
              onToggle86={() => toggle86(selectedItem)}
              onSaved={applyItem}
              onVariantSaved={applyVariant}
              onGroupSaved={applyModifierGroupEverywhere}
              onGroupCreated={(created) => addModifierGroupToItem(selectedItem.id, created)}
              onGroupDeletedEverywhere={removeModifierGroupEverywhere}
              onGroupUnlinked={(groupId) => unlinkModifierGroupFromItem(selectedItem.id, groupId)}
              onOptionSaved={applyModifierOptionEverywhere}
              onOptionDeleted={removeModifierOptionEverywhere}
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
function ItemDetail({
  item,
  category,
  staff,
  busy,
  onToggle86,
  onSaved,
  onVariantSaved,
  onGroupSaved,
  onGroupCreated,
  onGroupDeletedEverywhere,
  onGroupUnlinked,
  onOptionSaved,
  onOptionDeleted,
  onError,
}) {
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

      <ModifierGroupsSection
        item={item}
        staff={staff}
        groups={item.modifier_groups}
        onGroupSaved={onGroupSaved}
        onGroupCreated={onGroupCreated}
        onGroupDeletedEverywhere={onGroupDeletedEverywhere}
        onGroupUnlinked={onGroupUnlinked}
        onOptionSaved={onOptionSaved}
        onOptionDeleted={onOptionDeleted}
        onError={onError}
      />
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

// ---------- Modifier Groups (full CRUD) ----------
// A group may be shared by several items (e.g. a common "Ingredients"
// group) — "Remove from item" only unlinks it here (always safe, never
// touches order history or other items); "Delete group" removes the
// definition entirely everywhere it's used, and is blocked server-side
// (409) if any of its options were ever ordered.
function ModifierGroupsSection({
  item,
  staff,
  groups,
  onGroupSaved,
  onGroupCreated,
  onGroupDeletedEverywhere,
  onGroupUnlinked,
  onOptionSaved,
  onOptionDeleted,
  onError,
}) {
  const [addingGroup, setAddingGroup] = useState(false);

  return (
    <div className="menued__section">
      <div className="menued__section-title">Modifier Groups</div>

      {groups.length === 0 && !addingGroup && (
        <div className="menued__section-empty">No modifier groups on this item yet</div>
      )}

      <div className="menued__modgroups">
        {groups.map((g) => (
          <ModifierGroupCard
            key={g.id}
            item={item}
            group={g}
            staff={staff}
            onGroupSaved={onGroupSaved}
            onGroupDeletedEverywhere={onGroupDeletedEverywhere}
            onGroupUnlinked={onGroupUnlinked}
            onOptionSaved={onOptionSaved}
            onOptionDeleted={onOptionDeleted}
            onError={onError}
          />
        ))}
      </div>

      {addingGroup ? (
        <NewModifierGroupForm
          staff={staff}
          itemId={item.id}
          onCreated={(created) => {
            onGroupCreated(created);
            setAddingGroup(false);
          }}
          onCancel={() => setAddingGroup(false)}
          onError={onError}
        />
      ) : (
        <button className="menued__add-variant" onClick={() => setAddingGroup(true)}>
          + Add modifier group
        </button>
      )}
    </div>
  );
}

function NewModifierGroupForm({ staff, itemId, onCreated, onCancel, onError }) {
  const [name, setName] = useState("");
  const [required, setRequired] = useState(false);
  const [minSelect, setMinSelect] = useState("0");
  const [maxSelect, setMaxSelect] = useState("1");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    if (!name.trim()) {
      onError("Group name is required");
      return;
    }
    const min = Number(minSelect);
    const max = Number(maxSelect);
    if (!Number.isInteger(min) || min < 0 || !Number.isInteger(max) || max < 1 || min > max) {
      onError("min/max select must be whole numbers, with min ≤ max");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/backoffice/modifier-groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: staff.id,
          item_id: itemId,
          name: name.trim(),
          required,
          min_select: min,
          max_select: max,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onError(null);
      onCreated(data);
    } catch (err) {
      onError(err.message || "Failed to create modifier group");
      setSaving(false);
    }
  };

  return (
    <div className="menued__modgroup menued__modgroup--new">
      <div className="menued__modgroup-formrow">
        <input
          className="menued__variant-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Group name (e.g. Toppings)"
          autoFocus
        />
        <label className="menued__inline-check">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
          Required
        </label>
      </div>
      <div className="menued__modgroup-formrow">
        <label className="menued__minmax">
          Min
          <input
            className="menued__minmax-input"
            value={minSelect}
            onChange={(e) => setMinSelect(e.target.value)}
            inputMode="numeric"
          />
        </label>
        <label className="menued__minmax">
          Max
          <input
            className="menued__minmax-input"
            value={maxSelect}
            onChange={(e) => setMaxSelect(e.target.value)}
            inputMode="numeric"
          />
        </label>
        <button className="menued__save menued__save--sm" onClick={save} disabled={saving}>
          {saving ? "…" : "Add group"}
        </button>
        <button className="menued__cancel menued__cancel--sm" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ModifierGroupCard({ item, group, staff, onGroupSaved, onGroupDeletedEverywhere, onGroupUnlinked, onOptionSaved, onOptionDeleted, onError }) {
  const [draft, setDraft] = useState({
    name: group.name,
    required: group.required,
    min_select: String(group.min_select),
    max_select: String(group.max_select),
  });
  const [saving, setSaving] = useState(false);
  const [busy86, setBusy86] = useState(false);
  const [addingOption, setAddingOption] = useState(false);

  const dirty =
    draft.name !== group.name ||
    draft.required !== group.required ||
    draft.min_select !== String(group.min_select) ||
    draft.max_select !== String(group.max_select);

  const discard = () =>
    setDraft({
      name: group.name,
      required: group.required,
      min_select: String(group.min_select),
      max_select: String(group.max_select),
    });

  const put = async (body) => {
    const res = await fetch(`${API_URL}/api/backoffice/modifier-groups/${group.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ staffId: staff.id, ...body }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  const save = async () => {
    if (saving || !dirty) return;
    const min = Number(draft.min_select);
    const max = Number(draft.max_select);
    if (!draft.name.trim()) {
      onError("Group name can't be empty");
      return;
    }
    if (!Number.isInteger(min) || min < 0 || !Number.isInteger(max) || max < 1 || min > max) {
      onError("min/max select must be whole numbers, with min ≤ max");
      return;
    }
    setSaving(true);
    try {
      const data = await put({
        name: draft.name.trim(),
        required: draft.required,
        min_select: min,
        max_select: max,
        active: group.active,
      });
      onGroupSaved(data);
      onError(null);
    } catch (err) {
      onError(err.message || "Failed to save modifier group");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async () => {
    if (busy86) return;
    setBusy86(true);
    try {
      const data = await put({
        name: group.name,
        required: group.required,
        min_select: group.min_select,
        max_select: group.max_select,
        active: !group.active,
      });
      onGroupSaved(data);
      onError(null);
    } catch (err) {
      onError(err.message || "Failed to update modifier group");
    } finally {
      setBusy86(false);
    }
  };

  const removeFromItem = async () => {
    try {
      const res = await fetch(
        `${API_URL}/api/backoffice/item-modifier-groups/${item.id}/${group.id}?staffId=${staff.id}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onGroupUnlinked(group.id);
      onError(null);
    } catch (err) {
      onError(err.message || "Failed to remove group from item");
    }
  };

  const deleteEverywhere = async () => {
    try {
      const res = await fetch(
        `${API_URL}/api/backoffice/modifier-groups/${group.id}?staffId=${staff.id}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onGroupDeletedEverywhere(group.id);
      onError(null);
    } catch (err) {
      // Most common case here is the 409 "used in past orders" block —
      // surfaced via the shared error banner, same as everywhere else.
      onError(err.message || "Failed to delete modifier group");
    }
  };

  return (
    <div className={`menued__modgroup${group.active ? "" : " menued__modgroup--inactive"}`}>
      <div className="menued__modgroup-formrow">
        <input
          className="menued__variant-name menued__modgroup-nameinput"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        />
        <label className="menued__inline-check">
          <input
            type="checkbox"
            checked={draft.required}
            onChange={(e) => setDraft((d) => ({ ...d, required: e.target.checked }))}
          />
          Required
        </label>
        <span className={`menued__status-pill menued__status-pill--sm${group.active ? "" : " menued__status-pill--off"}`}>
          {group.active ? "Active" : "Inactive"}
        </span>
      </div>

      <div className="menued__modgroup-formrow">
        <label className="menued__minmax">
          Min
          <input
            className="menued__minmax-input"
            value={draft.min_select}
            onChange={(e) => setDraft((d) => ({ ...d, min_select: e.target.value }))}
            inputMode="numeric"
          />
        </label>
        <label className="menued__minmax">
          Max
          <input
            className="menued__minmax-input"
            value={draft.max_select}
            onChange={(e) => setDraft((d) => ({ ...d, max_select: e.target.value }))}
            inputMode="numeric"
          />
        </label>

        {dirty && (
          <>
            <button className="menued__save menued__save--sm" onClick={save} disabled={saving}>
              {saving ? "…" : "Save"}
            </button>
            <button className="menued__cancel menued__cancel--sm" onClick={discard} disabled={saving}>
              Discard
            </button>
          </>
        )}

        <div className="menued__modgroup-actions">
          <button className="menued__86-btn menued__86-btn--sm" onClick={toggleActive} disabled={busy86}>
            {busy86 ? "…" : group.active ? "Deactivate" : "Reactivate"}
          </button>
          <button className="menued__text-link" onClick={removeFromItem}>
            Remove from item
          </button>
          <button className="menued__text-link menued__text-link--danger" onClick={deleteEverywhere}>
            Delete group
          </button>
        </div>
      </div>

      <div className="menued__modgroup-optionlist">
        {group.options.map((o) => (
          <ModifierOptionRow
            key={o.id}
            groupId={group.id}
            option={o}
            staff={staff}
            onSaved={onOptionSaved}
            onDeleted={onOptionDeleted}
            onError={onError}
          />
        ))}
        {addingOption ? (
          <NewModifierOptionForm
            staff={staff}
            groupId={group.id}
            onCreated={(created) => {
              onOptionSaved(created);
              setAddingOption(false);
            }}
            onCancel={() => setAddingOption(false)}
            onError={onError}
          />
        ) : (
          <button className="menued__add-variant menued__add-variant--sm" onClick={() => setAddingOption(true)}>
            + Add option
          </button>
        )}
      </div>
    </div>
  );
}

function ModifierOptionRow({ groupId, option, staff, onSaved, onDeleted, onError }) {
  const [draft, setDraft] = useState({
    name: option.name,
    price_delta: String(option.price_delta),
    max_quantity: String(option.max_quantity),
    default_selected: option.default_selected,
  });
  const [saving, setSaving] = useState(false);

  const dirty =
    draft.name !== option.name ||
    draft.price_delta !== String(option.price_delta) ||
    draft.max_quantity !== String(option.max_quantity) ||
    draft.default_selected !== option.default_selected;

  const discard = () =>
    setDraft({
      name: option.name,
      price_delta: String(option.price_delta),
      max_quantity: String(option.max_quantity),
      default_selected: option.default_selected,
    });

  const save = async () => {
    if (saving || !dirty) return;
    if (!draft.name.trim()) {
      onError("Option name can't be empty");
      return;
    }
    const delta = Number(draft.price_delta);
    const maxQ = Number(draft.max_quantity);
    if (!Number.isFinite(delta) || delta < 0) {
      onError("Price must be zero or a positive number");
      return;
    }
    if (!Number.isInteger(maxQ) || maxQ < 1) {
      onError("Max quantity must be a positive whole number");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/backoffice/modifier-options/${option.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: staff.id,
          name: draft.name.trim(),
          price_delta: delta,
          max_quantity: maxQ,
          default_selected: draft.default_selected,
          active: option.active,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onSaved(data);
      onError(null);
    } catch (err) {
      onError(err.message || "Failed to save modifier option");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async () => {
    try {
      const res = await fetch(`${API_URL}/api/backoffice/modifier-options/${option.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: staff.id,
          name: option.name,
          price_delta: option.price_delta,
          max_quantity: option.max_quantity,
          default_selected: option.default_selected,
          active: !option.active,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onSaved(data);
      onError(null);
    } catch (err) {
      onError(err.message || "Failed to update modifier option");
    }
  };

  const remove = async () => {
    try {
      const res = await fetch(
        `${API_URL}/api/backoffice/modifier-options/${option.id}?staffId=${staff.id}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onDeleted(groupId, option.id);
      onError(null);
    } catch (err) {
      // Most common case here is the 409 "used in past orders" block.
      onError(err.message || "Failed to delete modifier option");
    }
  };

  return (
    <div className={`menued__option-row${option.active ? "" : " menued__option-row--inactive"}`}>
      <input
        className="menued__variant-name"
        value={draft.name}
        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
      />
      <div className="menued__price-input-wrap menued__price-input-wrap--sm">
        <span className="menued__price-prefix">$</span>
        <input
          className="menued__price-input"
          value={draft.price_delta}
          onChange={(e) => setDraft((d) => ({ ...d, price_delta: e.target.value }))}
          inputMode="decimal"
        />
      </div>
      <label className="menued__minmax menued__minmax--tight">
        Max qty
        <input
          className="menued__minmax-input"
          value={draft.max_quantity}
          onChange={(e) => setDraft((d) => ({ ...d, max_quantity: e.target.value }))}
          inputMode="numeric"
        />
      </label>
      <label className="menued__inline-check">
        <input
          type="checkbox"
          checked={draft.default_selected}
          onChange={(e) => setDraft((d) => ({ ...d, default_selected: e.target.checked }))}
        />
        Default
      </label>

      {dirty && (
        <>
          <button className="menued__save menued__save--sm" onClick={save} disabled={saving}>
            {saving ? "…" : "Save"}
          </button>
          <button className="menued__cancel menued__cancel--sm" onClick={discard} disabled={saving}>
            Discard
          </button>
        </>
      )}

      <button className="menued__text-link" onClick={toggleActive}>
        {option.active ? "Deactivate" : "Reactivate"}
      </button>
      <button className="menued__text-link menued__text-link--danger" onClick={remove}>
        Remove
      </button>
    </div>
  );
}

function NewModifierOptionForm({ staff, groupId, onCreated, onCancel, onError }) {
  const [name, setName] = useState("");
  const [priceDelta, setPriceDelta] = useState("0.00");
  const [maxQuantity, setMaxQuantity] = useState("1");
  const [defaultSelected, setDefaultSelected] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    if (!name.trim()) {
      onError("Option name is required");
      return;
    }
    const delta = Number(priceDelta);
    const maxQ = Number(maxQuantity);
    if (!Number.isFinite(delta) || delta < 0) {
      onError("Price must be zero or a positive number");
      return;
    }
    if (!Number.isInteger(maxQ) || maxQ < 1) {
      onError("Max quantity must be a positive whole number");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/backoffice/modifier-options`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: staff.id,
          group_id: groupId,
          name: name.trim(),
          price_delta: delta,
          max_quantity: maxQ,
          default_selected: defaultSelected,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onError(null);
      onCreated(data);
    } catch (err) {
      onError(err.message || "Failed to create modifier option");
      setSaving(false);
    }
  };

  return (
    <div className="menued__option-row menued__option-row--new">
      <input
        className="menued__variant-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Option name"
        autoFocus
      />
      <div className="menued__price-input-wrap menued__price-input-wrap--sm">
        <span className="menued__price-prefix">$</span>
        <input
          className="menued__price-input"
          value={priceDelta}
          onChange={(e) => setPriceDelta(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
        />
      </div>
      <label className="menued__minmax menued__minmax--tight">
        Max qty
        <input
          className="menued__minmax-input"
          value={maxQuantity}
          onChange={(e) => setMaxQuantity(e.target.value)}
          inputMode="numeric"
        />
      </label>
      <label className="menued__inline-check">
        <input type="checkbox" checked={defaultSelected} onChange={(e) => setDefaultSelected(e.target.checked)} />
        Default
      </label>
      <button className="menued__save menued__save--sm" onClick={save} disabled={saving}>
        {saving ? "…" : "Add"}
      </button>
      <button className="menued__cancel menued__cancel--sm" onClick={onCancel} disabled={saving}>
        Cancel
      </button>
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
