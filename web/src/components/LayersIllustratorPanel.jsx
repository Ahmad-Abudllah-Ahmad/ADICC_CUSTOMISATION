// LayersIllustratorPanel — Adobe-Illustrator-style Layers panel wired to live
// takeoff shapes. Hide / lock / group / select / delete / rename talk to
// TakeoffCanvas; groups nest in layerForest and persist with the takeoff.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Tree } from "react-arborist";
import { Icon } from "../brand/icons.jsx";
import {
  buildLayerTree,
  findNode,
  isFolderKind,
  kindOf,
  parentOf,
  sheetKeyFromNodeId,
  shapeIdsOnFocusSheet,
  shapeIdsUnder,
  togglePickIds,
  rangePickIds,
  isolateOtherIds,
  isIsolatedTo,
} from "../lib/layerTree.js";

function stopChrome(e) {
  e.stopPropagation();
}

function guideKinds(node) {
  const chain = [];
  for (let a = node.parent; a && !a.isRoot; a = a.parent) chain.unshift(a);
  return chain.map((anc, j) => (
    j < node.level - 1
      ? (anc.nextSibling ? "trunk" : "blank")
      : (node.nextSibling ? "tee" : "elbow")
  ));
}

function openDeep(node) {
  if (!node || node.isLeaf) return;
  node.open();
  (node.children || []).forEach(openDeep);
}

function KindGlyph({ node }) {
  if (!isFolderKind(node.kind)) return null;
  return (
    <span className="ill-thumb ill-thumb-group" aria-hidden="true">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 6 h6 l2 2 h10 v11 H3 Z" />
      </svg>
    </span>
  );
}

