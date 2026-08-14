// BoqPanel — Bill of Quantities sidebar: per-mask takeoff rows with auto-detected
// room names, finish codes, and measured Floor / Wall / LF / EA / Qty quantities.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../brand/icons.jsx";
import ToolMenu from "./ToolMenu.jsx";
import { conditionTotals, round2 } from "../lib/totals.js";
import { areaUnit } from "../lib/units";
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
    let floor = 0, wall = 0, lf = 0, ea = 0;
    for (const r of visibleRows) {
      floor += r.floor_sf || 0;
      wall += r.wall_sf || 0;
      lf += r.lf || 0;
      ea += r.ea || 0;
    }
    return { floor: round2(floor), wall: round2(wall), lf: round2(lf), ea, shapes_n: visibleRows.length, sheets: bySheet.length };
  }, [visibleRows, bySheet.length]);

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
        </td>
        <td style={{ ...td, fontWeight: 600 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title={displayDesc || undefined}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: r.color, flexShrink: 0 }} />
            {r.finish_tag || dash}
          </span>
          {displayDesc && (
            <div style={{ fontSize: 10.5, color: "var(--ink-muted)", fontWeight: 400, marginTop: 3, lineHeight: 1.35, maxWidth: 140 }}
              title={displayDesc}>
              {displayDesc.length > 72 ? `${displayDesc.slice(0, 72)}…` : displayDesc}
            </div>
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

  return (
    <>
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--paper-bright)", overflow: "hidden", minHeight: 0 }}>
      <div data-float-drag style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", background: "var(--cobalt)", color: "var(--accent-contrast)", cursor: "grab", userSelect: "none", flexShrink: 0 }}>
        <Icon name="document" size={16} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: "0.02em" }}>Bill of Quantities</div>
          <div style={{ fontSize: 10.5, opacity: 0.85, marginTop: 2 }}>Rooms &amp; walls · auto-detected · linked to estimate</div>
        </div>
        <button type="button" onClick={onClose} title="Close BOQ panel" style={{ border: "none", background: "transparent", color: "inherit", fontSize: 18, cursor: "pointer", padding: "0 4px" }}>×</button>
      </div>

      {focusShapeId && (
        <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-cream)", display: "flex", alignItems: "center", gap: 8, fontSize: 11.5 }}>
          <span style={{ color: "var(--ink-muted)" }}>Showing <b style={{ color: "var(--ink)" }}>1 mask</b> only</span>
          <button type="button" onClick={onClearFocus} style={{ marginLeft: "auto", padding: "3px 8px", border: "1px solid var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
            Show all
          </button>
        </div>
      )}

      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--ink-faint)", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>
          {grand.sheets} sheet{grand.sheets === 1 ? "" : "s"} · {grand.shapes_n} mask{grand.shapes_n === 1 ? "" : "s"} ·{" "}
          <b style={{ color: "var(--ink)" }}>{num(grand.floor)} {areaUnit(units)}</b> floor
          {grand.wall > 0 && (
            <> · <b style={{ color: "var(--ink)" }}>{num(grand.wall)} {areaUnit(units)}</b> wall</>
          )}
        </span>
        <div style={{ flex: 1 }} />
        <ToolMenu
          title="Export bill of quantities"
          disabled={!bySheet.length && !manualLines.length}
          face="Export"
          faceStyle={{
            padding: "5px 10px",
            border: "none",
            background: "var(--ink)",
            color: "var(--paper-bright)",
            fontSize: 11.5,
            fontWeight: 700,
            borderRadius: 20,
          }}
          items={[
            { id: "pdf", icon: "document", label: "PDF", title: "Preview BOQ as ADICC-branded PDF", onSelect: openBoqPdfPreview },
            { id: "csv", icon: "document", label: "CSV", title: "Download BOQ spreadsheet", onSelect: exportCsv },
          ]}
        />
      </div>

      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {!bySheet.length && !manualLines.length ? (
          <div style={{ padding: "20px 14px", color: "var(--ink-muted)", fontSize: 13, lineHeight: 1.5 }}>
            No masked takeoff yet. Trace rooms (One-Click) or walls (Wall Trace) — room names, finish codes, quantities, and rates fill in from schedules and the Rates catalog when available.
          </div>
        ) : (
          <>
            {bySheet.map((g) => {
              const floor = sheetLevels[g.sheet_id];
              const sheet = sheetLabel(g.sheet_id);
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
                      {num(floorTotal)} {areaUnit(units)} masked · {g.shapeRows.length} mask{g.shapeRows.length === 1 ? "" : "s"} · {rooms.length} room{rooms.length === 1 ? "" : "s"}
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
                  {rooms.length > 0 && !focusShapeId && (
                    <div style={{ padding: "8px 12px 10px", background: "var(--paper-cream)", borderTop: "1px solid var(--ink-faint)" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-muted)", marginBottom: 6 }}>
                        Room summary · {num(floorTotal)} {areaUnit(units)} total masked
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {rooms.map((rm) => (
                          <div key={rm.room} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 11.5 }}>
                            <span style={{ fontWeight: 600, minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{rm.room}</span>
                            <span style={{ fontFamily: "var(--f-mono)", color: "var(--ink-muted)", whiteSpace: "nowrap" }}>
                              {rm.floor_sf ? `${num(rm.floor_sf)} ${areaUnit(units)}` : ""}
                              {rm.wall_sf ? `${rm.floor_sf ? " · " : ""}${num(rm.wall_sf)} ${areaUnit(units)} wall` : ""}
                              {rm.masks > 1 ? ` · ${rm.masks} masks` : ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </section>
              );
            })}
            {!focusShapeId && manualLines.filter((m) => !m.sheet_id).length > 0 && (
              <section style={{ borderBottom: "1px solid var(--ink-faint)" }}>
                <div style={{ padding: "8px 12px", background: "var(--paper-shadow)", fontWeight: 700, fontSize: 12.5 }}>Project · manual lines</div>
                <div style={{ padding: "8px 12px" }}>
                  <button type="button" onClick={() => addManualRow("")} style={{ padding: "4px 10px", border: "1px dashed var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 11 }}>+ manual line</button>
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {condRows.length > 0 && !focusShapeId && (
        <div style={{ borderTop: "1px solid var(--ink-faint)", padding: "8px 12px", background: "var(--paper-cream)", fontSize: 11, color: "var(--ink-muted)" }}>
          Project total (waste adj.): <b style={{ color: "var(--ink)" }}>{num(condRows.reduce((n, r) => n + (r.total_sf_net || 0), 0))} {areaUnit(units)}</b>
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
