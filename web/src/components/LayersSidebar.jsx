// LayersSidebar — previous layers list (checkbox pick + sheet blocks).
// Live UI is LayersIllustratorPanel, wired to the same session hide/group store.

import React, { useMemo } from "react";
import { Icon } from "../brand/icons.jsx";
import { aiFloorSheetKeysMatch } from "../lib/supabase/persist.js";

const ROLE_LABEL = {
  floor_area: "Mask",
  wall_area: "Wall area",
  deduct: "Cutout",
  linear: "Line",
  surface_area: "Wall line",
  count: "Count",
};

export function layerCategory(role) {
  if (role === "floor_area" || role === "wall_area" || role === "deduct") return "mask";
  if (role === "linear" || role === "surface_area") return "line";
  if (role === "count") return "count";
  return "other";
}

export default function LayersSidebar({
  docked = false,
  multiSheet,
  sheetKeys,
  sheetLabel,
  shapes,
  condById,
  hiddenShapeIds,
  layerPickIds,
  layerGroups,
  shapeToLayerGroup,
  layersSheetOpen,
  selectedId,
  onToggleSheetOpen,
  onTogglePick,
  onSelectShape,
  onToggleHide,
  onDelete,
  onGroup,
  onUngroup,
  onOpenConditionEdit,
  wallSegmentRows = [],
  activeWallSegment = null,
  onFlyToWallSegment,
  selVert = null,
  onSeparateWallLine,
}) {
  const pickSet = layerPickIds instanceof Set ? layerPickIds : new Set(layerPickIds || []);
  const pickedN = pickSet.size;
  const pickedShapes = useMemo(
    () => shapes.filter((s) => pickSet.has(s.id)),
    [shapes, pickSet],
  );
  const canGroup = pickedN >= 2;
  const canUngroup = pickedN >= 1 && pickedShapes.some((s) => shapeToLayerGroup[s.id]);

  const selectedGroupMemberIds = useMemo(() => {
    if (!selectedId) return new Set();
    const gid = shapeToLayerGroup[selectedId];
    if (!gid) return new Set([selectedId]);
    const ids = layerGroups[gid]?.shapeIds;
    return ids?.length ? new Set(ids) : new Set([selectedId]);
  }, [selectedId, shapeToLayerGroup, layerGroups]);

  const shapesBySheet = useMemo(() => {
    const map = {};
    for (const key of sheetKeys) map[key] = [];
    for (const s of shapes) {
      const key = sheetKeys.find((k) => k === s.sheet_id || aiFloorSheetKeysMatch(s.sheet_id, k));
      if (key) map[key].push(s);
    }
    for (const key of sheetKeys) {
      map[key].sort((a, b) => {
        const ga = shapeToLayerGroup[a.id] || "";
        const gb = shapeToLayerGroup[b.id] || "";
        if (ga !== gb) return ga.localeCompare(gb);
        return (a.created_at || "").localeCompare(b.created_at || "");
      });
    }
    return map;
  }, [shapes, sheetKeys, shapeToLayerGroup]);

  const groupsBySheet = useMemo(() => {
    const map = {};
    for (const key of sheetKeys) map[key] = [];
    for (const g of Object.values(layerGroups || {})) {
      if (map[g.sheetKey]) map[g.sheetKey].push(g);
    }
    return map;
  }, [layerGroups, sheetKeys]);

  const btn = {
    padding: "3px 8px",
    border: "1px solid var(--ink-faint)",
    background: "transparent",
    color: "var(--ink)",
    cursor: "pointer",
    fontSize: 10.5,
    fontWeight: 600,
    borderRadius: 4,
  };

  const renderLayerRow = (s, groupRail = null) => {
    const cond = condById[s.condition_id];
    const hidden = !!hiddenShapeIds[s.id];
    const picked = pickSet.has(s.id);
    const sel = selectedGroupMemberIds.has(s.id);
    const tag = cond?.finish_tag || "—";
    const role = ROLE_LABEL[s.measure_role] || s.measure_role;
    const qty = s.computed?.area_sf != null ? `${s.computed.area_sf} SF`
      : s.computed?.perimeter_lf != null ? `${s.computed.perimeter_lf} LF`
        : s.computed?.count != null ? `${s.computed.count} ea` : "";
    return (
      <div key={s.id} style={{ display: "flex", alignItems: "stretch" }}>
        {groupRail && (
          <div style={{ width: 14, flexShrink: 0, position: "relative", marginLeft: 6, alignSelf: "stretch" }}>
            {!groupRail.only && (
              <div style={{
                position: "absolute",
                left: 5,
                top: groupRail.first ? "50%" : 0,
                bottom: groupRail.last ? "50%" : 0,
                width: 1,
                background: "var(--ink-faint)",
              }} />
            )}
            <div style={{
              position: "absolute",
              left: 5,
              top: "50%",
              width: 7,
              height: 1,
              background: "var(--ink-faint)",
            }} />
          </div>
        )}
      <div
        className={`left-panel-glass-file-row${sel ? " is-active" : ""}`}
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 8px",
          borderBottom: "1px solid var(--ink-faint)",
          opacity: hidden ? 0.45 : 1,
        }}
      >
        <input
          type="checkbox"
          checked={picked}
          onChange={() => onTogglePick(s.id)}
          title="Select for group"
          style={{ margin: 0, flexShrink: 0 }}
        />
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpenConditionEdit?.(s.id); }}
          title="Edit condition & label"
          style={{
            width: 16,
            height: 16,
            padding: 0,
            border: "none",
            background: "none",
            cursor: "pointer",
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: 999, background: cond?.color || "#888", flexShrink: 0 }} />
        </button>
        <button
          type="button"
          onClick={() => onSelectShape(s.id)}
          title={`Select ${tag} · ${role}`}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            border: "none",
            background: "none",
            cursor: "pointer",
            padding: 0,
            textAlign: "left",
          }}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
            <span style={{ display: "block", fontSize: 11.5, fontWeight: sel ? 700 : 500, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {tag} · {role}{hidden ? " (hidden)" : ""}
            </span>
            {qty && <span style={{ fontSize: 10, color: "var(--ink-muted)", fontFamily: "var(--f-mono)" }}>{qty}</span>}
          </span>
        </button>
        {sel && s.id === selectedId && s.measure_role === "surface_area" && wallSegmentRows.length > 1 && (
          <div style={{ display: "flex", gap: 2, flexShrink: 0, alignItems: "center" }}>
            {wallSegmentRows.map((row) => {
              const isActive = activeWallSegment === row.index;
              return (
                <button
                  key={row.index}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onFlyToWallSegment?.(row.index); }}
                  title={`${row.label} · ${row.lf} LF`}
                  style={{
                    padding: "1px 4px",
                    fontSize: 9,
                    fontWeight: isActive ? 700 : 600,
                    border: `1px solid ${isActive ? "var(--cobalt)" : "var(--ink-faint)"}`,
                    background: isActive ? "rgba(31,63,199,.08)" : "transparent",
                    color: isActive ? "var(--cobalt)" : "var(--ink-muted)",
                    borderRadius: 3,
                    cursor: "pointer",
                    lineHeight: 1.2,
                  }}
                >
                  {row.index + 1}
                </button>
              );
            })}
          </div>
        )}
        {sel && s.id === selectedId && s.measure_role === "surface_area" && selVert != null
          && selVert >= 1 && selVert <= (s.verts_norm?.length || 0) - 2 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onSeparateWallLine?.(); }}
            title="Separate wall line at this corner"
            style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)", padding: "2px 4px", fontSize: 10, fontWeight: 600, flexShrink: 0 }}
          >
            Separate
          </button>
        )}
        <button type="button" onClick={() => onToggleHide(s.id)} data-tip={hidden ? "Show layer" : "Hide layer"} aria-label={hidden ? "Show layer" : "Hide layer"}
          style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)", padding: "2px 4px", fontSize: 10, fontWeight: 600 }}>
          {hidden ? "Show" : "Hide"}
        </button>
        <button type="button" onClick={() => onDelete(s.id)} data-tip="Delete layer" aria-label="Delete layer"
          style={{ border: "none", background: "none", cursor: "pointer", color: "var(--c-danger)", padding: 2, display: "inline-flex" }}>
          <Icon name="close" size={11} />
        </button>
      </div>
      </div>
    );
  };

  const renderSheetBlock = (sheetKey) => {
    const open = layersSheetOpen[sheetKey] !== false;
    const list = shapesBySheet[sheetKey] || [];
    const groups = groupsBySheet[sheetKey] || [];
    const groupedIds = new Set(groups.flatMap((g) => g.shapeIds || []));
    const ungrouped = list.filter((s) => !groupedIds.has(s.id));

    const body = (
      <div>
        {groups.map((g) => {
          const members = (g.shapeIds || []).map((id) => list.find((s) => s.id === id)).filter(Boolean);
          if (!members.length) return null;
          return (
            <div key={g.id}>
              <div style={{ padding: "4px 8px", fontSize: 10.5, fontWeight: 700, color: "var(--ink-muted)", background: "rgba(0,0,0,.04)", borderBottom: "1px solid var(--ink-faint)" }}>
                {g.label || "Group"} · {members.length}
              </div>
              {members.map((s, i) => renderLayerRow(s, {
                first: i === 0,
                last: i === members.length - 1,
                only: members.length === 1,
              }))}
            </div>
          );
        })}
        {ungrouped.map((s) => renderLayerRow(s))}
        {!list.length && (
          <div style={{ padding: "10px 12px", color: "var(--ink-muted)", fontSize: 12 }}>No layers on this sheet.</div>
        )}
      </div>
    );

    if (!multiSheet) return body;

    return (
      <div key={sheetKey} style={{ borderBottom: "1px solid var(--ink-faint)" }}>
        <button
          type="button"
          className="left-panel-glass-folder-btn"
          onClick={() => onToggleSheetOpen(sheetKey)}
          data-tip={open ? "Collapse layers" : "Expand layers"}
          aria-label={open ? "Collapse layers" : "Expand layers"}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            border: "none",
            borderBottom: "1px solid var(--ink-faint)",
            color: "var(--ink)",
            cursor: "pointer",
            textAlign: "left",
            fontWeight: 600,
            fontSize: 12,
            background: "rgba(0,0,0,.03)",
          }}
        >
          <span style={{ fontFamily: "var(--f-mono)", fontSize: 10, width: 12, color: "light-dark(var(--cobalt), var(--ink))" }}>{open ? "▾" : "▸"}</span>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sheetLabel(sheetKey)}</span>
          <span style={{ fontSize: 10.5, color: "var(--ink-muted)", fontFamily: "var(--f-mono)" }}>{list.length}</span>
        </button>
        {open && body}
      </div>
    );
  };

  return (
    <div
      className="left-panel-glass-layers"
      style={{
        flex: docked ? 1 : undefined,
        flexShrink: docked ? undefined : 0,
        display: "flex",
        flexDirection: "column",
        borderTop: docked ? "none" : "1px solid var(--ink-faint)",
        maxHeight: docked ? "none" : "42%",
        minHeight: docked ? 0 : 120,
        background: "var(--paper-bright)",
        overflow: "hidden",
      }}
    >
      {!docked && (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", borderBottom: "1px solid var(--ink-faint)", flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--ink-muted)" }}>Layers</span>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button type="button" disabled={!canGroup} onClick={onGroup} title="Group selected layers" style={{ ...btn, opacity: canGroup ? 1 : 0.4 }}>Group</button>
          <button type="button" disabled={!canUngroup} onClick={onUngroup} title="Ungroup selected layers" style={{ ...btn, opacity: canUngroup ? 1 : 0.4 }}>Ungroup</button>
        </div>
      </div>
      )}
      {docked && (
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "8px 10px", borderBottom: "1px solid var(--ink-faint)", flexShrink: 0 }}>
        <button type="button" disabled={!canGroup} onClick={onGroup} title="Group selected layers" style={{ ...btn, opacity: canGroup ? 1 : 0.4 }}>Group</button>
        <button type="button" disabled={!canUngroup} onClick={onUngroup} title="Ungroup selected layers" style={{ ...btn, opacity: canUngroup ? 1 : 0.4 }}>Ungroup</button>
      </div>
      )}
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {sheetKeys.map((key) => renderSheetBlock(key))}
      </div>
    </div>
  );
}