export default function LayersIllustratorPanel({
  embedded = false,
  closeOnOutside = true,
  onClose,
  shapes = [],
  condById = {},
  hiddenShapeIds = {},
  lockedShapeIds = {},
  layerForest = {},
  sheetKeys = [],
  sheetLabel = (k) => k,
  focusSheetKey,
  selectedIds = [],
  units = "imperial",
  sheetMatch,
  onSelectIds,
  onToggleHideIds,
  onToggleLockIds,
  onGroup,
  onUngroup,
  onDeleteIds,
  onDuplicateIds,
  onRename,
  onMove,
  onNewGroup,
}) {
  const data = useMemo(
    () => buildLayerTree({
      sheetKeys,
      sheetLabel,
      shapes,
      layerForest,
      condById,
      hiddenShapeIds,
      lockedShapeIds,
      units,
      sheetMatch,
    }),
    [sheetKeys, sheetLabel, shapes, layerForest, condById, hiddenShapeIds, lockedShapeIds, units, sheetMatch],
  );

  const [menu, setMenu] = useState(null);
  const [q, setQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const treeRef = useRef(null);
  const panelRef = useRef(null);
  const anchorIdRef = useRef(null);

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

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const leafCount = shapes.length;
  const sheetFolderCount = data.filter((n) => n.kind === "sheet").length;
  const groupCount = Object.keys(layerForest).length;
  const hiddenShapeCount = shapes.filter((s) => hiddenShapeIds[s.id]).length;

  const shapeIdsFor = useCallback((id) => {
    const n = findNode(data, id);
    if (!n) return [id];
    const ids = shapeIdsUnder(n);
    return ids.length ? ids : [];
  }, [data]);

  const pickIds = selectedIds;

  const canGroup = pickIds.length >= 2;
  const canUngroup = pickIds.some((id) => layerForest[id] || parentOf(layerForest, id));

  const emitSelect = useCallback((ids, opts) => {
    onSelectIds?.(ids, opts);
  }, [onSelectIds]);

  const visibleRowShapeIds = useCallback(() => {
    const nodes = treeRef.current?.visibleNodes;
    if (!Array.isArray(nodes)) return [];
    return nodes.map((n) => {
      if (!n?.data) return [];
      if (isFolderKind(n.data.kind)) return shapeIdsUnder(n.data);
      return n.id ? [n.id] : [];
    });
  }, []);

  const selectRow = useCallback((node, e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    panelRef.current?.focus?.({ preventScroll: true });
    const d = node?.data;
    if (!d) return;
    const rowIds = isFolderKind(d.kind) ? shapeIdsUnder(d) : (d.id ? [d.id] : []);
    const sheetKey = d.kind === "sheet" ? sheetKeyFromNodeId(d.id) : undefined;
    const opts = sheetKey ? { sheetKey } : undefined;
    const vis = visibleRowShapeIds();
    const idx = Array.isArray(treeRef.current?.visibleNodes)
      ? treeRef.current.visibleNodes.findIndex((n) => n.id === d.id)
      : -1;
    const mod = !!(e && (e.ctrlKey || e.metaKey));
    const shift = !!(e && e.shiftKey);
    const alt = !!(e && e.altKey);

    if (alt && !mod && !shift) {
      emitSelect(rowIds, opts);
      anchorIdRef.current = d.id;
      return;
    }
    if (shift) {
      const visNodes = treeRef.current?.visibleNodes;
      const anchor = anchorIdRef.current;
      const from = Array.isArray(visNodes) ? visNodes.findIndex((n) => n.id === anchor) : -1;
      emitSelect(rangePickIds(vis, from, idx), opts);
      return;
    }
    if (mod) {
      emitSelect(togglePickIds(pickIds, rowIds), opts);
      anchorIdRef.current = d.id;
      return;
    }
    emitSelect(rowIds, opts);
    anchorIdRef.current = d.id;
  }, [emitSelect, pickIds, visibleRowShapeIds]);

  // Arborist also selects on pointerdown. If that exclusive pick lands before our
  // click handler, Ctrl/Shift toggle reads the wiped set and looks like a no-op.
  // Mouse selection is selectRow only; arrows still move the tree focus.
  const onTreeSelect = useCallback(() => {}, []);

  const hideNode = useCallback((id, e) => {
    const n = findNode(data, id);
    const ids = shapeIdsFor(id);
    if (!ids.length && n?.kind !== "group" && n?.kind !== "sheet") return;
    const folder = n?.kind === "group" || n?.kind === "sheet";
    if (e?.altKey) {
      const all = shapes.map((s) => s.id);
      const keep = ids;
      if (isIsolatedTo(all, keep, hiddenShapeIds)) {
        onToggleHideIds?.(all, false);
      } else {
        const others = isolateOtherIds(all, keep);
        if (others.length) onToggleHideIds?.(others, true);
        if (keep.length) onToggleHideIds?.(folder ? [id, ...keep] : keep, false);
      }
      return;
    }
    const allHidden = ids.length ? ids.every((sid) => hiddenShapeIds[sid]) : !!n?.hidden;
    onToggleHideIds?.(folder ? [id, ...ids] : ids, !allHidden);
  }, [data, shapeIdsFor, shapes, hiddenShapeIds, onToggleHideIds]);

  const lockNode = useCallback((id, e) => {
    const n = findNode(data, id);
    if (!n) return;
    const ids = shapeIdsFor(id);
    if (!ids.length && n.kind !== "group" && n.kind !== "sheet") return;
    const folder = n.kind === "group" || n.kind === "sheet";
    if (e?.altKey) {
      const all = shapes.map((s) => s.id);
      const keep = ids;
      if (isIsolatedTo(all, keep, lockedShapeIds)) {
        onToggleLockIds?.(all, false);
      } else {
        const others = isolateOtherIds(all, keep);
        if (others.length) onToggleLockIds?.(others, true);
        if (keep.length) onToggleLockIds?.(folder ? [id, ...keep] : keep, false);
      }
      return;
    }
    const allLocked = ids.length ? ids.every((sid) => lockedShapeIds[sid]) : !!n.locked;
    onToggleLockIds?.(folder ? [id, ...ids] : ids, !allLocked);
  }, [data, shapeIdsFor, shapes, lockedShapeIds, onToggleLockIds]);

  const deleteSelection = useCallback((ids = pickIds) => {
    const out = [];
    for (const id of ids) out.push(...shapeIdsFor(id));
    const uniq = [...new Set(out)];
    if (uniq.length) onDeleteIds?.(uniq);
  }, [pickIds, shapeIdsFor, onDeleteIds]);

  const duplicateSelection = useCallback(() => {
    const out = [];
    for (const id of pickIds) out.push(...shapeIdsFor(id));
    const uniq = [...new Set(out)];
    if (uniq.length) onDuplicateIds?.(uniq);
  }, [pickIds, shapeIdsFor, onDuplicateIds]);

  const onTreeMove = useCallback(({ dragIds, parentId, index }) => {
    onMove?.({ dragIds, parentId, index });
  }, [onMove]);

  const onTreeRename = useCallback(({ id, name }) => {
    const n = findNode(data, id);
    if (!n || n.kind === "sheet") return;
    onRename?.(id, name, n.kind);
  }, [data, onRename]);

  const onKeyDown = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && (e.key === "a" || e.key === "A") && !e.target.closest("input")) {
      e.preventDefault(); e.stopPropagation();
      emitSelect(shapeIdsOnFocusSheet(shapes, focusSheetKey, sheetMatch, sheetKeys));
      return;
    }
    if (mod && e.shiftKey && (e.key === "G" || e.key === "g")) {
      e.preventDefault(); e.stopPropagation(); if (canGroup) onGroup?.(); return;
    }
    if (mod && e.shiftKey && (e.key === "U" || e.key === "u")) {
      e.preventDefault(); e.stopPropagation(); if (canUngroup) onUngroup?.(); return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && pickIds.length && !e.target.closest("input")) {
      e.preventDefault(); e.stopPropagation(); deleteSelection();
    }
    if (e.key === "Escape" && searchOpen && !e.target.closest(".ill-find")) {
      setQ(""); setSearchOpen(false);
    }
  };

  useEffect(() => {
    if (!closeOnOutside) return undefined;
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
  }, [onClose, closeOnOutside]);

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
    if (!selectedSet.has(nodeId) && !shapeIdsFor(nodeId).some((id) => selectedSet.has(id))) {
      emitSelect(shapeIdsFor(nodeId));
    }
    setMenu({ x: e.clientX, y: e.clientY, kind: "row", nodeId });
  };

  const Node = ({ node, style, dragHandle }) => {
    const d = node.data;
    const meta = kindOf(d);
    const folder = isFolderKind(d.kind);
    const metric = d.metric || "";
    const rowPos = { ...(style || {}), paddingLeft: 0 };
    const guides = guideKinds(node);
    const descendantIds = folder ? shapeIdsUnder(d) : [];
    const pickedDesc = folder ? descendantIds.filter((id) => selectedSet.has(id)).length : 0;
    const selfPicked = selectedSet.has(d.id) || node.isSelected;
    // Illustrator: double-ring meatball = this row is targeted. A parent is
    // targeted only when every descendant is picked (or the empty folder itself
    // was clicked). A partial pick lights the square, not the ring.
    const isTargeted = folder
      ? (descendantIds.length ? pickedDesc === descendantIds.length : selfPicked)
      : selfPicked;
    const hasSel = folder ? pickedDesc > 0 : selfPicked;
    const allSel = folder ? (descendantIds.length > 0 && pickedDesc === descendantIds.length) : selfPicked;
    const isSel = isTargeted || hasSel;
    const strip = d.color || meta.color;
    const canDrag = d.kind !== "sheet" && !d.locked;
    return (
      <div
        className={`ill-row${isSel ? " is-sel" : ""}${d.hidden ? " is-hidden" : ""}${d.locked ? " is-locked" : ""}${node.level === 0 ? " is-top" : ""}`}
        style={rowPos}
        onPointerDown={(e) => {
          if (e.button === 0) e.stopPropagation();
        }}
        onClick={(e) => selectRow(node, e)}
        onContextMenu={(e) => openRowMenu(e, d.id)}
      >
        <button
          type="button"
          className="ill-eye"
          onPointerDown={stopChrome}
          onMouseDown={stopChrome}
          onClick={(e) => { stopChrome(e); hideNode(d.id, e); }}
          title={d.hidden ? "Show · Alt-click to show all" : "Hide · Alt-click to solo"}
          aria-label={d.hidden ? "Show layer" : "Hide layer"}
        >
          <Icon name={d.hidden ? "eyeOff" : "eye"} size={16} />
        </button>
        <button
          type="button"
          className={`ill-lock${d.locked ? " is-on" : ""}`}
          onPointerDown={stopChrome}
          onMouseDown={stopChrome}
          onClick={(e) => { stopChrome(e); lockNode(d.id, e); }}
          title={d.locked ? "Unlock · Alt-click to unlock all" : "Lock · Alt-click to lock others"}
          aria-label={d.locked ? "Unlock layer" : "Lock layer"}
          aria-pressed={!!d.locked}
        >
          <Icon name={d.locked ? "lock" : "unlock"} size={13} />
        </button>

        <span className="ill-selstrip" style={{ background: strip }} aria-hidden="true" />

        <div className="ill-indent">
          {guides.map((kind, i) => (
            <span key={i} className={`ill-guide is-${kind}`} aria-hidden="true">
              {kind !== "blank" && <span className="ill-guide-v" />}
              {(kind === "tee" || kind === "elbow") && <span className="ill-guide-h" />}
            </span>
          ))}
          {folder ? (
            <button
              type="button"
              className="ill-disc"
              onPointerDown={stopChrome}
              onMouseDown={stopChrome}
              onClick={(e) => {
                stopChrome(e);
                if (e.altKey) openDeep(node);
                else node.toggle();
              }}
              title="Expand · Alt-click to expand all nested groups"
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
              onPointerDown={stopChrome}
              onClick={stopChrome}
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
              ref={canDrag ? dragHandle : undefined}
              title={d.name}
              onPointerDown={(e) => {
                if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) e.stopPropagation();
              }}
              onDragStart={(e) => {
                if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (d.kind === "sheet") return;
                node.edit();
              }}
            >
              {d.name}
            </span>
          )}

          {metric ? <span className="ill-metric">{metric}</span> : null}
        </div>
        <div className="ill-end">
          <button
            type="button"
            className={`ill-target${isTargeted ? " is-on" : ""}`}
            onPointerDown={stopChrome}
            onMouseDown={stopChrome}
            onClick={(e) => { stopChrome(e); selectRow(node, e); }}
            aria-label="Select layer"
            aria-pressed={isTargeted}
          />
          <span
            className={`ill-selsquare${hasSel ? (allSel ? " is-full" : " is-part") : ""}`}
            style={hasSel ? { background: strip } : undefined}
            aria-hidden="true"
          />
        </div>
      </div>
    );
  };

  const menuNode = menu?.kind === "row" ? findNode(data, menu.nodeId) : null;
  const rowMenuItems = [
    { label: "New Group", icon: "plus", onClick: () => onNewGroup?.() },
    { label: "Duplicate", icon: "duplicate", disabled: !pickIds.length, onClick: duplicateSelection },
    { label: "Delete", icon: "trash", disabled: !pickIds.length, danger: true, onClick: () => deleteSelection() },
    { sep: true },
    { label: "Group", hint: "Ctrl+Shift+G", disabled: !canGroup, onClick: () => onGroup?.() },
    { label: "Ungroup", hint: "Ctrl+Shift+U", disabled: !canUngroup, onClick: () => onUngroup?.() },
    { sep: true },
    {
      label: "Rename",
      icon: "edit",
      disabled: !menuNode || menuNode.kind === "sheet",
      onClick: () => { treeRef.current?.get(menu.nodeId)?.edit(); },
    },
    {
      label: menuNode?.hidden ? "Show" : "Hide",
      icon: menuNode?.hidden ? "eye" : "eyeOff",
      disabled: !menuNode,
      onClick: () => hideNode(menu.nodeId),
    },
    {
      label: menuNode?.locked ? "Unlock" : "Lock",
      icon: menuNode?.locked ? "unlock" : "lock",
      disabled: !menuNode,
      onClick: () => lockNode(menu.nodeId),
    },
  ];
  const panelMenuItems = [
    { label: "New Group", icon: "plus", onClick: () => onNewGroup?.() },
    { label: "Collapse all", icon: "chevronDown", onClick: () => treeRef.current?.closeAll() },
    { label: "Select all", icon: "select", onClick: () => emitSelect(shapeIdsOnFocusSheet(shapes, focusSheetKey, sheetMatch, sheetKeys)) },
    { sep: true },
    {
      label: "Delete hidden",
      icon: "trash",
      disabled: !hiddenShapeCount,
      danger: true,
      onClick: () => onDeleteIds?.(shapes.filter((s) => hiddenShapeIds[s.id]).map((s) => s.id)),
    },
  ];
  const menuItems = menu?.kind === "panel" ? panelMenuItems : rowMenuItems;

  return (
    <div
      ref={panelRef}
      className={`ill-panel${embedded ? " is-embedded" : ""}`}
      role="dialog"
      aria-label="Layers"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {!embedded && (
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
      )}

      <div className="ill-toolbar">
        <button type="button" className="ill-tool" onPointerDown={stopChrome} onClick={() => onGroup?.()} disabled={!canGroup} data-tip="Group (Ctrl+Shift+G)" aria-label="Group">Group</button>
        <button type="button" className="ill-tool" onPointerDown={stopChrome} onClick={() => onUngroup?.()} disabled={!canUngroup} data-tip="Ungroup (Ctrl+Shift+U)" aria-label="Ungroup">Ungroup</button>
      </div>

      <div className="ill-body" ref={bodyRef}>
        {data.length ? (
          <Tree
            ref={treeRef}
            className="ill-scroll"
            data={data}
            idAccessor="id"
            childrenAccessor={(d) => (isFolderKind(d.kind) ? (d.children || []) : null)}
            openByDefault
            width={size.width}
            height={size.height}
            indent={14}
            rowHeight={32}
            overscanCount={8}
            searchTerm={q}
            searchMatch={(n, term) => String(n.data.name || "").toLowerCase().includes(String(term).toLowerCase())}
            disableDrag={(d) => {
              const kind = d.kind || d.data?.kind;
              const locked = d.locked ?? d.data?.locked;
              return kind === "sheet" || !!locked;
            }}
            disableDrop={({ parentNode }) => {
              if (!parentNode || parentNode.isRoot) return false;
              const kind = parentNode.data?.kind;
              if (kind !== "group" && kind !== "sheet") return true;
              return !!parentNode.data?.locked;
            }}
            disableMultiSelection={false}
            onMove={onTreeMove}
            onRename={onTreeRename}
            onSelect={onTreeSelect}
          >
            {Node}
          </Tree>
        ) : (
          <div className="ill-empty">Draw on the sheet — each takeoff becomes a layer.</div>
        )}
      </div>

      <div className="ill-foot">
        <span className="ill-foot-count">
          {leafCount} Layer{leafCount === 1 ? "" : "s"}
          {sheetFolderCount ? ` · ${sheetFolderCount} Sheet${sheetFolderCount === 1 ? "" : "s"}` : groupCount ? ` · ${groupCount} Group${groupCount === 1 ? "" : "s"}` : ""}
        </span>
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
          onPointerDown={stopChrome}
          onClick={() => { setSearchOpen((v) => { const next = !v; if (!next) setQ(""); return next; }); }}
          data-tip="Search"
          aria-label="Search layers"
          aria-pressed={searchOpen}
        >
          <Icon name="search" size={13} />
        </button>
        <button type="button" className="ill-icon-btn" onPointerDown={stopChrome} onClick={() => onNewGroup?.()} data-tip="New group" aria-label="New group">
          <Icon name="plus" size={13} />
        </button>
        <button
          type="button"
          className="ill-icon-btn is-danger"
          onPointerDown={stopChrome}
          onClick={() => deleteSelection()}
          disabled={!pickIds.length}
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
