// SummaryPanel — finish sample board: ticket totals + color tiles.
import React, { useMemo, useState, useCallback, useRef, useEffect } from "react";
import { Icon } from "../brand/icons.jsx";
import { buildSummaryTree, resolveFloorLevel } from "../lib/summaryTree.js";
import { PALETTE, NO_FILL } from "./hatches.jsx";
import { csvEsc } from "../lib/csv.js";

const num = (v, d = 2) => (Number(v) || 0).toLocaleString(undefined, { maximumFractionDigits: d });

// Schedule figures: integer reads bold, the fraction recedes — an estimator's
// eye lands on the whole number first, decimals stay legible but quiet.
function Qty({ value, d = 2, unit }) {
  const s = num(value, d);
  const dot = s.search(/[.,]/);
  const int = dot === -1 ? s : s.slice(0, dot);
  const frac = dot === -1 ? "" : s.slice(dot);
  return (
    <>
      <b className="q-int">{int}</b>
      {frac ? <i className="q-frac">{frac}</i> : null}
      {unit ? <em className="q-unit">{unit}</em> : null}
    </>
  );
}
const collectionHas = (collection, value) => (
  collection instanceof Set
    ? collection.has(value)
    : Array.isArray(collection) && collection.includes(value)
);

function ColorPickerPopup({ currentColor, onClose, onSelectColor, anchorRect }) {
  const ref = useRef(null);

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: Math.max(10, Math.min(window.innerWidth - 200, (anchorRect?.left || 100) - 80)),
        top: Math.max(10, (anchorRect?.bottom || 100) + 4),
        zIndex: 99999,
        background: "var(--paper-bright)",
        border: "1px solid var(--ink)",
        boxShadow: "var(--shadow-2)",
        borderRadius: "var(--radius-sm)",
        padding: 8,
        display: "grid",
        gridTemplateColumns: "repeat(5, 24px)",
        gap: 6,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => { onSelectColor(c); onClose(); }}
          style={{
            width: 24,
            height: 24,
            borderRadius: 4,
            background: c,
            border: currentColor === c ? "2px solid var(--ink)" : "1px solid color-mix(in srgb, var(--ink) 18%, transparent)",
            cursor: "pointer",
            outline: "none",
            transform: currentColor === c ? "scale(1.1)" : "none",
          }}
          title={c}
        />
      ))}
    </div>
  );
}

function typeKindIcon(key) {
  if (key === "floor") return "surface";
  if (key === "wall") return "wallArea";
  if (key === "linear") return "linear";
  if (key === "count") return "count";
  return "area";
}

function mergeFinishes(codeNodes) {
  const map = new Map();
  for (const node of codeNodes) {
    const key = String(node.code || "Unassigned").toUpperCase();
    const prev = map.get(key);
    if (!prev) {
      map.set(key, {
        ...node,
        shapes: [...node.shapes],
        shape_ids: [...(node.shape_ids || [])],
      });
      continue;
    }
    prev.shapes = prev.shapes.concat(node.shapes);
    prev.shape_ids = prev.shape_ids.concat(node.shape_ids || []);
    prev.total_qty = (Number(prev.total_qty) || 0) + (Number(node.total_qty) || 0);
    prev.shapes_count = prev.shapes.length;
    prev.hidden = !!(prev.hidden && node.hidden);
    if (!prev.condition_id && node.condition_id) {
      prev.condition_id = node.condition_id;
      prev.color = node.color;
      prev.description = node.description || prev.description;
    }
  }
  return [...map.values()].map((node) => ({
    ...node,
    total_qty: Math.round((Number(node.total_qty) || 0) * 100) / 100,
  }));
}

