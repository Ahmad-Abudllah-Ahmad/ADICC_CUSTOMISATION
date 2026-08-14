// LayersIllustratorPanel — an Adobe-Illustrator-style Layers panel.
//
// STATUS: UI-only. Everything below runs on DUMMY in-memory data so the look
// and the interactions can be reviewed before the real takeoff shapes are
// wired in. The ten behaviours the panel must eventually cover are numbered
// against the code so integration is a matter of swapping the dummy store for
// live shapes:
//   1. one row per drawn thing            → the tree leaves
//   2. group / ungroup (Ctrl+Shift+G/U)   → groupSelection() / ungroupSelection()
//   3. smart group totals + linked move   → summarise() (linked move = future)
//   4. per-row eye / lock + type colour    → KIND meta + row toggles
//   5. Ctrl/Shift-click multi-select       → react-arborist native (node.handleClick)
//   6. nested groups, parent selects kids  → react-arborist tree
//   7. left-rail icon, 2nd from top        → wired in TakeoffCanvas
//   8. right-click context menu            → <ContextMenu>
//   9. drag-and-drop into other groups     → react-arborist onMove
//  10. Illustrator look                     → .ill-* styles in app.css
//
// The real wiring (points 1–3 linked move, persistence) is intentionally left
// for a follow-up; nothing here touches the live shape store.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Tree } from "react-arborist";
import { Icon } from "../brand/icons.jsx";

// ── shape-kind palette — colour per type (req #4), unit + label per type ──────
const KIND = {
  group: { label: "Group", color: "#1a5276", unit: "" },
  line: { label: "Line", color: "#a0402a", unit: "m" },
  curve: { label: "Curve", color: "#6b4c7a", unit: "m" },
  rect: { label: "Rectangle", color: "#154360", unit: "m\u00B2" },
  area: { label: "Area", color: "#1e6b4a", unit: "m\u00B2" },
  count: { label: "Count", color: "#b8860b", unit: "ea" },
};
const kindOf = (n) => KIND[n.kind] || KIND.line;

// ── dummy takeoff, nested the way Illustrator nests art (req #1, #6) ──────────
const SEED = [
  {
    id: "L1", name: "Level 1 — Floor Plan", kind: "group", children: [
      {
        id: "z-n", name: "Zone A — North", kind: "group", children: [
          {
            id: "g-101", name: "Room 101", kind: "group", children: [
              { id: "s1", name: "Wall A", kind: "line", value: 5 },
              { id: "s2", name: "Wall B", kind: "line", value: 4 },
              { id: "s3", name: "Carpet CPT-1", kind: "area", value: 18.4 },
            ],
          },
          {
            id: "g-102", name: "Room 102", kind: "group", children: [
              { id: "s11", name: "Wall C", kind: "line", value: 6.2 },
              { id: "s12", name: "Tile CT-2", kind: "area", value: 11.1 },
            ],
          },
        ],
      },
      {
        id: "z-s", name: "Zone B — South", kind: "group", children: [
          { id: "s4", name: "Slab edge", kind: "rect", value: 24 },
          { id: "s5", name: "Corridor LVT-2", kind: "area", value: 31.2 },
          { id: "s6", name: "Sockets", kind: "count", value: 6 },
          { id: "s13", name: "Base trim", kind: "curve", value: 8.4 },
        ],
      },
    ],
  },
  {
    id: "L2", name: "Level 2 — Reflected Ceiling", kind: "group", children: [
      {
        id: "z-lt", name: "Lighting", kind: "group", children: [
          { id: "s7", name: "Cove trim", kind: "curve", value: 12.6 },
          { id: "s9", name: "Diffusers", kind: "count", value: 14 },
          { id: "s14", name: "Pendants", kind: "count", value: 8 },
        ],
      },
      {
        id: "z-cl", name: "Ceiling", kind: "group", children: [
          { id: "s8", name: "Tile CT-1", kind: "area", value: 9.8 },
          { id: "s15", name: "Bulkhead", kind: "rect", value: 4.2 },
        ],
      },
    ],
  },
  {
    id: "L3", name: "Level 3 — Roof", kind: "group", children: [
      { id: "s16", name: "Parapet", kind: "line", value: 42 },
      { id: "s17", name: "Gutter", kind: "curve", value: 18.5 },
      { id: "s18", name: "Skylight", kind: "rect", value: 3.6 },
    ],
  },
  {
    id: "SITE", name: "Site plan", kind: "group", children: [
      { id: "s19", name: "Boundary", kind: "line", value: 86 },
      { id: "s20", name: "Parking", kind: "area", value: 120 },
      { id: "s21", name: "Path", kind: "curve", value: 22 },
    ],
  },
  { id: "s10", name: "Detail callout", kind: "line", value: 2.3, locked: true },
];

