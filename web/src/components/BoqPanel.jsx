// BoqPanel — Bill of Quantities sidebar: per-mask takeoff rows with auto-detected
// room names, finish codes, and measured Floor / Wall / LF / EA / Qty quantities.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../brand/icons.jsx";
import ToolMenu from "./ToolMenu.jsx";
import { conditionTotals, round2 } from "../lib/totals.js";
import { areaUnit, lenUnit } from "../lib/units";
import { csvEsc } from "../lib/csv.js";
import { rowKey, buildShapeRows, primaryQty, floorLabelFromSheetId } from "../lib/boqDetect.js";
import { money } from "../lib/num.js";
import { buildBoqPdf } from "../lib/boqPdf.js";
import { downloadBytes } from "../lib/markedset.js";
import { parseSheetKey, sheetExportName } from "../lib/sheetKey.ts";

const num = (v, d = 2) => (Number(v) || 0).toLocaleString(undefined, { maximumFractionDigits: d });

function lineForKey(boqLines, key) {
  return boqLines.find((l) => l.id === key) || null;
}

function groupBySheet(rows) {
  const map = new Map();
  for (const r of rows) {
    const arr = map.get(r.sheet_id) || [];
    arr.push(r);
    map.set(r.sheet_id, arr);
  }
  return [...map.entries()].map(([sheet_id, shapeRows]) => ({ sheet_id, shapeRows }));
}

function sheetFloorTotal(shapeRows) {
  return round2(shapeRows.reduce((n, r) => n + (r.floor_sf || 0), 0));
}

/** sheetLevels key may be a folder path while shape rows use bare filenames. */
function resolveFloorLevel(sheetId, sheetLevels, sheetLabel) {
  if (sheetLevels?.[sheetId]) return sheetLevels[sheetId];
  const parsed = parseSheetKey(sheetId);
  if (sheetLevels?.[parsed.file]) return sheetLevels[parsed.file];
  const base = String(sheetId || "").replace(/^.*[/\\]/, "").split("#")[0].toLowerCase();
  for (const [k, v] of Object.entries(sheetLevels || {})) {
    const kb = String(k).replace(/^.*[/\\]/, "").split("#")[0].toLowerCase();
    if (kb === base) return v;
  }
  for (const [k, v] of Object.entries(sheetLevels || {})) {
    const kt = parseSheetKey(k);
    if (kt.file === parsed.file || kt.file.split("/").pop() === parsed.file.split("/").pop()) return v;
  }
  const fromFile = floorLabelFromSheetId(sheetId);
  if (fromFile) return fromFile;
  const label = sheetLabel?.(sheetId) || sheetId;
  const m = String(label).match(/(\d+(?:st|nd|rd|th))(?:\s*(?:&|and)\s*(\d+(?:st|nd|rd|th)))?\s*floor/i);
  if (m) return m[2] ? `${m[1]} & ${m[2]} Floor` : `${m[1]} Floor`;
  return "";
}

/** Match on-screen BOQ row pricing for CSV export (catalog rates, overrides, notes). */
function resolveExportRow(r, meta, units, conditions, pricingCtx) {
  const pq = primaryQty(r, units);
  const qty = meta.qty_override !== "" && meta.qty_override != null ? Number(meta.qty_override) : pq.qty;
  const unit = meta.unit || pq.unit;
  const primaryRef = r.schedule_refs?.find((x) => x.tag === r.finish_tag) || r.schedule_refs?.[0];
  const description = meta.description || primaryRef?.description || r.finish_tag || "";
  const priced = pricingCtx?.priceRow?.({
    qty,
    unit,
    finish_tag: r.finish_tag,
    description,
    waste_pct: conditions.find((c) => c.id === r.condition_id)?.waste_pct,
  }) || {};
  const rate = meta.rate_material != null
    ? (Number(meta.rate_material) || 0) + (Number(meta.rate_labour) || 0)
      + (Number(meta.rate_equipment) || 0) + (Number(meta.rate_sub) || 0)
    : (Number(meta.rate) || priced.rate || 0);
  const amount = meta.amount != null ? Number(meta.amount) : (priced.amount ?? round2(qty * rate));
  const notes = meta.notes || priced.rate_row?.notes || "";
  const rateRow = priced.rate_row || null;
  const materialName = rateRow?.name || priced.priced_from || description || r.finish_tag || "";
  const materialQty = priced.qty != null ? priced.qty : qty;
  const materialUnit = rateRow?.unit || unit;
  const materialAmount = priced.material_ext != null ? priced.material_ext : round2(materialQty * (Number(rateRow?.rate_material) || 0));
  return { qty, unit, rate, amount, description, notes, materialName, materialQty, materialUnit, materialAmount };
}