function SummaryMute({ hidden, title, onClick, stopRow = false, size = 16, quiet = false }) {
  return (
    <button
      type="button"
      className={`summary-mute${hidden ? " is-off" : ""}${quiet ? " is-quiet" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={!hidden}
      onClick={(e) => {
        if (stopRow) e.stopPropagation();
        onClick?.(e);
      }}
    >
      <Icon name={hidden ? "eyeOff" : "eye"} size={size} />
    </button>
  );
}

function SummaryLocate({ title = "Locate on plan", onClick }) {
  return (
    <button
      type="button"
      className="summary-locate"
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      <Icon name="target" size={11} />
    </button>
  );
}

export default function SummaryPanel({
  docked = false,
  shapes = [],
  conditions = [],
  sheetLevels = {},
  sheetLabel = null,
  hiddenShapeIds = {},
  units = "imperial",
  boqLines = [],
  projectName = "",
  activeSheetId = "",
  activeFloor = "",
  onToggleHideIds,
  onPatchCondition,
  onShapeNavigate,
  onClose,
  roomForShape = null,
}) {
  const [search, setSearch] = useState("");
  const [expandedNodes, setExpandedNodes] = useState(() => new Set());
  const [colorPickerAnchor, setColorPickerAnchor] = useState(null); // { condId, rect, currentColor }
  const [editingCodeId, setEditingCodeId] = useState(null);
  const [draftCodeVal, setDraftCodeVal] = useState("");

  const currentFloor = useMemo(() => {
    if (activeFloor) return activeFloor;
    if (activeSheetId) return resolveFloorLevel(activeSheetId, sheetLevels, sheetLabel);
    return "";
  }, [activeFloor, activeSheetId, sheetLevels, sheetLabel]);

  // Default to current active canvas floor; allows switching in drawer
  const [selectedFloor, setSelectedFloor] = useState(() => currentFloor || "");

  // Dynamically sync default floor whenever active drawing changes on canvas
  useEffect(() => {
    if (currentFloor) {
      setSelectedFloor(currentFloor);
    }
  }, [currentFloor]);

  const tree = useMemo(() => {
    return buildSummaryTree({
      shapes,
      conditions,
      sheetLevels,
      sheetLabel,
      hiddenShapeIds,
      units,
      boqLines,
      roomForShape,
    });
  }, [shapes, conditions, sheetLevels, sheetLabel, hiddenShapeIds, units, boqLines, roomForShape]);

  const scopedTree = useMemo(() => {
    if (!tree.length) return [];
    if (selectedFloor === "all") return tree;
    const target = selectedFloor || currentFloor;
    if (!target) return tree;
    const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const targetNorm = norm(target);
    const match = tree.filter((f) => {
      const fNorm = norm(f.level);
      return fNorm === targetNorm || fNorm.includes(targetNorm) || targetNorm.includes(fNorm);
    });
    if (match.length) return match;
    if (activeSheetId) {
      const matchBySheet = tree.filter((f) => collectionHas(f.sheet_ids, activeSheetId));
      if (matchBySheet.length) return matchBySheet;
    }
    return tree;
  }, [tree, selectedFloor, currentFloor, activeSheetId]);

  const toggleExpand = useCallback((nodeId) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    const all = new Set();
    for (const floor of tree) {
      for (const t of floor.children) {
        for (const c of mergeFinishes(t.children)) all.add(c.id);
      }
    }
    setExpandedNodes(all);
  }, [tree]);

  const collapseAll = useCallback(() => {
    setExpandedNodes(new Set());
  }, []);

  // Filter tree by search query
  const filteredTree = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return scopedTree;

    return scopedTree
      .map((floor) => {
        const floorMatch = floor.level.toLowerCase().includes(q);
        const filteredTypes = floor.children
          .map((typeNode) => {
            const typeMatch = typeNode.label.toLowerCase().includes(q);
            const filteredCodes = typeNode.children.filter((codeNode) => {
              const codeMatch = codeNode.code.toLowerCase().includes(q) || (codeNode.description && codeNode.description.toLowerCase().includes(q));
              const shapeMatch = codeNode.shapes.some((s) => s.room && s.room.toLowerCase().includes(q));
              return codeMatch || shapeMatch || typeMatch || floorMatch;
            });
            if (filteredCodes.length > 0 || typeMatch || floorMatch) {
              return { ...typeNode, children: filteredCodes.length > 0 ? filteredCodes : typeNode.children };
            }
            return null;
          })
          .filter(Boolean);

        if (filteredTypes.length > 0 || floorMatch) {
          return { ...floor, children: filteredTypes.length > 0 ? filteredTypes : floor.children };
        }
        return null;
      })
      .filter(Boolean);
  }, [scopedTree, search]);

  const grandTotal = useMemo(() => {
    let totalFloorSf = 0;
    let totalWallSf = 0;
    let totalLinearLf = 0;
    let totalCount = 0;
    for (const floor of scopedTree) {
      for (const t of floor.children) {
        if (t.typeKey === "floor") totalFloorSf += t.total_qty;
        else if (t.typeKey === "wall") totalWallSf += t.total_qty;
        else if (t.typeKey === "linear") totalLinearLf += t.total_qty;
        else if (t.typeKey === "count") totalCount += t.total_qty;
      }
    }
    return { totalFloorSf, totalWallSf, totalLinearLf, totalCount };
  }, [scopedTree]);

  const metricCells = useMemo(() => {
    const area = units === "metric" ? "m\u00b2" : "SF";
    const len = units === "metric" ? "m" : "LF";
    return [
      { key: "floor", label: "Floor", qty: grandTotal.totalFloorSf, unit: area },
      { key: "wall", label: "Wall", qty: grandTotal.totalWallSf, unit: area },
      { key: "linear", label: "Linear", qty: grandTotal.totalLinearLf, unit: len },
      { key: "count", label: "Count", qty: grandTotal.totalCount, unit: "EA" },
    ].filter((cell) => Number(cell.qty) > 0);
  }, [grandTotal, units]);

  const rowCount = useMemo(
    () => filteredTree.reduce((n, floor) => n + floor.children.length, 0),
    [filteredTree],
  );

  const exportCsv = useCallback(() => {
    const headers = ["Floor/Level", "Item Type", "Item Code", "Description", "Quantity", "Unit", "Shapes Count", "Color"];
    const rows = [
      [`# Quantity Takeoff Summary${projectName ? ` — ${projectName}` : ""}`],
      headers.map(csvEsc).join(","),
    ];

    for (const floor of tree) {
      for (const t of floor.children) {
        for (const c of t.children) {
          rows.push([
            floor.level,
            t.label,
            c.code,
            c.description || "",
            c.total_qty,
            c.unit,
            c.shapes_count,
            c.color || "",
          ].map(csvEsc).join(","));
        }
      }
    }

    const blob = new Blob([rows.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(projectName || "takeoff").replace(/[^\w.-]+/g, "_")}-summary-hierarchy.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [tree, projectName]);

  const copySummaryToClipboard = useCallback(() => {
    const headers = ["Floor/Level", "Item Type", "Item Code", "Description", "Quantity", "Unit", "Shapes Count"];
    const rows = [headers.join("\t")];
    for (const floor of tree) {
      for (const t of floor.children) {
        for (const c of t.children) {
          rows.push([
            floor.level,
            t.label,
            c.code,
            c.description || "",
            c.total_qty,
            c.unit,
            c.shapes_count,
          ].join("\t"));
        }
      }
    }
    navigator.clipboard?.writeText(rows.join("\n"));
  }, [tree]);

  const printSummary = useCallback(() => {
    const win = window.open("", "_blank");
    if (!win) return;
    const rowsHtml = tree.map((floor) => `
      <tr style="background:#f0ede6;font-weight:bold;"><td colspan="5" style="padding:8px 10px;font-size:13px;">${floor.level}</td></tr>
      ${floor.children.map((t) => `
        <tr style="background:#faf8f5;font-weight:600;"><td colspan="5" style="padding:6px 16px;font-size:12px;color:#1f3fc7;">${t.label}</td></tr>
        ${t.children.map((c) => `
          <tr>
            <td style="padding:5px 24px;font-family:monospace;font-weight:bold;">${c.code}</td>
            <td style="padding:5px 10px;">${c.description || "—"}</td>
            <td style="padding:5px 10px;text-align:right;font-family:monospace;">${num(c.total_qty)}</td>
            <td style="padding:5px 10px;">${c.unit}</td>
            <td style="padding:5px 10px;text-align:right;">${c.shapes_count}</td>
          </tr>
        `).join("")}
      `).join("")}
    `).join("");

    win.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Quantity Takeoff Summary — ${projectName || "ADICC"}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 24px; color: #1a1a1a; }
          h1 { font-size: 20px; margin-bottom: 4px; }
          .meta { font-size: 12px; color: #666; margin-bottom: 16px; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; }
          th, td { border: 1px solid #ddd; }
          th { background: #e5e0d8; padding: 8px 10px; text-align: left; }
        </style>
      </head>
      <body>
        <h1>Quantity Takeoff Summary</h1>
        <div class="meta">Project: <b>${projectName || "Untitled Project"}</b> · Generated: ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}</div>
        <table>
          <thead>
            <tr>
              <th>Item Code</th>
              <th>Description</th>
              <th style="text-align:right;">Quantity</th>
              <th>Unit</th>
              <th style="text-align:right;">Shapes</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </body>
      </html>
    `);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 250);
  }, [tree, projectName]);

  const startEditCode = (condId, currentTag) => {
    setEditingCodeId(condId);
    setDraftCodeVal(currentTag || "");
  };

  const commitCodeEdit = (condId) => {
    if (editingCodeId && onPatchCondition) {
      onPatchCondition(condId, { finish_tag: draftCodeVal.trim() });
    }
    setEditingCodeId(null);
  };

  return (
    <div
      className="summary-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        ...(docked ? {} : { height: "100%", overflow: "hidden" }),
        background: "var(--paper-bright)",
        color: "var(--ink)",
        fontSize: 12,
      }}
    >
      {/* Floating Header Bar (when not docked in left sidebar) */}
      {!docked && (
        <div
          data-float-drag
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            background: "var(--cobalt)",
            color: "var(--accent-contrast)",
            cursor: "grab",
            userSelect: "none",
            flexShrink: 0,
          }}
        >
          <Icon name="layers" size={16} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: "0.02em" }}>Summary Hierarchy</div>
            <div style={{ fontSize: 10.5, opacity: 0.85, marginTop: 2 }}>Floor → Item Type → Item Code → Shapes</div>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Close summary hierarchy"
              style={{
                border: "none",
                background: "transparent",
                color: "inherit",
                fontSize: 18,
                cursor: "pointer",
                padding: "0 4px",
                lineHeight: 1,
              }}
            >
              ×
            </button>
          )}
        </div>
      )}

      {/* Action Buttons Row (matching Files / neighbor tabs) */}
      <div className="left-panel-glass-actions summary-panel-actions">
        <div className="lp-action-row" role="group" aria-label="Summary actions">
          <button type="button" className="lp-btn-primary" onClick={exportCsv} title="Export CSV summary">
            CSV
          </button>
          <button type="button" className="lp-btn-ghost" onClick={copySummaryToClipboard} title="Copy table to clipboard for Excel / Sheets">
            Copy
          </button>
          <button type="button" className="lp-btn-ghost" onClick={printSummary} title="Print or Export PDF report">
            Print
          </button>
          <button type="button" className="lp-btn-ghost" onClick={expandAll} title="Expand all rows">
            Expand
          </button>
          <button type="button" className="lp-btn-ghost" onClick={collapseAll} title="Collapse all rows">
            Collapse
          </button>
        </div>
      </div>

      {/* Search Input Bar (matching Files / neighbor tabs) */}
      <div className="lp-find-wrap">
        <label className={`lp-find${search ? " is-filled" : ""}`}>
          <span className="lp-find-ico" aria-hidden="true">
            <Icon name="search" size={13} />
          </span>
          <input
            name="summary-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search summary…"
            aria-label="Search summary"
            autoComplete="off"
          />
          {search ? (
            <button
              type="button"
              className="lp-find-clear"
              title="Clear"
              aria-label="Clear search"
              onClick={() => setSearch("")}
            >
              <Icon name="close" size={13} />
            </button>
          ) : null}
        </label>
      </div>

      {/* Dynamic Floor Switcher Drawer Bar */}
      {tree.length > 1 && (
        <div className="summary-floors">
          <div className="summary-floors-track">
            {tree.map((fl) => {
              const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
              const isCurrent = currentFloor && norm(fl.level) === norm(currentFloor);
              const isSelected = selectedFloor === "all"
                ? false
                : (selectedFloor ? norm(fl.level) === norm(selectedFloor) : isCurrent);
              return (
                <button
                  key={fl.id}
                  type="button"
                  className={`summary-floor-chip${isSelected ? " is-on" : ""}`}
                  onClick={() => setSelectedFloor(fl.level)}
                  title={isCurrent ? "Current active floor on canvas" : `Switch to ${fl.level}`}
                >
                  {fl.level}
                </button>
              );
            })}
            <button
              type="button"
              className={`summary-floor-chip${selectedFloor === "all" ? " is-on" : ""}`}
              onClick={() => setSelectedFloor("all")}
            >
              All ({tree.length})
            </button>
          </div>
        </div>
      )}

      {rowCount > 0 && metricCells.length > 0 && (
        <div className="takeoff-register-overview" aria-label="Measured totals">
          {metricCells.map((cell) => (
            <div key={cell.key} className="takeoff-register-stat">
              <span className="takeoff-register-stat-icon" aria-hidden="true">
                <Icon name={typeKindIcon(cell.key)} size={12} />
              </span>
              <span className="takeoff-register-stat-value">
                <Qty value={cell.qty} d={cell.key === "count" ? 0 : 2} />
              </span>
              <span className="takeoff-register-stat-label">{cell.label}</span>
              <span className="takeoff-register-stat-unit">{cell.unit}</span>
            </div>
          ))}
        </div>
      )}

      <div
        className="takeoff-register"
        style={docked ? undefined : { flex: 1, overflowY: "auto", minHeight: 0 }}
      >
        {rowCount === 0 ? (
          <div className="summary-empty">
            <Icon name="takeoffs" size={16} />
            <strong>No measured work yet</strong>
            <span>
              {shapes.length === 0
                ? "Trace an area or line on the plan. Its quantity will appear here."
                : "No results match this search."}
            </span>
          </div>
        ) : (
          filteredTree.map((floor) => {
            const showFloor = filteredTree.length > 1;
            return (
              <section
                key={floor.id}
                className={`takeoff-register-floor${floor.hidden ? " is-hidden" : ""}`}
              >
                {showFloor && (
                  <header className="takeoff-register-floor-head">
                    <span className="takeoff-register-floor-name">{floor.level}</span>
                    <span className="takeoff-register-floor-meta">
                      {floor.shapes_count} measured {floor.shapes_count === 1 ? "item" : "items"}
                      {floor.hidden ? " · hidden" : ""}
                    </span>
                    <SummaryMute
                      hidden={floor.hidden}
                      size={12}
                      title={floor.hidden ? `Show ${floor.level} on the plan` : `Hide ${floor.level} from the plan`}
                      onClick={() => onToggleHideIds?.(floor.shape_ids)}
                    />
                  </header>
                )}

                <div
                  className={`takeoff-register-fold${floor.hidden ? "" : " is-open"}`}
                  aria-hidden={floor.hidden}
                >
                <div className="takeoff-register-fold-inner">
                {floor.children.map((typeNode) => {
                  const finishes = mergeFinishes(typeNode.children);
                  return (
                    <section key={typeNode.id} className="takeoff-register-trade">
                      <header className="takeoff-register-trade-head">
                        <span className="takeoff-register-trade-icon" aria-hidden="true">
                          <Icon name={typeKindIcon(typeNode.typeKey)} size={12} />
                        </span>
                        <span className="takeoff-register-trade-name">{typeNode.label}</span>
                        <span className="takeoff-register-trade-total">
                          <Qty value={typeNode.total_qty} unit={typeNode.unit} />
                        </span>
                      </header>

                      <div className="takeoff-register-materials">
                        {finishes.map((finish) => {
                          const open = expandedNodes.has(finish.id);
                          const isEditing = editingCodeId === finish.condition_id;
                          const rooms = [...finish.shapes].sort((a, b) => (b.qty || 0) - (a.qty || 0));
                          return (
                            <article
                              key={finish.id}
                              className={`takeoff-register-material${open ? " is-open" : ""}${finish.hidden ? " is-dim" : ""}`}
                              style={{ "--swatch": finish.color || "#888" }}
                            >
                              <div className="takeoff-register-material-head">
                                <button
                                  type="button"
                                  className="takeoff-register-swatch"
                                  title="Change finish color"
                                  aria-label={`Change ${finish.code} color`}
                                  disabled={!finish.condition_id}
                                  onClick={(e) => {
                                    if (!finish.condition_id) return;
                                    setColorPickerAnchor({
                                      condId: finish.condition_id,
                                      rect: e.currentTarget.getBoundingClientRect(),
                                      currentColor: finish.color,
                                    });
                                  }}
                                />

                                <div className="takeoff-register-material-id">
                                  {isEditing ? (
                                    <input
                                      type="text"
                                      className="takeoff-register-code-edit"
                                      value={draftCodeVal}
                                      autoFocus
                                      onChange={(e) => setDraftCodeVal(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") commitCodeEdit(finish.condition_id);
                                        if (e.key === "Escape") setEditingCodeId(null);
                                      }}
                                      onBlur={() => commitCodeEdit(finish.condition_id)}
                                    />
                                  ) : (
                                    <button
                                      type="button"
                                      className="takeoff-register-code"
                                      onDoubleClick={() => finish.condition_id && startEditCode(finish.condition_id, finish.code)}
                                      title="Double-click to rename finish"
                                    >
                                      {finish.code}
                                    </button>
                                  )}
                                  {finish.description ? (
                                    <span className="takeoff-register-description">{finish.description}</span>
                                  ) : null}
                                </div>

                                <span className="takeoff-register-material-total">
                                  <Qty value={finish.total_qty} unit={finish.unit} />
                                </span>

                                <SummaryMute
                                  hidden={finish.hidden}
                                  size={11}
                                  title={finish.hidden ? `Show ${finish.code}` : `Hide ${finish.code}`}
                                  onClick={() => onToggleHideIds?.(finish.shape_ids)}
                                />
                              </div>

                              <button
                                type="button"
                                className="takeoff-register-disclosure"
                                onClick={() => toggleExpand(finish.id)}
                                aria-expanded={open}
                              >
                                <span className="takeoff-register-disclosure-icon" aria-hidden="true">
                                  <Icon name="chevronRight" size={10} />
                                </span>
                                <span>
                                  {finish.shapes.length} {finish.shapes.length === 1 ? "location" : "locations"}
                                </span>
                                <span className="takeoff-register-disclosure-hint">
                                  {open ? "Hide detail" : "Review rooms"}
                                </span>
                              </button>

                              <div
                                className={`takeoff-register-fold${open ? " is-open" : ""}`}
                                aria-hidden={!open}
                              >
                                <div className="takeoff-register-fold-inner">
                                <div className="takeoff-register-locations">
                                  {rooms.map((s, index) => (
                                    <div
                                      key={s.id}
                                      className={`takeoff-register-location${s.hidden ? " is-dim" : ""}`}
                                    >
                                      <span className="takeoff-register-location-index">
                                        {String(index + 1).padStart(2, "0")}
                                      </span>
                                      <button
                                        type="button"
                                        className="takeoff-register-location-name"
                                        onClick={() => onShapeNavigate?.(s.id)}
                                        title="Locate this measurement on the plan"
                                      >
                                        {s.room || "Unnamed area"}
                                      </button>
                                      <span className="takeoff-register-location-qty">
                                        <Qty value={s.qty} unit={s.unit} />
                                      </span>
                                      <div className="takeoff-register-location-actions">
                                        <SummaryLocate
                                          title={`Locate ${s.room || "area"} on plan`}
                                          onClick={() => onShapeNavigate?.(s.id)}
                                        />
                                        <SummaryMute
                                          hidden={s.hidden}
                                          size={11}
                                          title={s.hidden ? `Show ${s.room || "area"}` : `Hide ${s.room || "area"}`}
                                          onClick={() => onToggleHideIds?.([s.id])}
                                        />
                                      </div>
                                    </div>
                                  ))}
                                </div>
                                </div>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
                </div>
                </div>
              </section>
            );
          })
        )}
      </div>

      {/* Color Picker Modal */}
      {colorPickerAnchor && (
        <ColorPickerPopup
          currentColor={colorPickerAnchor.currentColor}
          anchorRect={colorPickerAnchor.rect}
          onClose={() => setColorPickerAnchor(null)}
          onSelectColor={(newColor) => {
            onPatchCondition?.(colorPickerAnchor.condId, { color: newColor });
            setColorPickerAnchor(null);
          }}
        />
      )}
    </div>
  );
}
