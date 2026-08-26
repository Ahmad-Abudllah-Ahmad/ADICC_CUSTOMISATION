// SummaryPanel — Hierarchical Summary Table: Floor → Item Type → Item Code → Shapes.
// Directly addresses Client POC Feedback #1 (Priority 1).
import React, { useMemo, useState, useCallback, useRef, useEffect } from "react";
import { Icon } from "../brand/icons.jsx";
import { buildSummaryTree, resolveFloorLevel } from "../lib/summaryTree.js";
import { PALETTE, NO_FILL } from "./hatches.jsx";
import { csvEsc } from "../lib/csv.js";

const num = (v, d = 2) => (Number(v) || 0).toLocaleString(undefined, { maximumFractionDigits: d });
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

  // Auto-expand all floor and type nodes so items are always visible
  useEffect(() => {
    if (scopedTree.length > 0) {
      setExpandedNodes((prev) => {
        const exp = new Set(prev);
        for (const floor of scopedTree) {
          exp.add(floor.id);
          for (const t of floor.children) {
            exp.add(t.id);
          }
        }
        return exp;
      });
    }
  }, [scopedTree]);

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
      all.add(floor.id);
      for (const t of floor.children) {
        all.add(t.id);
        for (const c of t.children) {
          all.add(c.id);
        }
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
    let shapesN = 0;

    for (const floor of scopedTree) {
      shapesN += floor.shapes_count;
      for (const t of floor.children) {
        if (t.typeKey === "floor") totalFloorSf += t.total_qty;
        else if (t.typeKey === "wall") totalWallSf += t.total_qty;
        else if (t.typeKey === "linear") totalLinearLf += t.total_qty;
        else if (t.typeKey === "count") totalCount += t.total_qty;
      }
    }

    return {
      totalFloorSf: num(totalFloorSf),
      totalWallSf: num(totalWallSf),
      totalLinearLf: num(totalLinearLf),
      totalCount: num(totalCount, 0),
      shapesN,
      floorsN: scopedTree.length,
    };
  }, [scopedTree]);

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
        fontFamily: "var(--f-body)",
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
            <Icon name="search" size={15} />
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 12px",
            borderBottom: "1px solid var(--ink-faint)",
            background: "color-mix(in srgb, var(--ink) 3%, transparent)",
            fontSize: 11,
          }}
        >
          <span style={{ fontWeight: 600, color: "var(--ink-muted)", fontSize: 10.5, flexShrink: 0 }}>Floor:</span>
          <div style={{ display: "flex", gap: 4, flex: 1, overflowX: "auto", paddingBottom: 2 }}>
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
                  onClick={() => setSelectedFloor(fl.level)}
                  style={{
                    border: "1px solid",
                    borderColor: isSelected ? "var(--cobalt)" : "var(--ink-faint)",
                    background: isSelected ? "color-mix(in srgb, var(--cobalt) 12%, transparent)" : "transparent",
                    color: isSelected ? "var(--cobalt)" : "var(--ink-muted)",
                    fontWeight: isSelected ? 700 : 500,
                    borderRadius: 4,
                    padding: "2px 8px",
                    fontSize: 10.5,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                  title={isCurrent ? "Current active floor on canvas" : `Switch to ${fl.level}`}
                >
                  {fl.level} {isCurrent ? "★" : ""}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setSelectedFloor("all")}
              style={{
                border: "1px solid",
                borderColor: selectedFloor === "all" ? "var(--cobalt)" : "var(--ink-faint)",
                background: selectedFloor === "all" ? "color-mix(in srgb, var(--cobalt) 12%, transparent)" : "transparent",
                color: selectedFloor === "all" ? "var(--cobalt)" : "var(--ink-muted)",
                fontWeight: selectedFloor === "all" ? 700 : 500,
                borderRadius: 4,
                padding: "2px 8px",
                fontSize: 10.5,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              All Floors ({tree.length})
            </button>
          </div>
        </div>
      )}

      {/* Metric totals readout */}
      <div
        style={{
          display: "flex",
          gap: 12,
          padding: "7px 14px",
          borderBottom: "1px solid var(--ink-faint)",
          fontSize: 11,
          fontFamily: "var(--f-mono)",
          color: "var(--ink-muted)",
          flexWrap: "wrap",
          flexShrink: 0,
        }}
      >
        <span>Floor: <b style={{ color: "var(--ink)" }}>{grandTotal.totalFloorSf}</b> {units === "metric" ? "m²" : "SF"}</span>
        <span>Wall: <b style={{ color: "var(--ink)" }}>{grandTotal.totalWallSf}</b> {units === "metric" ? "m²" : "SF"}</span>
        <span>Linear: <b style={{ color: "var(--ink)" }}>{grandTotal.totalLinearLf}</b> {units === "metric" ? "m" : "LF"}</span>
        <span>Count: <b style={{ color: "var(--ink)" }}>{grandTotal.totalCount}</b> EA</span>
      </div>

      {/* Tree Content */}
      <div style={docked ? undefined : { flex: 1, overflowY: "auto", minHeight: 0 }}>
        {filteredTree.length === 0 ? (
          <div style={{ padding: "24px 16px", textAlign: "center", color: "var(--ink-muted)" }}>
            {shapes.length === 0 ? "No measurements on canvas yet." : "No results match the filter."}
          </div>
        ) : (
          filteredTree.map((floor) => {
            const isFloorOpen = expandedNodes.has(floor.id);
            return (
              <div key={floor.id} style={{ borderBottom: "1px solid var(--ink-faint)" }}>
                {/* Level 1: Floor Header */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "7px 10px",
                    background: "var(--paper-cream)",
                    cursor: "pointer",
                    userSelect: "none",
                    fontWeight: 700,
                    fontSize: 12,
                    borderBottom: isFloorOpen ? "1px solid var(--ink-faint)" : "none",
                  }}
                  onClick={() => toggleExpand(floor.id)}
                >
                  <span style={{ fontFamily: "var(--f-mono)", fontSize: 11, width: 12, color: "var(--cobalt)" }}>
                    {isFloorOpen ? "▾" : "▸"}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleHideIds?.(floor.shape_ids);
                    }}
                    title={floor.hidden ? "Show all on this floor" : "Hide all on this floor"}
                    style={{
                      border: "none",
                      background: "none",
                      cursor: "pointer",
                      padding: "0 2px",
                      color: floor.hidden ? "var(--ink-faint)" : "var(--cobalt)",
                      display: "flex",
                      alignItems: "center",
                    }}
                  >
                    <Icon name={floor.hidden ? "eyeOff" : "eye"} size={13} />
                  </button>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {floor.level}
                  </span>
                  <span style={{ fontSize: 10.5, color: "var(--ink-muted)", fontFamily: "var(--f-mono)" }}>
                    {floor.shapes_count} items · {num(floor.total_qty)} qty
                  </span>
                </div>

                {/* Level 2: Item Types */}
                {isFloorOpen && (
                  <div>
                    {floor.children.map((typeNode) => {
                      const isTypeOpen = expandedNodes.has(typeNode.id);
                      return (
                        <div key={typeNode.id} style={{ borderBottom: "1px solid color-mix(in srgb, var(--ink) 6%, transparent)" }}>
                          {/* Item Type Row */}
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              padding: "5px 10px 5px 24px",
                              background: "color-mix(in srgb, var(--ink) 2.5%, transparent)",
                              cursor: "pointer",
                              userSelect: "none",
                              fontSize: 11.5,
                              fontWeight: 600,
                            }}
                            onClick={() => toggleExpand(typeNode.id)}
                          >
                            <span style={{ fontFamily: "var(--f-mono)", fontSize: 10, width: 10, color: "var(--ink-muted)" }}>
                              {isTypeOpen ? "▾" : "▸"}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onToggleHideIds?.(typeNode.shape_ids);
                              }}
                              title={typeNode.hidden ? "Show all" : "Hide all"}
                              style={{
                                border: "none",
                                background: "none",
                                cursor: "pointer",
                                padding: "0 2px",
                                color: typeNode.hidden ? "var(--ink-faint)" : "var(--ink-muted)",
                                display: "flex",
                                alignItems: "center",
                              }}
                            >
                              <Icon name={typeNode.hidden ? "eyeOff" : "eye"} size={12} />
                            </button>
                            <span style={{ flex: 1, color: "var(--ink)" }}>{typeNode.label}</span>
                            <span style={{ fontSize: 10.5, fontFamily: "var(--f-mono)", color: "var(--cobalt)" }}>
                              {num(typeNode.total_qty)} {typeNode.unit}
                            </span>
                          </div>

                          {/* Level 3: Item Codes */}
                          {isTypeOpen && (
                            <div>
                              {typeNode.children.map((codeNode) => {
                                const isCodeOpen = expandedNodes.has(codeNode.id);
                                const isEditing = editingCodeId === codeNode.condition_id;

                                return (
                                  <div key={codeNode.id} style={{ borderTop: "1px solid color-mix(in srgb, var(--ink) 5%, transparent)" }}>
                                    <div
                                      style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 6,
                                        padding: "4px 10px 4px 40px",
                                        fontSize: 11.5,
                                        opacity: codeNode.hidden ? 0.45 : 1,
                                        background: "var(--paper-bright)",
                                      }}
                                    >
                                      {codeNode.shapes.length > 1 ? (
                                        <button
                                          type="button"
                                          onClick={() => toggleExpand(codeNode.id)}
                                          style={{ border: "none", background: "none", padding: 0, cursor: "pointer", fontFamily: "var(--f-mono)", fontSize: 10, width: 10, color: "var(--ink-muted)" }}
                                        >
                                          {isCodeOpen ? "▾" : "▸"}
                                        </button>
                                      ) : (
                                        <span style={{ width: 10 }} />
                                      )}

                                      {/* Show/Hide */}
                                      <button
                                        type="button"
                                        onClick={() => onToggleHideIds?.(codeNode.shape_ids)}
                                        title={codeNode.hidden ? "Show" : "Hide"}
                                        style={{ border: "none", background: "none", cursor: "pointer", padding: "0 2px", color: codeNode.hidden ? "var(--ink-faint)" : "var(--ink-muted)", display: "flex", alignItems: "center" }}
                                      >
                                        <Icon name={codeNode.hidden ? "eyeOff" : "eye"} size={12} />
                                      </button>

                                      {/* Color Swatch (Click to change color) */}
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          if (codeNode.condition_id) {
                                            setColorPickerAnchor({
                                              condId: codeNode.condition_id,
                                              rect: e.currentTarget.getBoundingClientRect(),
                                              currentColor: codeNode.color,
                                            });
                                          }
                                        }}
                                        title="Click to change condition color"
                                        style={{
                                          width: 14,
                                          height: 14,
                                          borderRadius: 3,
                                          background: codeNode.color || "#888",
                                          border: "1px solid color-mix(in srgb, var(--ink) 30%, transparent)",
                                          cursor: codeNode.condition_id ? "pointer" : "default",
                                          padding: 0,
                                          flexShrink: 0,
                                        }}
                                      />

                                      {/* Code Tag & Inline Edit */}
                                      <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
                                        {isEditing ? (
                                          <input
                                            type="text"
                                            value={draftCodeVal}
                                            autoFocus
                                            onChange={(e) => setDraftCodeVal(e.target.value)}
                                            onKeyDown={(e) => {
                                              if (e.key === "Enter") commitCodeEdit(codeNode.condition_id);
                                              if (e.key === "Escape") setEditingCodeId(null);
                                            }}
                                            onBlur={() => commitCodeEdit(codeNode.condition_id)}
                                            style={{
                                              padding: "1px 4px",
                                              fontSize: 11,
                                              fontFamily: "var(--f-mono)",
                                              fontWeight: 700,
                                              border: "1px solid var(--cobalt)",
                                              borderRadius: 2,
                                              outline: "none",
                                            }}
                                          />
                                        ) : (
                                          <span
                                            onDoubleClick={() => codeNode.condition_id && startEditCode(codeNode.condition_id, codeNode.code)}
                                            title="Double-click to edit finish tag"
                                            style={{
                                              fontFamily: "var(--f-mono)",
                                              fontWeight: 700,
                                              fontSize: 11,
                                              color: "var(--cobalt)",
                                              cursor: "pointer",
                                            }}
                                          >
                                            {codeNode.code}
                                          </span>
                                        )}
                                        {codeNode.description && (
                                          <span style={{ fontSize: 10.5, color: "var(--ink-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                            · {codeNode.description}
                                          </span>
                                        )}
                                      </div>

                                      {/* Code Quantity */}
                                      <span style={{ fontFamily: "var(--f-mono)", fontWeight: 600, fontSize: 11, color: "var(--ink)", flexShrink: 0 }}>
                                        {num(codeNode.total_qty)} {codeNode.unit}
                                      </span>
                                    </div>

                                    {/* Shapes List Under Item Code */}
                                    {isCodeOpen && codeNode.shapes.length > 1 && (
                                      <div style={{ background: "color-mix(in srgb, var(--ink) 3%, transparent)", padding: "2px 0 4px 54px" }}>
                                        {codeNode.shapes.map((s) => (
                                          <div
                                            key={s.id}
                                            style={{
                                              display: "flex",
                                              alignItems: "center",
                                              gap: 6,
                                              padding: "2px 8px 2px 0",
                                              fontSize: 10.5,
                                              opacity: s.hidden ? 0.45 : 1,
                                            }}
                                          >
                                            <button
                                              type="button"
                                              onClick={() => onToggleHideIds?.([s.id])}
                                              title={s.hidden ? "Show shape" : "Hide shape"}
                                              style={{ border: "none", background: "none", cursor: "pointer", padding: 0, color: s.hidden ? "var(--ink-faint)" : "var(--ink-muted)" }}
                                            >
                                              <Icon name={s.hidden ? "eyeOff" : "eye"} size={10} />
                                            </button>
                                            <button
                                              type="button"
                                              onClick={() => onShapeNavigate?.(s.id)}
                                              title="Navigate to shape on plan"
                                              style={{
                                                flex: 1,
                                                border: "none",
                                                background: "none",
                                                cursor: "pointer",
                                                textAlign: "left",
                                                padding: 0,
                                                color: "var(--ink)",
                                                display: "flex",
                                                alignItems: "center",
                                                gap: 4,
                                              }}
                                            >
                                              <span style={{ fontWeight: 500 }}>
                                                {s.room || "Unnamed area"}
                                              </span>
                                            </button>
                                            <span style={{ fontFamily: "var(--f-mono)", color: "var(--ink-muted)" }}>
                                              {num(s.qty)} {s.unit}
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
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