function ScheduleRefsBlock({ refs }) {
  if (!refs?.length) return null;
  return (
    <div style={{ padding: "6px 8px 8px", background: "var(--paper-cream)", borderTop: "1px solid var(--ink-faint)" }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-muted)", marginBottom: 6 }}>
        Schedule &amp; finish data · {refs.length} match{refs.length === 1 ? "" : "es"}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {refs.map((ref) => (
          <div key={`${ref.tag}-${ref.source}`} style={{ fontSize: 11.5, lineHeight: 1.4 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "var(--f-mono)", fontWeight: 700, fontSize: 11, color: "var(--cobalt)" }}>{ref.tag}</span>
              {ref.kind && ref.kind !== "finish" && (
                <span style={{ fontSize: 10, color: "var(--ink-muted)", textTransform: "capitalize" }}>{ref.kind.replace(/_/g, " ")}</span>
              )}
              <span style={{ fontSize: 10, color: "var(--ink-muted)", marginLeft: "auto" }}>{ref.source}</span>
            </div>
            {ref.description ? (
              <div style={{ color: "var(--ink)", marginTop: 2 }}>{ref.description}</div>
            ) : null}
            <div style={{ fontSize: 10.5, color: "var(--ink-muted)", marginTop: 2 }}>
              {[ref.manufacturer, ref.color, ref.size].filter(Boolean).join(" · ")}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function roomSubtotals(shapeRows) {
  const byRoom = new Map();
  for (const r of shapeRows) {
    const room = (r.room_detected || "").trim() || "Unassigned";
    const cur = byRoom.get(room) || { floor: 0, wall: 0, lf: 0, ea: 0, masks: 0 };
    cur.floor += r.floor_sf || 0;
    cur.wall += r.wall_sf || 0;
    cur.lf += r.lf || 0;
    cur.ea += r.ea || 0;
    cur.masks += 1;
    byRoom.set(room, cur);
  }
  return [...byRoom.entries()]
    .map(([room, t]) => ({
      room,
      floor_sf: round2(t.floor),
      wall_sf: round2(t.wall),
      lf: round2(t.lf),
      ea: t.ea,
      masks: t.masks,
    }))
    .sort((a, b) => a.room.localeCompare(b.room));
}

export default function BoqPanel({
  open,
  onClose,
  conditions,
  shapes,
  sheetLabel,
  sheetLevels = {},
  boqLines = [],
  onBoqLinesChange,
  units = "imperial",
  projectName = "",
  planSymbols = [],
  symbolNotes = {},
  panelImgs = {},
  roomLabelsBySheet = {},
  scheduleKb = null,
  focusShapeId = null,
  activeShapeId = null,
  onShapeNavigate,
  onShapeDelete,
  onClearFocus,
  onOpenRates,
  onOpenSummary,
  materialRates = [],
  projectSettings = {},
  pricingCtx = null,
}) {
  const detectCtx = useMemo(() => ({
    planSymbols, symbolNotes, panelImgs, roomLabelsBySheet, scheduleKb,
  }), [planSymbols, symbolNotes, panelImgs, roomLabelsBySheet, scheduleKb]);

  const shapeRows = useMemo(
    () => buildShapeRows(shapes, conditions, detectCtx),
    [shapes, conditions, detectCtx],
  );

  const visibleRows = useMemo(
    () => (focusShapeId ? shapeRows.filter((r) => r.shape_id === focusShapeId) : shapeRows),
    [shapeRows, focusShapeId],
  );

  const [viewMode, setViewMode] = useState(focusShapeId ? "annotation" : "floor");
  const [blueprintTarget, setBlueprintTarget] = useState(focusShapeId || "project");
  const [floorFilter, setFloorFilter] = useState("all");

  useEffect(() => {
    if (focusShapeId) {
      setViewMode("annotation");
      setBlueprintTarget(focusShapeId);
    }
  }, [focusShapeId]);

  const bySheet = useMemo(() => groupBySheet(visibleRows), [visibleRows]);
  const condRows = useMemo(() => conditionTotals(conditions, shapes).filter((r) => r.shape_count > 0), [conditions, shapes]);
  const manualLines = useMemo(() => boqLines.filter((l) => l.manual), [boqLines]);
  const [pdfPreview, setPdfPreview] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const pdfPreviewRef = useRef(null);

  useEffect(() => () => {
    if (pdfPreview?.url) URL.revokeObjectURL(pdfPreview.url);
  }, [pdfPreview?.url]);

  const grand = useMemo(() => {
    let floor = 0, wall = 0, lf = 0, ea = 0, cost = 0;
    for (const r of visibleRows) {
      floor += r.floor_sf || 0;
      wall += r.wall_sf || 0;
      lf += r.lf || 0;
      ea += r.ea || 0;
      const key = rowKey(r.shape_id);
      const meta = lineForKey(boqLines, key) || {};
      const pq = primaryQty(r, units);
      const q = meta.qty_override !== "" && meta.qty_override != null ? Number(meta.qty_override) : pq.qty;
      const manualRate = meta.rate != null && meta.rate !== "" ? Number(meta.rate) : null;
      const splitRate = meta.rate_material != null
        ? (Number(meta.rate_material) || 0) + (Number(meta.rate_labour) || 0) + (Number(meta.rate_equipment) || 0) + (Number(meta.rate_sub) || 0)
        : null;
      const rt = manualRate != null ? manualRate : (splitRate != null ? splitRate : 0);
      const amt = meta.amount != null && meta.amount !== "" ? Number(meta.amount) : (q * rt);
      cost += amt || 0;
    }
    for (const m of manualLines) {
      const q = Number(m.qty_override) || 0;
      const rt = Number(m.rate) || 0;
      cost += round2(q * rt);
    }
    return { floor: round2(floor), wall: round2(wall), lf: round2(lf), ea, cost: round2(cost), shapes_n: visibleRows.length, sheets: bySheet.length };
  }, [visibleRows, bySheet.length, boqLines, manualLines, units]);

  const upsertLine = useCallback((key, patch) => {
    onBoqLinesChange((prev) => {
      const i = prev.findIndex((l) => l.id === key);
      if (i >= 0) {
        const next = prev.slice();
        next[i] = { ...next[i], ...patch };
        return next;
      }
      return [...prev, { id: key, manual: false, room: "", description: "", notes: "", unit: "", qty_override: "", rate: "", ...patch }];
    });
  }, [onBoqLinesChange]);

  const addManualRow = useCallback((sheetId = "") => {
    const id = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    onBoqLinesChange((prev) => [...prev, {
      id,
      manual: true,
      sheet_id: sheetId,
      condition_id: "",
      room: "",
      description: "",
      notes: "",
      unit: areaUnit(units),
      qty_override: "",
      rate: "",
    }]);
  }, [onBoqLinesChange, units]);

  const removeLine = useCallback((id) => {
    onBoqLinesChange((prev) => prev.filter((l) => l.id !== id));
  }, [onBoqLinesChange]);

  useEffect(() => {
    if (!open) return;
    onBoqLinesChange((prev) => {
      const byId = new Map(prev.map((l) => [l.id, l]));
      const liveShapeIds = new Set(shapeRows.map((r) => r.shape_id));
      let changed = false;
      const next = prev.filter((l) => l.manual || !l.shape_id || liveShapeIds.has(l.shape_id));

      for (const r of shapeRows) {
        const key = rowKey(r.shape_id);
        const ex = byId.get(key);
        const autoRoom = r.room_detected || "";
        const room = ex?.room_manual ? (ex.room || "") : (ex?.room || autoRoom);
        const row = {
          id: key,
          shape_id: r.shape_id,
          manual: false,
          sheet_id: r.sheet_id,
          condition_id: r.condition_id,
          room,
          room_manual: ex?.room_manual || false,
          description: ex?.description || r.finish_tag || "",
          notes: ex?.notes || "",
          unit: ex?.unit || "",
          qty_override: ex?.qty_override ?? "",
          rate: ex?.rate ?? "",
        };
        if (!ex) {
          next.push(row);
          changed = true;
        } else {
          const i = next.findIndex((l) => l.id === key);
          if (i >= 0) {
            const merged = { ...ex, ...row, room_manual: ex.room_manual || false };
            if (JSON.stringify(merged) !== JSON.stringify(next[i])) {
              next[i] = merged;
              changed = true;
            }
          }
        }
      }
      if (next.length !== prev.length) changed = true;
      return changed ? next : prev;
    });
  }, [shapeRows, open, onBoqLinesChange]);

  const syncFromTakeoff = useCallback(() => {
    onBoqLinesChange((prev) => {
      const byId = new Map(prev.map((l) => [l.id, l]));
      const next = [...prev];
      for (const r of shapeRows) {
        const key = rowKey(r.shape_id);
        const ex = byId.get(key);
        const autoRoom = r.room_detected || "";
        const patch = {
          id: key,
          shape_id: r.shape_id,
          manual: false,
          sheet_id: r.sheet_id,
          condition_id: r.condition_id,
          room: ex?.room_manual ? (ex.room || "") : autoRoom,
          description: r.finish_tag || "",
        };
        if (ex) {
          const i = next.findIndex((l) => l.id === key);
          if (i >= 0) next[i] = { ...ex, ...patch, room_manual: ex.room_manual || false };
        } else {
          next.push({ ...patch, notes: "", unit: "", qty_override: "", rate: "", room_manual: false });
        }
      }
      return next;
    });
  }, [shapeRows, onBoqLinesChange]);

  const exportCsv = useCallback(() => {
    const header = ["Floor/Level", "Sheet", "Room/Area", "Finish", "Description", "Floor SF", "Wall SF", "LF", "EA", "Qty", "Unit", "Rate", "Amount", "Material Name", "Material Qty", "Material Unit", "Material Amount", "Notes", "Source"];
    const lines = [`# Bill of Quantities${projectName ? ` — ${projectName}` : ""}`, header.map(csvEsc).join(",")];
    for (const g of bySheet) {
      const floor = resolveFloorLevel(g.sheet_id, sheetLevels, sheetLabel);
      const sheet = sheetExportName(g.sheet_id);
      for (const r of g.shapeRows) {
        const key = rowKey(r.shape_id);
        const meta = lineForKey(boqLines, key) || {};
        const { qty, unit, rate, amount, description, notes, materialName, materialQty, materialUnit, materialAmount } = resolveExportRow(r, meta, units, conditions, pricingCtx);
        lines.push([
          floor, sheet, meta.room || r.room_detected || "", r.finish_tag, description,
          r.floor_sf || "", r.wall_sf || "", r.lf || "", r.ea || "", qty, unit, rate, amount,
          materialName, materialQty, materialUnit, materialAmount, notes, "takeoff",
        ].map(csvEsc).join(","));
      }
    }
    for (const m of manualLines) {
      const qty = Number(m.qty_override) || 0;
      const rate = Number(m.rate) || 0;
      lines.push([
        resolveFloorLevel(m.sheet_id, sheetLevels, sheetLabel), m.sheet_id ? sheetExportName(m.sheet_id) : "—",
        m.room || "", "", m.description || "",
        "", "", "", "", qty, m.unit || "", rate, round2(qty * rate),
        m.description || "", qty, m.unit || "", round2(qty * rate), m.notes || "", "manual",
      ].map(csvEsc).join(","));
    }
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(projectName || "takeoff").replace(/[^\w.-]+/g, "_")}-boq.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [bySheet, boqLines, manualLines, projectName, sheetLabel, sheetLevels, units, conditions, pricingCtx]);

  const boqPdfPayload = useCallback(() => {
    const sheets = bySheet.map((g) => {
      const floor = resolveFloorLevel(g.sheet_id, sheetLevels, sheetLabel);
      const sheet = sheetExportName(g.sheet_id);
      const floorTotal = sheetFloorTotal(g.shapeRows);
      const takeoffRows = g.shapeRows.map((r) => {
        const key = rowKey(r.shape_id);
        const meta = lineForKey(boqLines, key) || {};
        const { qty, unit, rate, amount, description, notes } = resolveExportRow(r, meta, units, conditions, pricingCtx);
        return {
          room: meta.room || r.room_detected || "",
          finish: r.finish_tag || "",
          description,
          floor_sf: r.floor_sf,
          wall_sf: r.wall_sf,
          lf: r.lf,
          ea: r.ea,
          qty,
          unit,
          rate,
          amount,
          notes,
        };
      });
      const sheetManual = manualLines.filter((m) => m.sheet_id === g.sheet_id).map((m) => {
        const qty = Number(m.qty_override) || 0;
        const rate = Number(m.rate) || 0;
        return {
          room: m.room || "",
          finish: "Manual",
          floor_sf: null,
          wall_sf: null,
          lf: null,
          ea: null,
          qty,
          unit: m.unit || "",
          rate,
          amount: round2(qty * rate),
          notes: m.notes || m.description || "",
        };
      });
      const roomSummary = roomSubtotals(g.shapeRows.map((r) => {
        const key = rowKey(r.shape_id);
        const meta = lineForKey(boqLines, key);
        return { ...r, room_detected: meta?.room || r.room_detected };
      }));
      return {
        title: floor ? `${floor} · ${sheet}` : sheet,
        subtitle: `${num(floorTotal)} ${areaUnit(units)} masked · ${g.shapeRows.length} mask${g.shapeRows.length === 1 ? "" : "s"} · ${roomSummary.length} room${roomSummary.length === 1 ? "" : "s"}`,
        floorTotal,
        rows: [...takeoffRows, ...sheetManual],
        roomSummary,
      };
    });
    const unassignedManual = manualLines.filter((m) => !m.sheet_id).map((m) => {
      const qty = Number(m.qty_override) || 0;
      const rate = Number(m.rate) || 0;
      return {
        room: m.room || "",
        finish: "Manual",
        floor_sf: null,
        wall_sf: null,
        lf: null,
        ea: null,
        qty,
        unit: m.unit || "",
        rate,
        amount: round2(qty * rate),
        notes: m.notes || m.description || "",
      };
    });
    return {
      projectName,
      units,
      currency: projectSettings.currency || "AED",
      sheets,
      manualLines: unassignedManual,
      grand,
    };
  }, [bySheet, boqLines, manualLines, projectName, sheetLabel, sheetLevels, units, conditions, pricingCtx, projectSettings.currency, grand]);

  const openBoqPdfPreview = useCallback(async () => {
    setPdfBusy(true);
    try {
      const { bytes, filename } = await buildBoqPdf(boqPdfPayload());
      setPdfPreview((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url);
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        return { url, filename, bytes };
      });
    } finally {
      setPdfBusy(false);
    }
  }, [boqPdfPayload]);

  const closePdfPreview = () => {
    setPdfPreview((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
  };

  const downloadPdfPreview = () => {
    if (pdfPreview) downloadBytes(pdfPreview.filename, pdfPreview.bytes);
  };

  const printPdfPreview = () => {
    pdfPreviewRef.current?.contentWindow?.print();
  };

  if (!open) return null;

  const th = { textAlign: "left", padding: "6px 8px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-muted)", borderBottom: "1px solid var(--ink-faint)", whiteSpace: "nowrap" };
  const td = { padding: "5px 8px", fontSize: 12, borderBottom: "1px solid var(--ink-faint)", verticalAlign: "top" };
  const inp = { width: "100%", minWidth: 0, padding: "4px 6px", border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", fontSize: 12, fontFamily: "inherit" };
  const dash = "—";

  const handleRowNavigate = (shapeId, e) => {
    if (e.target.closest("input, button, textarea, select")) return;
    onShapeNavigate?.(shapeId);
  };

  const renderDataRow = (g, r) => {
    const key = rowKey(r.shape_id);
    const meta = lineForKey(boqLines, key) || {};
    const pq = primaryQty(r, units);
    const displayRoom = meta.room || r.room_detected || "";
    const autoRoom = !meta.room_manual && r.room_detected && displayRoom === r.room_detected;
    const primaryRef = r.schedule_refs?.find((x) => x.tag === r.finish_tag) || r.schedule_refs?.[0];
    const autoDesc = primaryRef?.description || "";
    const displayDesc = meta.description || autoDesc;
    const qty = meta.qty_override !== "" && meta.qty_override != null && meta.qty_override !== undefined
      ? Number(meta.qty_override) : pq.qty;
    const unit = meta.unit || pq.unit;
    const priced = pricingCtx?.priceRow?.({
      qty, unit,
      finish_tag: r.finish_tag,
      description: displayDesc,
      waste_pct: conditions.find((c) => c.id === r.condition_id)?.waste_pct,
    }) || {};
    const rate = meta.rate_material != null
      ? (Number(meta.rate_material) || 0) + (Number(meta.rate_labour) || 0) + (Number(meta.rate_equipment) || 0) + (Number(meta.rate_sub) || 0)
      : (Number(meta.rate) || priced.rate || 0);
    const amount = meta.amount != null ? Number(meta.amount) : (priced.amount ?? round2(qty * rate));
    const active = activeShapeId === r.shape_id;
    const colSpan = onShapeDelete ? 12 : 11;
    return (
      <React.Fragment key={key}>
      <tr
        onClick={(e) => handleRowNavigate(r.shape_id, e)}
        title="Click to locate this mask on the plan"
        style={{
          cursor: onShapeNavigate ? "pointer" : "default",
          background: active ? "var(--paper-cream)" : undefined,
          outline: active ? "1px solid var(--cobalt)" : undefined,
          outlineOffset: -1,
        }}
      >
        <td style={td}>
          <input style={{ ...inp, fontStyle: autoRoom ? "italic" : "normal" }} value={displayRoom} placeholder="Room / zone"
            title={autoRoom ? `Auto-detected: ${r.room_detected}` : undefined}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => upsertLine(key, { room: e.target.value, room_manual: true, sheet_id: g.sheet_id, condition_id: r.condition_id, shape_id: r.shape_id })} />
          {r.needs_review && (
            <div style={{ marginTop: 2 }}>
              <span
                title={r.review_reason || "Please review this item"}
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  color: "var(--c-warning, #d97706)",
                  background: "rgba(217, 119, 6, 0.10)",
                  border: "1px solid rgba(217, 119, 6, 0.30)",
                  borderRadius: 3,
                  padding: "1px 4px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                }}
              >
                Please review
              </span>
            </div>
          )}
        </td>
        <td style={{ ...td, fontWeight: 600 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: r.color, flexShrink: 0 }} />
            <span style={{ fontFamily: "var(--f-mono)", fontWeight: 700, fontSize: 12, color: "var(--cobalt)", background: "rgba(31, 63, 199, 0.08)", padding: "1px 6px", borderRadius: 3 }}>
            {r.finish_tag || dash}
          </span>
          </div>
          {displayDesc && (
            <div style={{ fontSize: 10.5, color: "var(--ink)", fontWeight: 400, marginTop: 3, lineHeight: 1.35, maxWidth: 160 }}
              title={displayDesc}>
              {displayDesc}
            </div>
          )}
          {(r.floor_sf > 0 || r.role === "floor_area") && r.lf > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                const skid = `skirt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                onBoqLinesChange((prev) => [
                  ...prev,
                  {
                    id: skid,
                    manual: true,
                    sheet_id: g.sheet_id,
                    condition_id: "",
                    room: displayRoom ? `${displayRoom} (Skirting)` : "Skirting",
                    description: "Skirting (from perimeter)",
                    notes: `Matched perimeter of ${r.finish_tag || "room"}`,
                    unit: lenUnit(units),
                    qty_override: String(num(r.lf)),
                    rate: "",
                  },
                ]);
              }}
              title="Create a linear skirting takeoff row matching this room's perimeter"
              style={{
                marginTop: 4,
                border: "1px dashed var(--cobalt)",
                background: "rgba(31, 63, 199, 0.04)",
                color: "var(--cobalt)",
                borderRadius: 4,
                padding: "2px 6px",
                fontSize: 9.5,
                fontWeight: 600,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              + Match perimeter ({num(r.lf)} {lenUnit(units)})
            </button>
          )}
        </td>
        <td style={{ ...td, fontFamily: "var(--f-mono)", textAlign: "right" }}>{r.floor_sf ? num(r.floor_sf) : dash}</td>
        <td style={{ ...td, fontFamily: "var(--f-mono)", textAlign: "right" }}>{r.wall_sf ? num(r.wall_sf) : dash}</td>
        <td style={{ ...td, fontFamily: "var(--f-mono)", textAlign: "right" }}>{r.lf ? num(r.lf) : dash}</td>
        <td style={{ ...td, fontFamily: "var(--f-mono)", textAlign: "right" }}>{r.ea ? num(r.ea, 0) : dash}</td>
        <td style={td}>
          <input style={{ ...inp, width: 64, textAlign: "right" }} type="number" step="any"
            value={meta.qty_override !== "" && meta.qty_override != null ? meta.qty_override : ""}
            placeholder={num(pq.qty)}
            title={`Auto: ${num(pq.qty)} ${pq.unit}`}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => upsertLine(key, { qty_override: e.target.value, sheet_id: g.sheet_id, condition_id: r.condition_id, shape_id: r.shape_id })} />
        </td>
        <td style={td}>
          <input style={{ ...inp, width: 48 }} value={meta.unit || ""} placeholder={pq.unit}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => upsertLine(key, { unit: e.target.value, sheet_id: g.sheet_id, condition_id: r.condition_id, shape_id: r.shape_id })} />
        </td>
        <td style={td}>
          <input style={{ ...inp, width: 72, textAlign: "right" }} type="number" step="any"
            value={meta.rate ?? ""} placeholder={priced.rate ? String(priced.rate) : "0"}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => upsertLine(key, { rate: e.target.value, sheet_id: g.sheet_id, condition_id: r.condition_id, shape_id: r.shape_id })} />
          {!meta.rate && !priced.rate && (r.finish_tag || displayDesc) && (
            <div style={{ fontSize: 9, color: "var(--c-warning)", marginTop: 2 }}>
              No rate
              {onOpenRates ? (
                <> — <button type="button" onClick={(e) => { e.stopPropagation(); onOpenRates(); }}
                  style={{ border: "none", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontSize: 9, padding: 0, textDecoration: "underline" }}>Rates</button></>
              ) : null}
            </div>
          )}
        </td>
        <td style={{ ...td, fontFamily: "var(--f-mono)", textAlign: "right", fontWeight: 600 }}>
          {amount ? money(amount, projectSettings.currency || "AED") : dash}
          {priced.priced_from && !meta.rate && (
            <div style={{ fontSize: 9, color: "var(--ink-muted)", fontWeight: 400 }}>{priced.priced_from}</div>
          )}
        </td>
        <td style={td}>
          <input style={inp} value={meta.notes || ""} placeholder="Notes"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => upsertLine(key, { notes: e.target.value, sheet_id: g.sheet_id, condition_id: r.condition_id, shape_id: r.shape_id })} />
        </td>
        {onShapeDelete && (
          <td style={{ ...td, width: 32, padding: "5px 4px", textAlign: "center" }}>
            <button
              type="button"
              title="Delete mask from plan and BOQ"
              aria-label="Delete mask"
              onClick={(e) => { e.stopPropagation(); onShapeDelete(r.shape_id); }}
              style={{
                border: "none", background: "transparent", cursor: "pointer",
                color: "var(--ink-muted)", fontSize: 15, lineHeight: 1, padding: "2px 4px",
                borderRadius: 2,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--c-danger)"; e.currentTarget.style.background = "var(--paper-shadow)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--ink-muted)"; e.currentTarget.style.background = "transparent"; }}
            >
              ×
            </button>
          </td>
        )}
      </tr>
      {r.openings?.length > 0 && (
        <tr>
          <td colSpan={colSpan} style={{ padding: "4px 8px 6px 36px", background: "rgba(176, 58, 38, 0.03)", borderBottom: "1px solid var(--ink-faint)" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", fontSize: 11 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Wall Gross: <b style={{ color: "var(--ink)", fontFamily: "var(--f-mono)" }}>{num(r.gross_wall_sf)} {areaUnit(units)}</b>
              </span>
              <span style={{ fontSize: 10, color: "var(--ink-muted)" }}>|</span>
              <div style={{ display: "inline-flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--c-danger, #b03a26)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Deductions ({r.openings.length}):
                </span>
                {r.openings.map((o, idx) => (
                  <span
                    key={idx}
                    style={{
                      fontFamily: "var(--f-mono)",
                      fontSize: 10.5,
                      color: o.unnamed ? "var(--c-warning, #d97706)" : "var(--c-danger, #b03a26)",
                      background: o.unnamed ? "rgba(217, 119, 6, 0.12)" : "rgba(176, 58, 38, 0.08)",
                      border: o.unnamed ? "1px solid rgba(217, 119, 6, 0.3)" : "none",
                      padding: "1px 5px",
                      borderRadius: 3,
                    }}
                  >
                    {o.unnamed ? "" : ""}{o.tag}: −{num(o.sf)} {areaUnit(units)}
                  </span>
                ))}
              </div>
              <span style={{ fontSize: 10, color: "var(--ink-muted)" }}>|</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--cobalt)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Net: <b style={{ color: "var(--cobalt)", fontFamily: "var(--f-mono)" }}>{num(r.wall_sf)} {areaUnit(units)}</b>
              </span>
              {r.lf > 0 && (
                <>
                  <span style={{ fontSize: 10, color: "var(--ink-muted)" }}>|</span>
                  <span style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)" }}>
                    Perimeter: <b style={{ color: "var(--ink)", fontFamily: "var(--f-mono)" }}>{num(r.lf)} {lenUnit(units)}</b>
                  </span>
                </>
              )}
            </div>
          </td>
        </tr>
      )}
      {r.schedule_refs?.length > 0 && (
        <tr>
          <td colSpan={colSpan} style={{ padding: 0, borderBottom: "1px solid var(--ink-faint)" }}>
            <ScheduleRefsBlock refs={r.schedule_refs} />
          </td>
        </tr>
      )}
      </React.Fragment>
    );
  };

  const blueprintData = useMemo(() => {
    if (!shapeRows.length) return null;
    let targetRows = shapeRows;
    let scopeType = "room"; // "room" | "floor" | "project"
    let title = "Room Blueprint";
    let subtitle = "";
    let color = "var(--cobalt)";
    let tag = "SPEC";
    let activeShape = null;

    if (blueprintTarget === "project") {
      scopeType = "project";
      title = "Entire Project Rollup";
      subtitle = `${shapeRows.length} rooms & areas across ${bySheet.length} floor(s)`;
      targetRows = shapeRows;
      tag = "PROJECT";
    } else if (blueprintTarget?.startsWith("floor:")) {
      scopeType = "floor";
      const sid = blueprintTarget.replace("floor:", "");
      targetRows = shapeRows.filter((r) => r.sheet_id === sid);
      const floor = sheetLevels?.[sid] || "";
      const sheet = typeof sheetLabel === "function" ? sheetLabel(sid) : (sheetLabel || sid || "");
      title = `${floor ? `${floor} · ` : ""}${sheet}`;
      subtitle = `${targetRows.length} rooms & areas on this floor`;
      tag = floor ? floor.toUpperCase() : "FLOOR";
    } else {
      activeShape = shapeRows.find((r) => r.shape_id === (blueprintTarget || focusShapeId)) || shapeRows[0];
      targetRows = activeShape ? [activeShape] : [];
      const smeta = lineForKey(boqLines, rowKey(activeShape?.shape_id));
      title = smeta?.room || activeShape?.room_detected || "Unnamed Room";
      color = activeShape?.color || "var(--cobalt)";
      tag = activeShape?.finish_tag || "SPEC";
    }

    let floor_gross_sf = 0, floor_openings_sf = 0, floor_net_sf = 0;
    let gross_wall_sf = 0, doors_deduct_sf = 0, windows_deduct_sf = 0, wall_sf = 0;
    let ceiling_gross_sf = 0, ceiling_openings_sf = 0, ceiling_net_sf = 0;
    let skirting_gross_lf = 0, skirting_door_deduct_lf = 0, skirting_net_lf = 0;
    let allDoors = [], allWindows = [];
    let totalCost = 0;

    for (const r of targetRows) {
      floor_gross_sf += (r.floor_gross_sf || r.floor_sf || 0);
      floor_openings_sf += (r.floor_openings_sf || 0);
      floor_net_sf += (r.floor_net_sf || r.floor_sf || 0);

      gross_wall_sf += (r.gross_wall_sf || r.wall_sf || 0);
      doors_deduct_sf += (r.doors_deduct_sf || 0);
      windows_deduct_sf += (r.windows_deduct_sf || 0);
      wall_sf += (r.wall_sf || 0);

      ceiling_gross_sf += (r.ceiling_gross_sf || r.floor_sf || 0);
      ceiling_openings_sf += (r.ceiling_openings_sf || 0);
      ceiling_net_sf += (r.ceiling_net_sf || r.floor_sf || 0);

      skirting_gross_lf += (r.skirting_gross_lf || r.lf || 0);
      skirting_door_deduct_lf += (r.skirting_door_deduct_lf || 0);
      skirting_net_lf += (r.skirting_net_lf || r.lf || 0);

      if (r.doors?.length) allDoors.push(...r.doors);
      if (r.windows?.length) allWindows.push(...r.windows);

      const key = rowKey(r.shape_id);
      const meta = lineForKey(boqLines, key) || {};
      const pq = primaryQty(r, units);
      const q = meta.qty_override !== "" && meta.qty_override != null ? Number(meta.qty_override) : pq.qty;
      const manualRate = meta.rate != null && meta.rate !== "" ? Number(meta.rate) : null;
      const splitRate = meta.rate_material != null
        ? (Number(meta.rate_material) || 0) + (Number(meta.rate_labour) || 0) + (Number(meta.rate_equipment) || 0) + (Number(meta.rate_sub) || 0)
        : null;
      const rt = manualRate != null ? manualRate : (splitRate != null ? splitRate : 0);
      const amt = meta.amount != null && meta.amount !== "" ? Number(meta.amount) : (q * rt);
      totalCost += (amt || 0);
    }

    return {
      scopeType,
      title,
      subtitle,
      color,
      tag,
      activeShape,
      targetRows,
      floor_gross_sf: round2(floor_gross_sf),
      floor_openings_sf: round2(floor_openings_sf),
      floor_net_sf: round2(floor_net_sf),
      gross_wall_sf: round2(gross_wall_sf),
      doors_deduct_sf: round2(doors_deduct_sf),
      windows_deduct_sf: round2(windows_deduct_sf),
      wall_sf: round2(wall_sf),
      ceiling_gross_sf: round2(ceiling_gross_sf),
      ceiling_openings_sf: round2(ceiling_openings_sf),
      ceiling_net_sf: round2(ceiling_net_sf),
      skirting_gross_lf: round2(skirting_gross_lf),
      skirting_door_deduct_lf: round2(skirting_door_deduct_lf),
      skirting_net_lf: round2(skirting_net_lf),
      doors: allDoors,
      windows: allWindows,
      totalCost: round2(totalCost),
    };
  }, [shapeRows, blueprintTarget, focusShapeId, bySheet, sheetLevels, sheetLabel, boqLines, units]);

  return (
    <>
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--paper-bright)", overflow: "hidden", minHeight: 0 }}>
      {/* Header */}
      <div data-float-drag style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", background: "var(--cobalt)", color: "var(--accent-contrast)", cursor: "grab", userSelect: "none", flexShrink: 0 }}>
        <Icon name="document" size={16} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: "0.02em" }}>Bill of Quantities</div>
          <div style={{ fontSize: 10.5, opacity: 0.85, marginTop: 2 }}>Architectural takeoff &amp; costing · room &amp; floor breakdown</div>
        </div>
        <button type="button" onClick={onClose} title="Close BOQ panel" style={{ border: "none", background: "transparent", color: "inherit", fontSize: 18, cursor: "pointer", padding: "0 4px" }}>×</button>
      </div>

      {/* 3 Tiered View Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-shadow)", flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => setViewMode("annotation")}
          style={{
            flex: 1, padding: "8px 6px", border: "none",
            borderBottom: viewMode === "annotation" ? "2px solid var(--cobalt)" : "2px solid transparent",
            background: viewMode === "annotation" ? "var(--paper-bright)" : "transparent",
            color: viewMode === "annotation" ? "var(--cobalt)" : "var(--ink-muted)",
            fontWeight: viewMode === "annotation" ? 700 : 600,
            fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
          }}
        >
          <span>Room Blueprint</span>
        </button>
        <button
          type="button"
          onClick={() => { setViewMode("floor"); if (focusShapeId) onClearFocus?.(); }}
          style={{
            flex: 1, padding: "8px 6px", border: "none",
            borderBottom: viewMode === "floor" ? "2px solid var(--cobalt)" : "2px solid transparent",
            background: viewMode === "floor" ? "var(--paper-bright)" : "transparent",
            color: viewMode === "floor" ? "var(--cobalt)" : "var(--ink-muted)",
            fontWeight: viewMode === "floor" ? 700 : 600,
            fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
          }}
        >
          <span>Per Floor</span>
        </button>
        <button
          type="button"
          onClick={() => { setViewMode("project"); if (focusShapeId) onClearFocus?.(); }}
          style={{
            flex: 1, padding: "8px 6px", border: "none",
            borderBottom: viewMode === "project" ? "2px solid var(--cobalt)" : "2px solid transparent",
            background: viewMode === "project" ? "var(--paper-bright)" : "transparent",
            color: viewMode === "project" ? "var(--cobalt)" : "var(--ink-muted)",
            fontWeight: viewMode === "project" ? 700 : 600,
            fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
          }}
        >
          <span>Project Rollup</span>
          </button>
        </div>

      {/* Overview Stat Bar */}
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--ink-faint)", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", background: "var(--paper-cream)", flexShrink: 0 }}>
        <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>
          {grand.sheets} floor{grand.sheets === 1 ? "" : "s"} · {grand.shapes_n} item{grand.shapes_n === 1 ? "" : "s"} ·{" "}
          <b style={{ color: "var(--ink)" }}>{num(grand.floor)} {areaUnit(units)}</b> floor
          {grand.wall > 0 && <> · <b style={{ color: "var(--ink)" }}>{num(grand.wall)} {areaUnit(units)}</b> wall</>}
          {grand.cost > 0 && <> · <b style={{ color: "var(--cobalt)" }}>{money(grand.cost)}</b></>}
        </span>
        <div style={{ flex: 1 }} />
        {onOpenSummary && (
          <button
            type="button"
            onClick={onOpenSummary}
            title="Open Hierarchical Summary (Floor → Item Type → Code)"
            style={{
              padding: "3px 7px",
              border: "1px solid var(--cobalt)",
              background: "transparent",
              color: "var(--cobalt)",
              fontSize: 10.5,
              fontWeight: 600,
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Summary Hierarchy →
        </button>
        )}
        <ToolMenu
          title="Export bill of quantities"
          disabled={!bySheet.length && !manualLines.length}
          face="Export"
          faceStyle={{
            padding: "4px 8px",
            border: "none",
            background: "var(--ink)",
            color: "var(--paper-bright)",
            fontSize: 11,
            fontWeight: 700,
            borderRadius: 16,
          }}
          items={[
            { id: "pdf", icon: "document", label: "PDF", title: "Preview BOQ as ADICC-branded PDF", onSelect: openBoqPdfPreview },
            { id: "csv", icon: "document", label: "CSV", title: "Download BOQ spreadsheet", onSelect: exportCsv },
          ]}
        />
      </div>

      {/* Main Tab Content */}
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {/* MODE 1: BLUEPRINT CARD (ROOM / FLOOR / PROJECT) */}
        {viewMode === "annotation" && (
          <div style={{ padding: "12px", display: "grid", gap: 10 }}>
            {!shapeRows.length ? (
              <div style={{ padding: "20px 14px", color: "var(--ink-muted)", fontSize: 13, textAlign: "center" }}>
                No rooms or masks traced yet. Draw or auto-takeoff an area to view its architectural blueprint breakdown.
              </div>
            ) : blueprintData ? (() => {
              const b = blueprintData;
              const aU = areaUnit(units);
              const lU = lenUnit(units);
              const isRoom = b.scopeType === "room" && b.activeShape;
              const r = b.activeShape;
              const key = r ? rowKey(r.shape_id) : "";
              const meta = r ? (lineForKey(boqLines, key) || {}) : {};
              const pq = r ? primaryQty(r, units) : { qty: b.floor_net_sf, unit: aU };
              const displayRoom = b.title;
              const autoDesc = r ? ((r.schedule_refs?.find((x) => x.tag === r.finish_tag) || r.schedule_refs?.[0])?.description || "") : "";
              const displayDesc = meta.description || autoDesc;
              const qty = meta.qty_override !== "" && meta.qty_override != null ? Number(meta.qty_override) : pq.qty;
              const unit = meta.unit || pq.unit;
              const manualRate = meta.rate != null && meta.rate !== "" ? Number(meta.rate) : null;
              const splitRate = meta.rate_material != null
                ? (Number(meta.rate_material) || 0) + (Number(meta.rate_labour) || 0) + (Number(meta.rate_equipment) || 0) + (Number(meta.rate_sub) || 0)
                : null;
              const priced = r ? (pricingCtx?.priceRow?.({
                qty, unit,
                finish_tag: r.finish_tag,
                description: displayDesc,
                waste_pct: conditions.find((c) => c.id === r.condition_id)?.waste_pct,
              }) || {}) : {};
              const rate = manualRate != null ? manualRate : (splitRate != null ? splitRate : (priced.rate || 0));
              const amount = isRoom
                ? (meta.amount != null && meta.amount !== "" ? Number(meta.amount) : (priced.amount ?? round2(qty * rate)))
                : b.totalCost;

              return (
                <div style={{ display: "grid", gap: 10 }}>
                  {/* Universal Scope / Room Switcher Dropdown */}
                  <div style={{ display: "flex", gap: 8, alignItems: "center", background: "var(--paper-shadow)", padding: "8px 10px", borderRadius: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-muted)", textTransform: "uppercase" }}>Scope:</span>
                    <select
                      value={blueprintTarget}
                      onChange={(e) => {
                        setBlueprintTarget(e.target.value);
                        if (!e.target.value.startsWith("floor:") && e.target.value !== "project") {
                          onShapeNavigate?.(e.target.value);
                        }
                      }}
                      style={{
                        flex: 1, minWidth: 0, padding: "4px 8px", fontSize: 12, fontWeight: 600,
                        border: "1px solid var(--ink-faint)", borderRadius: 4, background: "var(--paper-bright)", color: "var(--ink)",
                      }}
                    >
                      <option value="project">Complete Project (Whole Building Rollup)</option>
                      <optgroup label="Complete Floors">
                        {bySheet.map((g) => {
                          const flr = sheetLevels?.[g.sheet_id] || "";
                          const sht = typeof sheetLabel === "function" ? sheetLabel(g.sheet_id) : (sheetLabel || g.sheet_id || "");
                          return (
                            <option key={`floor:${g.sheet_id}`} value={`floor:${g.sheet_id}`}>
                              {flr ? `${flr} · ` : ""}{sht} ({g.shapeRows.length} rooms)
                            </option>
                          );
                        })}
                      </optgroup>
                      <optgroup label="Individual Rooms / Annotations">
                        {shapeRows.map((s) => {
                          const smeta = lineForKey(boqLines, rowKey(s.shape_id));
                          const sRoom = smeta?.room || s.room_detected || "Room";
                          return (
                            <option key={s.shape_id} value={s.shape_id}>
                              {sRoom} · {s.finish_tag || "SPEC"} ({num(s.floor_sf || s.wall_sf)} {aU})
                            </option>
                          );
                        })}
                      </optgroup>
                    </select>
                    {isRoom && onShapeNavigate && (
                      <button
                        type="button"
                        onClick={() => onShapeNavigate(r.shape_id)}
                        title="Locate on drawing plan"
                        style={{
                          padding: "4px 8px", border: "1px solid var(--cobalt)", borderRadius: 4,
                          background: "var(--cobalt)", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer",
                        }}
                      >
                        Locate
                      </button>
                    )}
                  </div>

                  {/* Header Badge */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 2px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 12, height: 12, borderRadius: 3, background: b.color || "var(--cobalt)" }} />
                      <span style={{ fontFamily: "var(--f-mono)", fontSize: 13, fontWeight: 800, color: "var(--cobalt)", background: "rgba(31, 63, 199, 0.08)", padding: "2px 8px", borderRadius: 4 }}>
                        {b.tag}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>{displayRoom}</span>
                    </div>
                    {b.subtitle && (
                      <span style={{ fontSize: 11, color: "var(--ink-muted)", fontStyle: "italic" }}>
                        {b.subtitle}
                      </span>
                    )}
                  </div>

                  {/* 6 Blueprint Categories (Matching Client Diagram) */}
                  <div style={{ display: "grid", gap: 8 }}>
                    {/* 1. Floor Area */}
                    <div style={{ background: "rgba(0,0,0,0.02)", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--ink-faint)", display: "grid", gap: 4 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--cobalt)", display: "flex", justifyContent: "space-between" }}>
                        <span>* Floor Area</span>
                        <span style={{ fontFamily: "var(--f-mono)" }}>{num(b.floor_net_sf)} {aU}</span>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "14px 100px 1fr", gap: 6, fontSize: 11, alignItems: "baseline" }}>
                        <span style={{ color: "var(--ink-muted)" }}>↳</span>
                        <span style={{ color: "var(--ink-muted)", textTransform: "uppercase", fontSize: 10 }}>Gross Area</span>
                        <span style={{ fontFamily: "var(--f-mono)", textAlign: "right" }}>{num(b.floor_gross_sf)} {aU}</span>
                      </div>
                      {b.floor_openings_sf > 0 && (
                        <div style={{ display: "grid", gridTemplateColumns: "14px 100px 1fr", gap: 6, fontSize: 11, alignItems: "baseline", color: "var(--c-danger, #b03a26)" }}>
                          <span>↳</span>
                          <span style={{ textTransform: "uppercase", fontSize: 10 }}>Openings</span>
                          <span style={{ fontFamily: "var(--f-mono)", textAlign: "right" }}>−{num(b.floor_openings_sf)} {aU}</span>
                        </div>
                      )}
                      <div style={{ display: "grid", gridTemplateColumns: "14px 100px 1fr", gap: 6, fontSize: 11, fontWeight: 700, alignItems: "baseline" }}>
                        <span style={{ color: "var(--ink-muted)" }}>↳</span>
                        <span style={{ textTransform: "uppercase", fontSize: 10 }}>Area Net</span>
                        <span style={{ fontFamily: "var(--f-mono)", textAlign: "right", color: "var(--cobalt)" }}>{num(b.floor_net_sf)} {aU}</span>
                      </div>
                    </div>

                    {/* 2. Wall Area */}
                    <div style={{ background: "rgba(0,0,0,0.02)", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--ink-faint)", display: "grid", gap: 4 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--cobalt)", display: "flex", justifyContent: "space-between" }}>
                        <span>* Wall Area</span>
                        <span style={{ fontFamily: "var(--f-mono)" }}>{num(b.wall_sf)} {aU}</span>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "14px 100px 1fr", gap: 6, fontSize: 11, alignItems: "baseline" }}>
                        <span style={{ color: "var(--ink-muted)" }}>↳</span>
                        <span style={{ color: "var(--ink-muted)", textTransform: "uppercase", fontSize: 10 }}>Gross Area</span>
                        <span style={{ fontFamily: "var(--f-mono)", textAlign: "right" }}>{num(b.gross_wall_sf)} {aU}</span>
                      </div>
                      {b.doors_deduct_sf > 0 && (
                        <div style={{ display: "grid", gridTemplateColumns: "14px 100px 1fr", gap: 6, fontSize: 11, alignItems: "baseline", color: "var(--c-danger, #b03a26)" }}>
                          <span>↳</span>
                          <span style={{ textTransform: "uppercase", fontSize: 10 }}>Doors Deduct</span>
                          <span style={{ fontFamily: "var(--f-mono)", textAlign: "right" }}>−{num(b.doors_deduct_sf)} {aU}</span>
                        </div>
                      )}
                      {b.windows_deduct_sf > 0 && (
                        <div style={{ display: "grid", gridTemplateColumns: "14px 100px 1fr", gap: 6, fontSize: 11, alignItems: "baseline", color: "var(--c-danger, #b03a26)" }}>
                          <span>↳</span>
                          <span style={{ textTransform: "uppercase", fontSize: 10 }}>Windows Deduct</span>
                          <span style={{ fontFamily: "var(--f-mono)", textAlign: "right" }}>−{num(b.windows_deduct_sf)} {aU}</span>
                        </div>
                      )}
                      <div style={{ display: "grid", gridTemplateColumns: "14px 100px 1fr", gap: 6, fontSize: 11, fontWeight: 700, alignItems: "baseline" }}>
                        <span style={{ color: "var(--ink-muted)" }}>↳</span>
                        <span style={{ textTransform: "uppercase", fontSize: 10 }}>Area Net</span>
                        <span style={{ fontFamily: "var(--f-mono)", textAlign: "right", color: "var(--cobalt)" }}>{num(b.wall_sf)} {aU}</span>
                      </div>
                    </div>

                    {/* 3. Ceiling Area */}
                    <div style={{ background: "rgba(0,0,0,0.02)", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--ink-faint)", display: "grid", gap: 4 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--cobalt)", display: "flex", justifyContent: "space-between" }}>
                        <span>* Ceiling Area</span>
                        <span style={{ fontFamily: "var(--f-mono)" }}>{num(b.ceiling_net_sf)} {aU}</span>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "14px 100px 1fr", gap: 6, fontSize: 11, alignItems: "baseline" }}>
                        <span style={{ color: "var(--ink-muted)" }}>↳</span>
                        <span style={{ color: "var(--ink-muted)", textTransform: "uppercase", fontSize: 10 }}>Gross Area</span>
                        <span style={{ fontFamily: "var(--f-mono)", textAlign: "right" }}>{num(b.ceiling_gross_sf)} {aU}</span>
                      </div>
                      {b.ceiling_openings_sf > 0 && (
                        <div style={{ display: "grid", gridTemplateColumns: "14px 100px 1fr", gap: 6, fontSize: 11, alignItems: "baseline", color: "var(--c-danger, #b03a26)" }}>
                          <span>↳</span>
                          <span style={{ textTransform: "uppercase", fontSize: 10 }}>Opening</span>
                          <span style={{ fontFamily: "var(--f-mono)", textAlign: "right" }}>−{num(b.ceiling_openings_sf)} {aU}</span>
                        </div>
                      )}
                      <div style={{ display: "grid", gridTemplateColumns: "14px 100px 1fr", gap: 6, fontSize: 11, fontWeight: 700, alignItems: "baseline" }}>
                        <span style={{ color: "var(--ink-muted)" }}>↳</span>
                        <span style={{ textTransform: "uppercase", fontSize: 10 }}>Area Net</span>
                        <span style={{ fontFamily: "var(--f-mono)", textAlign: "right", color: "var(--cobalt)" }}>{num(b.ceiling_net_sf)} {aU}</span>
                      </div>
                    </div>

                    {/* 4. Skirting (Net LM) */}
                    <div style={{ background: "rgba(0,0,0,0.02)", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--ink-faint)", display: "grid", gap: 4 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--cobalt)", display: "flex", justifyContent: "space-between" }}>
                        <span>* Skirting</span>
                        <span style={{ fontFamily: "var(--f-mono)" }}>{num(b.skirting_net_lf)} {lU}</span>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "14px 100px 1fr", gap: 6, fontSize: 11, alignItems: "baseline" }}>
                        <span style={{ color: "var(--ink-muted)" }}>↳</span>
                        <span style={{ color: "var(--ink-muted)", textTransform: "uppercase", fontSize: 10 }}>Perimeter</span>
                        <span style={{ fontFamily: "var(--f-mono)", textAlign: "right" }}>{num(b.skirting_gross_lf)} {lU}</span>
                      </div>
                      {b.skirting_door_deduct_lf > 0 && (
                        <div style={{ display: "grid", gridTemplateColumns: "14px 100px 1fr", gap: 6, fontSize: 11, alignItems: "baseline", color: "var(--c-danger, #b03a26)" }}>
                          <span>↳</span>
                          <span style={{ textTransform: "uppercase", fontSize: 10 }}>Opening</span>
                          <span style={{ fontFamily: "var(--f-mono)", textAlign: "right" }}>−{num(b.skirting_door_deduct_lf)} {lU}</span>
                        </div>
                      )}
                      <div style={{ display: "grid", gridTemplateColumns: "14px 100px 1fr", gap: 6, fontSize: 11, fontWeight: 700, alignItems: "baseline" }}>
                        <span style={{ color: "var(--ink-muted)" }}>↳</span>
                        <span style={{ textTransform: "uppercase", fontSize: 10 }}>Net LM</span>
                        <span style={{ fontFamily: "var(--f-mono)", textAlign: "right", color: "var(--cobalt)" }}>{num(b.skirting_net_lf)} {lU}</span>
                      </div>
                    </div>

                    {/* 5. Door & Window Marks */}
                    {((b.doors && b.doors.length > 0) || (b.windows && b.windows.length > 0)) && (
                      <div style={{ display: "grid", gap: 4 }}>
                        {b.doors?.map((d, i) => (
                          <div key={`bd-${i}`} style={{ fontSize: 11, display: "flex", justifyContent: "space-between", background: "rgba(0,0,0,0.015)", padding: "4px 8px", borderRadius: 4 }}>
                            <span>* Door <b>{d.tag}</b> <span style={{ fontSize: 10, color: "var(--ink-muted)" }}>({num(d.width_ft || 3)}×{num(d.height_ft || 7)}')</span></span>
                            <span style={{ fontFamily: "var(--f-mono)", color: "var(--c-danger, #b03a26)", fontWeight: 600 }}>−{num(d.sf)} {aU}</span>
                          </div>
                        ))}
                        {b.windows?.map((w, i) => (
                          <div key={`bw-${i}`} style={{ fontSize: 11, display: "flex", justifyContent: "space-between", background: "rgba(0,0,0,0.015)", padding: "4px 8px", borderRadius: 4 }}>
                            <span>* Window <b>{w.tag}</b> <span style={{ fontSize: 10, color: "var(--ink-muted)" }}>({num(w.width_ft || 4)}×{num(w.height_ft || 4)}')</span></span>
                            <span style={{ fontFamily: "var(--f-mono)", color: "var(--c-danger, #b03a26)", fontWeight: 600 }}>−{num(w.sf)} {aU}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 6. Editable Costing Box for Room OR Cost Rollup for Floor/Project */}
                    {isRoom ? (
                      <div style={{ borderTop: "1px solid var(--ink-faint)", paddingTop: 8, display: "grid", gap: 6 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: 8, alignItems: "center" }}>
                          <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--ink-muted)" }}>Takeoff Qty:</span>
                          <div style={{ display: "flex", gap: 6 }}>
                            <input
                              style={{ ...inp, width: 80, textAlign: "right" }}
                              type="number"
                              step="any"
                              value={meta.qty_override !== "" && meta.qty_override != null ? meta.qty_override : ""}
                              placeholder={num(pq.qty)}
                              onChange={(e) => upsertLine(key, { qty_override: e.target.value, sheet_id: r.sheet_id, condition_id: r.condition_id, shape_id: r.shape_id })}
                            />
                            <input
                              style={{ ...inp, width: 50 }}
                              value={meta.unit || ""}
                              placeholder={pq.unit}
                              onChange={(e) => upsertLine(key, { unit: e.target.value, sheet_id: r.sheet_id, condition_id: r.condition_id, shape_id: r.shape_id })}
                            />
                          </div>
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: 8, alignItems: "center" }}>
                          <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--ink-muted)" }}>Unit Rate:</span>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <input
                              style={{ ...inp, width: 100, textAlign: "right", fontFamily: "var(--f-mono)", fontWeight: 600 }}
                              type="number"
                              step="any"
                              placeholder="0.00"
                              value={meta.rate ?? ""}
                              onChange={(e) => upsertLine(key, { rate: e.target.value, sheet_id: r.sheet_id, condition_id: r.condition_id, shape_id: r.shape_id })}
                            />
                            <span style={{ fontSize: 11, color: "var(--ink-muted)", fontWeight: 600 }}>{pricingCtx?.currency || "AED"}</span>
                          </div>
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: 8, alignItems: "baseline", background: "rgba(31, 63, 199, 0.06)", padding: "6px 8px", borderRadius: 4 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--cobalt)" }}>Total Cost:</span>
                          <span style={{ fontFamily: "var(--f-mono)", fontSize: 14, fontWeight: 800, color: "var(--cobalt)", textAlign: "right" }}>
                            {amount > 0 ? `${money(amount)} ${pricingCtx?.currency || "AED"}` : "—"}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div style={{ borderTop: "1px solid var(--ink-faint)", paddingTop: 8, display: "grid", gap: 6 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 8, alignItems: "baseline", background: "rgba(31, 63, 199, 0.06)", padding: "8px 10px", borderRadius: 4 }}>
                          <span style={{ fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", color: "var(--cobalt)" }}>
                            {b.scopeType === "floor" ? "Floor Subtotal:" : "Project Grand Total:"}
                          </span>
                          <span style={{ fontFamily: "var(--f-mono)", fontSize: 15, fontWeight: 800, color: "var(--cobalt)", textAlign: "right" }}>
                            {amount > 0 ? `${money(amount)} ${pricingCtx?.currency || "AED"}` : "—"}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })() : null}
          </div>
        )}

        {/* MODE 2: PER FLOOR SHEET BREAKDOWN TABLE */}
        {viewMode === "floor" && (
          !bySheet.length && !manualLines.length ? (
          <div style={{ padding: "20px 14px", color: "var(--ink-muted)", fontSize: 13, lineHeight: 1.5 }}>
              No masked takeoff yet. Trace rooms (One-Click) or walls (Wall Trace) — quantities and rates will calculate automatically.
          </div>
        ) : (
          <>
              {/* Floor Filter Bar */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--paper-cream)", borderBottom: "1px solid var(--ink-faint)", flexShrink: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--ink-muted)" }}>Show Floor:</span>
                <select
                  value={floorFilter}
                  onChange={(e) => setFloorFilter(e.target.value)}
                  style={{
                    padding: "3px 8px", fontSize: 11.5, fontWeight: 600,
                    border: "1px solid var(--ink-faint)", borderRadius: 4, background: "var(--paper-bright)", color: "var(--ink)",
                  }}
                >
                  <option value="all">All Floors (Complete Project)</option>
            {bySheet.map((g) => {
                    const flr = sheetLevels?.[g.sheet_id] || "";
                    const sht = typeof sheetLabel === "function" ? sheetLabel(g.sheet_id) : (sheetLabel || g.sheet_id || "");
                    return (
                      <option key={g.sheet_id} value={g.sheet_id}>
                        {flr ? `${flr} · ` : ""}{sht}
                      </option>
                    );
                  })}
                </select>
                {floorFilter !== "all" && (
                  <button
                    type="button"
                    onClick={() => setFloorFilter("all")}
                    style={{ padding: "2px 6px", fontSize: 10.5, border: "1px solid var(--ink-faint)", background: "transparent", cursor: "pointer", borderRadius: 3 }}
                  >
                    Show all floors
                  </button>
                )}
              </div>

              {bySheet.filter((g) => floorFilter === "all" || g.sheet_id === floorFilter).map((g) => {
                const floor = sheetLevels?.[g.sheet_id] || "";
                const sheet = typeof sheetLabel === "function" ? sheetLabel(g.sheet_id) : (sheetLabel || g.sheet_id || "");
              const floorTotal = sheetFloorTotal(g.shapeRows);
              const rooms = roomSubtotals(g.shapeRows.map((r) => {
                const key = rowKey(r.shape_id);
                const meta = lineForKey(boqLines, key);
                return { ...r, room_detected: meta?.room || r.room_detected };
              }));
              return (
                <section key={g.sheet_id} style={{ borderBottom: "1px solid var(--ink-faint)" }}>
                  <div style={{ padding: "8px 12px", background: "var(--paper-shadow)", display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 700, fontSize: 12.5 }}>{floor ? `${floor} · ` : ""}{sheet}</span>
                    <span style={{ fontSize: 10.5, fontFamily: "var(--f-mono)", color: "var(--ink-muted)" }}>
                        {num(floorTotal)} {areaUnit(units)} masked · {g.shapeRows.length} item{g.shapeRows.length === 1 ? "" : "s"} · {rooms.length} room{rooms.length === 1 ? "" : "s"}
                    </span>
                    {!focusShapeId && (
                      <button type="button" onClick={() => addManualRow(g.sheet_id)} title="Add a manual BOQ line for this sheet"
                        style={{ marginLeft: "auto", padding: "3px 8px", border: "1px dashed var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 11 }}>
                        + manual line
                      </button>
                    )}
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
                      <thead>
                        <tr>
                          <th style={th}>Room</th>
                          <th style={th}>Finish</th>
                          <th style={{ ...th, textAlign: "right" }}>Floor</th>
                          <th style={{ ...th, textAlign: "right" }}>Wall</th>
                          <th style={{ ...th, textAlign: "right" }}>LF</th>
                          <th style={{ ...th, textAlign: "right" }}>EA</th>
                          <th style={th}>Qty</th>
                          <th style={th}>Unit</th>
                          <th style={th}>Rate</th>
                          <th style={{ ...th, textAlign: "right" }}>Amt</th>
                          <th style={th}>Notes</th>
                          {onShapeDelete && <th style={{ ...th, width: 32, textAlign: "center", padding: "6px 4px" }} aria-label="Delete" />}
                        </tr>
                      </thead>
                      <tbody>
                        {g.shapeRows.map((r) => renderDataRow(g, r))}
                        {!focusShapeId && manualLines.filter((m) => m.sheet_id === g.sheet_id).map((m) => {
                          const qty = Number(m.qty_override) || 0;
                          const rate = Number(m.rate) || 0;
                          return (
                            <tr key={m.id}>
                              <td style={td}><input style={inp} value={m.room || ""} onChange={(e) => upsertLine(m.id, { room: e.target.value })} /></td>
                              <td style={{ ...td, color: "var(--ink-muted)", fontSize: 11 }}>Manual</td>
                              <td style={td} colSpan={4}><input style={inp} value={m.description || ""} placeholder="Description"
                                onChange={(e) => upsertLine(m.id, { description: e.target.value })} /></td>
                              <td style={td}><input style={{ ...inp, width: 64, textAlign: "right" }} type="number" step="any" value={m.qty_override ?? ""} onChange={(e) => upsertLine(m.id, { qty_override: e.target.value })} /></td>
                              <td style={td}><input style={{ ...inp, width: 48 }} value={m.unit || ""} onChange={(e) => upsertLine(m.id, { unit: e.target.value })} /></td>
                              <td style={td}><input style={{ ...inp, width: 72, textAlign: "right" }} type="number" step="any" value={m.rate ?? ""} onChange={(e) => upsertLine(m.id, { rate: e.target.value })} /></td>
                              <td style={{ ...td, fontFamily: "var(--f-mono)", textAlign: "right" }}>{round2(qty * rate) ? num(round2(qty * rate)) : dash}</td>
                              <td style={td}>
                                <div style={{ display: "flex", gap: 4 }}>
                                  <input style={{ ...inp, flex: 1 }} value={m.notes || ""} onChange={(e) => upsertLine(m.id, { notes: e.target.value })} />
                                  <button type="button" onClick={() => removeLine(m.id)} title="Remove manual line" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--c-danger)", fontSize: 14 }}>×</button>
                                </div>
                              </td>
                              {onShapeDelete && <td style={td} />}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  </section>
                );
              })}
            </>
          )
        )}

        {/* MODE 3: WHOLE PROJECT ROLLUP */}
        {viewMode === "project" && (
          <div style={{ padding: "12px", display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}>
              <div style={{ background: "var(--paper-cream)", padding: "10px", borderRadius: 6, border: "1px solid var(--ink-faint)" }}>
                <div style={{ fontSize: 10, color: "var(--ink-muted)", textTransform: "uppercase", fontWeight: 700 }}>Total Floor</div>
                <div style={{ fontFamily: "var(--f-mono)", fontSize: 15, fontWeight: 700, color: "var(--ink)", marginTop: 2 }}>{num(grand.floor)} {areaUnit(units)}</div>
                      </div>
              <div style={{ background: "var(--paper-cream)", padding: "10px", borderRadius: 6, border: "1px solid var(--ink-faint)" }}>
                <div style={{ fontSize: 10, color: "var(--ink-muted)", textTransform: "uppercase", fontWeight: 700 }}>Total Wall</div>
                <div style={{ fontFamily: "var(--f-mono)", fontSize: 15, fontWeight: 700, color: "var(--ink)", marginTop: 2 }}>{num(grand.wall)} {areaUnit(units)}</div>
                          </div>
              <div style={{ background: "var(--paper-cream)", padding: "10px", borderRadius: 6, border: "1px solid var(--ink-faint)" }}>
                <div style={{ fontSize: 10, color: "var(--ink-muted)", textTransform: "uppercase", fontWeight: 700 }}>Total Skirting</div>
                <div style={{ fontFamily: "var(--f-mono)", fontSize: 15, fontWeight: 700, color: "var(--ink)", marginTop: 2 }}>{num(grand.lf)} {lenUnit(units)}</div>
              </div>
              <div style={{ background: "rgba(31, 63, 199, 0.08)", padding: "10px", borderRadius: 6, border: "1px solid var(--cobalt)" }}>
                <div style={{ fontSize: 10, color: "var(--cobalt)", textTransform: "uppercase", fontWeight: 700 }}>Total Estimated Cost</div>
                <div style={{ fontFamily: "var(--f-mono)", fontSize: 16, fontWeight: 800, color: "var(--cobalt)", marginTop: 2 }}>{money(grand.cost)}</div>
              </div>
            </div>

            {/* Condition Rollup Breakdown */}
            <div style={{ border: "1px solid var(--ink-faint)", borderRadius: 6, overflow: "hidden" }}>
              <div style={{ padding: "8px 12px", background: "var(--paper-shadow)", fontWeight: 700, fontSize: 12 }}>Material &amp; Finish Summary</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "var(--paper-cream)", borderBottom: "1px solid var(--ink-faint)" }}>
                    <th style={{ textAlign: "left", padding: "6px 10px", fontSize: 10.5, color: "var(--ink-muted)" }}>Finish Code</th>
                    <th style={{ textAlign: "right", padding: "6px 10px", fontSize: 10.5, color: "var(--ink-muted)" }}>Items</th>
                    <th style={{ textAlign: "right", padding: "6px 10px", fontSize: 10.5, color: "var(--ink-muted)" }}>Net Area</th>
                    <th style={{ textAlign: "right", padding: "6px 10px", fontSize: 10.5, color: "var(--ink-muted)" }}>Order (Waste Adj.)</th>
                  </tr>
                </thead>
                <tbody>
                  {condRows.map((cr) => (
                    <tr key={cr.id} style={{ borderBottom: "1px solid var(--ink-faint)" }}>
                      <td style={{ padding: "6px 10px", fontWeight: 600 }}>
                        <span style={{ fontFamily: "var(--f-mono)", color: "var(--cobalt)" }}>{cr.finish_tag || cr.title || "Condition"}</span>
                      </td>
                      <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "var(--f-mono)" }}>{cr.shape_count}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "var(--f-mono)" }}>{num(cr.total_sf_net || 0)} {areaUnit(units)}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "var(--f-mono)", fontWeight: 700 }}>
                        {num(cr.total_sf_order || cr.total_sf_net || 0)} {areaUnit(units)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
                      </div>
                    </div>
        )}
      </div>

      {condRows.length > 0 && !focusShapeId && (
        <div style={{ borderTop: "1px solid var(--ink-faint)", padding: "8px 12px", background: "var(--paper-cream)", fontSize: 11, color: "var(--ink-muted)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Project Total (waste adj.): <b style={{ color: "var(--ink)" }}>{num(condRows.reduce((n, r) => n + (r.total_sf_net || 0), 0))} {areaUnit(units)}</b></span>
          {grand.cost > 0 && <span>Total Cost: <b style={{ color: "var(--cobalt)", fontFamily: "var(--f-mono)" }}>{money(grand.cost)} {pricingCtx?.currency || "AED"}</b></span>}
        </div>
      )}
    </div>
    {(pdfPreview || pdfBusy) && typeof document !== "undefined" && createPortal(
      <div style={{ position: "fixed", inset: 0, zIndex: 100000, display: "flex", flexDirection: "column", background: "var(--paper-cream)" }}>
        {pdfPreview ? (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 18px", borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-bright)", flexShrink: 0, width: "100%", boxSizing: "border-box" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <button type="button" className="btn-ghost" onClick={closePdfPreview}>Back to BOQ</button>
                <span style={{ fontSize: 12, color: "var(--ink-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pdfPreview.filename}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0, marginLeft: "auto" }}>
                <button type="button" className="btn-primary" onClick={downloadPdfPreview}><Icon name="document" size={13} /> Download PDF</button>
                <button type="button" className="btn-ghost" onClick={printPdfPreview}>Print</button>
              </div>
            </div>
            <iframe
              ref={pdfPreviewRef}
              src={pdfPreview.url}
              title="BOQ PDF preview"
              style={{ flex: 1, width: "100%", border: "none", minHeight: 0, background: "#525659" }}
            />
          </>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-muted)", fontSize: 13 }}>
            Building PDF preview…
          </div>
        )}
      </div>,
      document.body,
    )}
  </>
  );
}