// ── tree utilities (pure, immutable-ish via clone) ────────────────────────────
let seq = 1;
const uid = (p) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const clone = (nodes) =>
  nodes.map((n) => ({ ...n, children: n.children ? clone(n.children) : n.children }));

// DFS document order with each node's parentId + index within its parent.
function flatten(nodes, parentId = null, out = []) {
  nodes.forEach((n, i) => {
    out.push({ node: n, id: n.id, parentId, index: i });
    if (n.children) flatten(n.children, n.id, out);
  });
  return out;
}

// Locate a node in a (mutable) tree: returns its sibling array + index.
function locate(nodes, id) {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return { siblings: nodes, index: i, node: nodes[i] };
    if (nodes[i].children) {
      const hit = locate(nodes[i].children, id);
      if (hit) return hit;
    }
  }
  return null;
}

function childrenArrayFor(nodes, parentId) {
  if (parentId == null) return nodes;
  const hit = locate(nodes, parentId);
  if (!hit) return nodes;
  if (!hit.node.children) hit.node.children = [];
  return hit.node.children;
}

// Sum descendant measures by unit so a group shows 5m + 4m = 9m (req #3).
function summarise(node) {
  const totals = {};
  const add = (n) => {
    if (n.children) { n.children.forEach(add); return; }
    const u = kindOf(n).unit;
    if (!u) return;
    totals[u] = (totals[u] || 0) + (Number(n.value) || 0);
  };
  add(node);
  const round = (v) => (Math.round(v * 10) / 10);
  return Object.entries(totals)
    .map(([u, v]) => `${round(v)} ${u}`)
    .join(" \u00B7 ");
}

// Which selected ids are "top-most" (no selected ancestor) — for grouping.
function topMost(nodes, idSet) {
  const flat = flatten(nodes);
  const parentChain = new Map();
  flat.forEach((f) => parentChain.set(f.id, f.parentId));
  const hasSelectedAncestor = (id) => {
    let p = parentChain.get(id);
    while (p != null) {
      if (idSet.has(p)) return true;
      p = parentChain.get(p);
    }
    return false;
  };
  return flat
    .filter((f) => idSet.has(f.id) && !hasSelectedAncestor(f.id))
    .map((f) => f.id);
}

// Ancestor trunks + an elbow/tee into this row (req: nested connector lines).
function guideKinds(node) {
  const chain = [];
  for (let a = node.parent; a && !a.isRoot; a = a.parent) chain.unshift(a);
  return chain.map((anc, j) => (
    j < node.level - 1
      ? (anc.nextSibling ? "trunk" : "blank")
      : (node.nextSibling ? "tee" : "elbow")
  ));
}

// ── small inline visuals ──────────────────────────────────────────────────────
function KindGlyph({ node }) {
  if (node.kind !== "group") return null;
  return (
    <span className="ill-thumb ill-thumb-group" aria-hidden="true">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 6 h6 l2 2 h10 v11 H3 Z" />
      </svg>
    </span>
  );
}

// ── the panel ─────────────────────────────────────────────────────────────────
export default function LayersIllustratorPanel({ onClose }) {
  const [data, setData] = useState(() => clone(SEED));
  const [selIds, setSelIds] = useState([]);
  const [menu, setMenu] = useState(null); // { x, y, kind: "row" | "panel", nodeId }
  const [q, setQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const treeRef = useRef(null);
  const panelRef = useRef(null);

  // fit react-arborist (virtualised → needs px width/height) to the body --------
  const bodyRef = useRef(null);
  const [size, setSize] = useState({ width: 300, height: 360 });
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const cr = entry.contentRect;
      setSize({ width: Math.max(180, Math.floor(cr.width)), height: Math.max(120, Math.floor(cr.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── data handlers ────────────────────────────────────────────────────────────
  const onMove = useCallback(({ dragIds, parentId, index }) => {
    setData((prev) => {
      const flat = flatten(prev);
      const orderMap = new Map(flat.map((f) => [f.id, { parentId: f.parentId, index: f.index }]));
      // pull dragged nodes out in document order
      const ordered = flat.filter((f) => dragIds.includes(f.id)).map((f) => f.id);
      const next = clone(prev);
      const grabbed = [];
      ordered.forEach((id) => {
        const hit = locate(next, id);
        if (hit) { grabbed.push(hit.node); hit.siblings.splice(hit.index, 1); }
      });
      // adjust destination index for items removed from the same parent above it
      const removedBefore = ordered.filter((id) => {
        const o = orderMap.get(id);
        return o && o.parentId === parentId && o.index < index;
      }).length;
      const target = childrenArrayFor(next, parentId);
      const at = Math.min(Math.max(0, index - removedBefore), target.length);
      target.splice(at, 0, ...grabbed);
      return next;
    });
  }, []);

  const onRename = useCallback(({ id, name }) => {
    setData((prev) => {
      const next = clone(prev);
      const hit = locate(next, id);
      if (hit) hit.node.name = name;
      return next;
    });
  }, []);

  const patch = useCallback((id, changes) => {
    setData((prev) => {
      const next = clone(prev);
      const hit = locate(next, id);
      if (hit) Object.assign(hit.node, typeof changes === "function" ? changes(hit.node) : changes);
      return next;
    });
  }, []);

  const removeIds = useCallback((ids) => {
    setData((prev) => {
      const next = clone(prev);
      ids.forEach((id) => {
        const hit = locate(next, id);
        if (hit) hit.siblings.splice(hit.index, 1);
      });
      return next;
    });
    setSelIds((s) => s.filter((id) => !ids.includes(id)));
  }, []);

  const duplicateIds = useCallback((ids) => {
    setData((prev) => {
      const next = clone(prev);
      const made = [];
      ids.forEach((id) => {
        const hit = locate(next, id);
        if (!hit) return;
        const copy = clone([hit.node])[0];
        const rekey = (n) => { n.id = uid("dup"); if (n.children) n.children.forEach(rekey); };
        rekey(copy);
        copy.name = `${hit.node.name} copy`;
        hit.siblings.splice(hit.index + 1, 0, copy);
        made.push(copy.id);
      });
      return next;
    });
  }, []);

  // req #2 — group selected into a new group at the top-most selection's spot
  const groupSelection = useCallback(() => {
    setData((prev) => {
      const idSet = new Set(selIds);
      const ids = topMost(prev, idSet);
      if (ids.length < 1) return prev;
      const next = clone(prev);
      // anchor = parent + index of the first (document order) grouped node
      const firstFlat = flatten(next).find((f) => f.id === ids[0]);
      const anchorParent = firstFlat ? firstFlat.parentId : null;
      const anchorIndex = firstFlat ? firstFlat.index : 0;
      const grabbed = [];
      ids.forEach((id) => {
        const hit = locate(next, id);
        if (hit) { grabbed.push(hit.node); hit.siblings.splice(hit.index, 1); }
      });
      const gid = uid("grp");
      const group = { id: gid, name: "Group", kind: "group", children: grabbed };
      const target = childrenArrayFor(next, anchorParent);
      target.splice(Math.min(anchorIndex, target.length), 0, group);
      queueMicrotask(() => setSelIds([gid]));
      return next;
    });
  }, [selIds]);

  // req #2 — ungroup: splice each selected group's children into its place
  const ungroupSelection = useCallback(() => {
    setData((prev) => {
      const next = clone(prev);
      const promoted = [];
      // operate on a stable snapshot of currently-selected group ids
      selIds.forEach((id) => {
        const hit = locate(next, id);
        if (hit && hit.node.kind === "group" && hit.node.children) {
          const kids = hit.node.children;
          hit.siblings.splice(hit.index, 1, ...kids);
          promoted.push(...kids.map((k) => k.id));
        }
      });
      if (promoted.length) queueMicrotask(() => setSelIds(promoted));
      return next;
    });
  }, [selIds]);

  const newLayer = useCallback(() => {
    const id = uid("lay");
    setData((prev) => [{ id, name: "Layer", kind: "group", children: [] }, ...clone(prev)]);
    queueMicrotask(() => setSelIds([id]));
  }, []);

  const deleteHidden = useCallback(() => {
    const ids = flatten(data).filter((f) => f.node.hidden).map((f) => f.id);
    if (ids.length) removeIds(ids);
  }, [data, removeIds]);

  // ── selection helpers ─────────────────────────────────────────────────────────
  const selNodes = useMemo(() => {
    const map = new Map(flatten(data).map((f) => [f.id, f.node]));
    return selIds.map((id) => map.get(id)).filter(Boolean);
  }, [selIds, data]);
  const canGroup = topMost(data, new Set(selIds)).length >= 2;
  const canUngroup = selNodes.some((n) => n.kind === "group");

  // ── keyboard: Ctrl+Shift+G / Ctrl+Shift+U (req #2), Delete ───────────────────
  const onKeyDown = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && (e.key === "G" || e.key === "g")) {
      e.preventDefault(); e.stopPropagation(); groupSelection(); return;
    }
    if (mod && e.shiftKey && (e.key === "U" || e.key === "u")) {
      e.preventDefault(); e.stopPropagation(); ungroupSelection(); return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selIds.length && !e.target.closest("input")) {
      e.preventDefault(); e.stopPropagation(); removeIds(selIds);
    }
    if (e.key === "Escape" && searchOpen && !e.target.closest(".ill-find")) {
      setQ(""); setSearchOpen(false);
    }
  };

  useEffect(() => {
    const onDown = (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (panelRef.current?.contains(t)) return;
      if (t.closest("button[aria-label='Layers panel']")) return;
      if (t.closest(".ill-menu")) return;
      onClose?.();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  // close any open menu on outside interaction
  useEffect(() => {
    if (!menu) return undefined;
    const close = (e) => {
      if (e.target instanceof Element && e.target.closest(".ill-menu")) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const openRowMenu = (e, nodeId) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selIds.includes(nodeId)) setSelIds([nodeId]);
    setMenu({ x: e.clientX, y: e.clientY, kind: "row", nodeId });
  };

  // ── the tree node renderer ─────────────────────────────────────────────────────
  const Node = ({ node, style, dragHandle }) => {
    const d = node.data;
    const meta = kindOf(d);
    const isGroup = d.kind === "group";
    const metric = isGroup ? summarise(d) : `${d.value} ${meta.unit}`;
    const rowPos = { ...(style || {}), paddingLeft: 0 };
    const guides = guideKinds(node);
    // hover readout — type + measured properties (req: "12 ea" on hover)
    const tip = [meta.label, metric, d.locked && "Locked", d.hidden && "Hidden"]
      .filter(Boolean)
      .join(" \u00B7 ");
    return (
      <div
        ref={dragHandle}
        className={`ill-row${node.isSelected ? " is-sel" : ""}${d.hidden ? " is-hidden" : ""}${d.locked ? " is-locked" : ""}${node.level === 0 ? " is-top" : ""}`}
        style={rowPos}
        onContextMenu={(e) => openRowMenu(e, d.id)}
      >
        <button
          type="button"
          className="ill-eye"
          onClick={(e) => { e.stopPropagation(); patch(d.id, (n) => ({ hidden: !n.hidden })); }}
          data-tip={d.hidden ? "Show" : "Hide"}
          aria-label={d.hidden ? "Show layer" : "Hide layer"}
        >
          <Icon name={d.hidden ? "eyeOff" : "eye"} size={16} />
        </button>
        <button
          type="button"
          className="ill-lock"
          onClick={(e) => { e.stopPropagation(); patch(d.id, (n) => ({ locked: !n.locked })); }}
          data-tip={d.locked ? "Unlock" : "Lock"}
          aria-label={d.locked ? "Unlock layer" : "Lock layer"}
        >
          {d.locked ? <Icon name="lock" size={12} /> : null}
        </button>

        <span className="ill-selstrip" style={{ background: meta.color }} aria-hidden="true" />

        <div className="ill-indent" data-tip={tip} data-tip-at="above">
          {guides.map((kind, i) => (
            <span key={i} className={`ill-guide is-${kind}`} aria-hidden="true">
              {kind !== "blank" && <span className="ill-guide-v" />}
              {(kind === "tee" || kind === "elbow") && <span className="ill-guide-h" />}
            </span>
          ))}
          {isGroup ? (
            <button
              type="button"
              className="ill-disc"
              onClick={(e) => { e.stopPropagation(); node.toggle(); }}
              aria-label={node.isOpen ? "Collapse" : "Expand"}
            >
              <Icon name={node.isOpen ? "chevronDown" : "chevronRight"} size={12} />
            </button>
          ) : (
            <span className="ill-disc ill-disc-empty" aria-hidden="true" />
          )}

          <KindGlyph node={d} />

          {node.isEditing ? (
            <input
              className="ill-rename"
              autoFocus
              defaultValue={d.name}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => node.reset()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") node.submit(e.currentTarget.value);
                if (e.key === "Escape") node.reset();
              }}
            />
          ) : (
            <span
              className="ill-name"
              title={d.name}
              onDoubleClick={(e) => { e.stopPropagation(); node.edit(); }}
            >
              {d.name}
            </span>
          )}

          <span className="ill-metric">{metric}</span>
        </div>
        <div className="ill-end">
          <button
            type="button"
            className="ill-target"
            onClick={(e) => { e.stopPropagation(); node.select(); }}
            data-tip="Target"
            aria-label="Target layer"
            aria-pressed={node.isSelected}
          />
          <span
            className={`ill-selsquare${node.isSelected ? " is-on" : ""}`}
            style={{ background: meta.color }}
            aria-hidden="true"
          />
        </div>
      </div>
    );
  };

  // ── context / panel-options menu ─────────────────────────────────────────────
  const menuNode = menu?.kind === "row" ? flatten(data).find((f) => f.id === menu.nodeId)?.node : null;
  const hiddenN = flatten(data).filter((f) => f.node.hidden).length;
  const rowMenuItems = [
    { label: "New Layer\u2026", icon: "plus", onClick: newLayer },
    { label: "Duplicate", icon: "duplicate", disabled: !selIds.length, onClick: () => duplicateIds(selIds) },
    { label: "Delete", icon: "trash", disabled: !selIds.length, danger: true, onClick: () => removeIds(selIds) },
    { sep: true },
    { label: "Group", hint: "Ctrl+Shift+G", disabled: !canGroup, onClick: groupSelection },
    { label: "Ungroup", hint: "Ctrl+Shift+U", disabled: !canUngroup, onClick: ungroupSelection },
    { sep: true },
    { label: "Rename", icon: "edit", disabled: !menuNode, onClick: () => { treeRef.current?.get(menu.nodeId)?.edit(); } },
    {
      label: menuNode?.hidden ? "Show" : "Hide",
      icon: menuNode?.hidden ? "eye" : "eyeOff",
      disabled: !menuNode,
      onClick: () => patch(menu.nodeId, (n) => ({ hidden: !n.hidden })),
    },
    {
      label: menuNode?.locked ? "Unlock" : "Lock",
      icon: menuNode?.locked ? "unlock" : "lock",
      disabled: !menuNode,
      onClick: () => patch(menu.nodeId, (n) => ({ locked: !n.locked })),
    },
  ];
  const panelMenuItems = [
    { label: "New Layer\u2026", icon: "plus", onClick: newLayer },
    { label: "Collapse all", icon: "chevronDown", onClick: () => treeRef.current?.closeAll() },
    { label: "Select all", icon: "select", onClick: () => treeRef.current?.selectAll() },
    { sep: true },
    { label: "Delete hidden", icon: "trash", disabled: !hiddenN, danger: true, onClick: deleteHidden },
  ];
  const menuItems = menu?.kind === "panel" ? panelMenuItems : rowMenuItems;

  return (
    <div
      ref={panelRef}
      className="ill-panel"
      role="dialog"
      aria-label="Layers"
      onKeyDown={onKeyDown}
    >
      <div className="ill-titlebar">
        <span className="ill-title">Layers</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="ill-icon-btn"
          onClick={(e) => { e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY + 8, kind: "panel" }); }}
          onPointerDown={(e) => e.stopPropagation()}
          data-tip="Panel options"
          aria-label="Panel options"
        >
          <span className="ill-hamburger" aria-hidden="true"><span /><span /><span /></span>
        </button>
        <button
          type="button"
          className="ill-icon-btn"
          onClick={(e) => { e.stopPropagation(); onClose?.(); }}
          onPointerDown={(e) => e.stopPropagation()}
          data-tip="Close"
          aria-label="Close layers panel"
        >
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="ill-toolbar">
        <button type="button" className="ill-tool" onClick={groupSelection} disabled={!canGroup} data-tip="Group (Ctrl+Shift+G)" aria-label="Group">Group</button>
        <button type="button" className="ill-tool" onClick={ungroupSelection} disabled={!canUngroup} data-tip="Ungroup (Ctrl+Shift+U)" aria-label="Ungroup">Ungroup</button>
      </div>

      <div className="ill-body" ref={bodyRef}>
        <Tree
          ref={treeRef}
          className="ill-scroll"
          data={data}
          idAccessor="id"
          childrenAccessor={(d) => d.children ?? null}
          openByDefault
          width={size.width}
          height={size.height}
          indent={14}
          rowHeight={32}
          overscanCount={8}
          searchTerm={q}
          searchMatch={(n, term) => String(n.data.name || "").toLowerCase().includes(String(term).toLowerCase())}
          disableDrag={(d) => !!d.locked}
          disableMultiSelection={false}
          onMove={onMove}
          onRename={onRename}
          onSelect={(nodes) => setSelIds(nodes.map((n) => n.id))}
        >
          {Node}
        </Tree>
      </div>

      <div className="ill-foot">
        <span className="ill-foot-count">{data.length} Layer{data.length === 1 ? "" : "s"}</span>
        {searchOpen ? (
          <input
            className="ill-find"
            value={q}
            autoFocus
            placeholder="Find layers…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setQ(""); setSearchOpen(false); }
            }}
          />
        ) : (
          <span style={{ flex: 1 }} />
        )}
        <button
          type="button"
          className="ill-icon-btn"
          onClick={() => { setSearchOpen((v) => { const next = !v; if (!next) setQ(""); return next; }); }}
          data-tip="Search"
          aria-label="Search layers"
          aria-pressed={searchOpen}
        >
          <Icon name="search" size={13} />
        </button>
        <button type="button" className="ill-icon-btn" onClick={newLayer} data-tip="New layer" aria-label="New layer">
          <Icon name="plus" size={13} />
        </button>
        <button
          type="button"
          className="ill-icon-btn is-danger"
          onClick={() => removeIds(selIds)}
          disabled={!selIds.length}
          data-tip="Delete selected"
          aria-label="Delete selected"
        >
          <Icon name="trash" size={13} />
        </button>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onPick={() => setMenu(null)} />
      )}
    </div>
  );
}

// ── floating menu, positioned at the cursor and clamped to the viewport ────────
function ContextMenu({ x, y, items, onPick }) {
  const ref = useRef(null);
  const [xy, setXy] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setXy({
      left: Math.min(x, window.innerWidth - r.width - 8),
      top: Math.min(y, window.innerHeight - r.height - 8),
    });
  }, [x, y]);
  return (
    <div
      ref={ref}
      className="ill-menu"
      style={{ left: xy.left, top: xy.top }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) =>
        it.sep ? (
          <div key={`sep-${i}`} className="ill-menu-sep" />
        ) : (
          <button
            key={it.label}
            type="button"
            className={`ill-menu-item${it.danger ? " is-danger" : ""}`}
            disabled={it.disabled}
            onClick={() => { if (!it.disabled) { it.onClick?.(); onPick?.(); } }}
          >
            <span>{it.label}</span>
            {(it.hint || it.icon) && (
              <span className="ill-menu-trail" aria-hidden="true">
                {it.hint && <span className="ill-menu-hint">{it.hint}</span>}
                {it.icon && (
                  <span className="ill-menu-glyph">
                    <Icon name={it.icon} size={13} />
                  </span>
                )}
              </span>
            )}
          </button>
        ),
      )}
    </div>
  );
}
