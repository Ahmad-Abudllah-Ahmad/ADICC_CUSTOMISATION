// Shared BOQ row detection — used by BoqPanel and canvas hover cards.
import { round2 } from "./totals.js";
import { areaUnit, lenUnit } from "./units";
import { pointInPoly } from "./geometry.js";
import { shapeLabelValue } from "./shapeLabels.js";
import { resolveSymbolFields, symbolNoteKey } from "./planSymbols";
import { lookupScheduleKb } from "./symbolScheduleKb";

export function rowKey(shapeId) {
  return `shape::${shapeId}`;
}

function normRoom(s) {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

/** 0–100: how closely two room names match (strict — avoids LOUNGE matching every lounge). */
function roomMatchScore(a, b) {
  const na = normRoom(a), nb = normRoom(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.includes(nb) || nb.includes(na)) return 85;
  const wa = na.split(" ").filter((w) => w.length > 2);
  const wb = nb.split(" ").filter((w) => w.length > 2);
  if (!wa.length || !wb.length) return 0;
  const common = wa.filter((w) => wb.includes(w));
  if (common.length >= 2) return 75;
  if (common.length === 1 && wa.length === 1 && wb.length === 1) return 65;
  return 0;
}

function kbEntriesForRoomStrict(kb, roomName, minScore = 65) {
  if (!kb || !roomName?.trim()) return [];
  const seen = new Set();
  const out = [];
  const list = kb instanceof Map ? [...kb.values()] : Object.values(kb || {});
  for (const e of list) {
    if (!e?.tag || !e.room_name) continue;
    if (roomMatchScore(e.room_name, roomName) < minScore) continue;
    const k = e.tag;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

function tagsInsideMask(shape, planSymbols, panelImgs) {
  const dims = panelImgs[shape.sheet_id];
  const tags = new Set();
  for (const sym of (planSymbols || []).filter((s) => s.sheet_id === shape.sheet_id)) {
    if (pointInShapePx(sym.x, sym.y, shape, dims)) tags.add(sym.tag.toUpperCase());
  }
  return tags;
}

function refFromKb(entry, sourceLabel = "Schedule") {
  if (!entry) return null;
  return {
    tag: entry.tag,
    kind: entry.kind || "finish",
    description: entry.description || "",
    manufacturer: entry.manufacturer || "",
    color: entry.color || "",
    size: entry.size || "",
    room_name: entry.room_name || "",
    source: entry.source_title || entry.source_sheet || sourceLabel,
    source_sheet: entry.source_sheet || "",
    relevance: 0,
  };
}

function refRichness(r) {
  return [r.description, r.manufacturer, r.color, r.size].filter((v) => v && String(v).trim()).length;
}

function dedupeRefs(refs) {
  const byTag = new Map();
  for (const r of refs) {
    if (!r?.tag) continue;
    const prev = byTag.get(r.tag);
    if (!prev || (r.relevance || 0) > (prev.relevance || 0) || refRichness(r) > refRichness(prev)) {
      byTag.set(r.tag, r);
    }
  }
  return [...byTag.values()];
}

function rankRefs(refs, finishTag, room) {
  return refs
    .map((r) => {
      let relevance = r.relevance || 0;
      if (r.tag?.toUpperCase() === finishTag.toUpperCase()) relevance += 50;
      if (r.room_name && room && roomMatchScore(r.room_name, room) >= 65) relevance += 25;
      if (r.description) relevance += 8;
      if (r.kind === "door" || r.kind === "window") relevance += 12;
      if (r.source?.includes("schedule") || r.source?.includes("Schedule")) relevance += 10;
      return { ...r, relevance };
    })
    .sort((a, b) => b.relevance - a.relevance || a.tag.localeCompare(b.tag));
}

/** Best finish-schedule row for this mask's finish code, preferring the matched room. */
function lookupMaskFinish(kb, finishTag, room) {
  if (!finishTag || !kb) return null;
  const tag = finishTag.toUpperCase();

  if (room) {
    for (const e of kbEntriesForRoomStrict(kb, room)) {
      if (e.tag?.toUpperCase() === tag) return e;
    }
  }

  const global = lookupScheduleKb(kb, tag);
  if (!global) return null;
  if (global.room_name && room && roomMatchScore(global.room_name, room) < 65) return null;
  return global;
}

/** Search plan marks + schedule PDFs — only data tied to this mask's room, finish, or in-mask marks. */
export function gatherShapeScheduleRefs(shape, condition, detectCtx, roomName = "") {
  const { planSymbols, symbolNotes, panelImgs, scheduleKb } = detectCtx;
  const refs = [];
  const finishTag = (condition?.finish_tag || "").trim().toUpperCase();
  const room = roomName || detectRoomName(shape, detectCtx);
  const inMaskTags = tagsInsideMask(shape, planSymbols, panelImgs);

  // 1. Primary finish spec — room-scoped finish schedule row for the assigned finish code
  const finishKb = lookupMaskFinish(scheduleKb, finishTag, room);
  const finishRef = refFromKb(finishKb, "Finish schedule");
  if (finishRef) {
    finishRef.relevance = 60;
    refs.push(finishRef);
  }

  // 2. In-mask plan marks with real schedule data (doors/windows, or other finish codes on plan)
  const dims = panelImgs[shape.sheet_id];
  for (const sym of (planSymbols || []).filter((s) => s.sheet_id === shape.sheet_id)) {
    if (!pointInShapePx(sym.x, sym.y, shape, dims)) continue;

    const symTag = (sym.tag || "").toUpperCase();
    if (sym.kind === "detail" || sym.kind === "type") continue;
    if (sym.kind === "finish" && symTag === finishTag && finishRef) continue;

    const noteKey = symbolNoteKey(sym.sheet_id, sym.tag, sym.x, sym.y);
    const fields = resolveSymbolFields(sym.schedule, symbolNotes[noteKey], sym.room_name);
    const kb = lookupScheduleKb(scheduleKb, sym.tag);
    const kbRef = refFromKb(kb, "Schedule");

    const description = fields.description || kbRef?.description || "";
    const manufacturer = fields.manufacturer || kbRef?.manufacturer || "";
    const size = fields.size || kbRef?.size || "";
    const color = fields.color || kbRef?.color || "";

    const isOpening = sym.kind === "door" || sym.kind === "window";
    const hasData = !!(description || manufacturer || size || color);
    if (!isOpening && !hasData) continue;
    if (sym.kind === "finish" && symTag !== finishTag && !hasData) continue;

    if (kbRef?.room_name && room && roomMatchScore(kbRef.room_name, room) < 65) continue;

    refs.push({
      tag: sym.tag,
      kind: sym.kind,
      description,
      manufacturer,
      color,
      size,
      room_name: fields.room_name || kbRef?.room_name || sym.room_name || "",
      source: kbRef?.source || sym.schedule?.source_title || "Plan mark",
      source_sheet: kbRef?.source_sheet || sym.schedule?.source_sheet || "",
      relevance: isOpening ? 35 : (symTag === finishTag ? 40 : 20),
    });
  }

  // 3. Other finish codes from schedule that are explicitly placed inside this mask
  for (const tag of inMaskTags) {
    if (tag === finishTag || refs.some((r) => r.tag?.toUpperCase() === tag)) continue;
    const kb = lookupScheduleKb(scheduleKb, tag);
    if (!kb || kb.kind !== "finish") continue;
    if (kb.room_name && room && roomMatchScore(kb.room_name, room) < 65) continue;
    const r = refFromKb(kb, "Finish schedule");
    if (r?.description) {
      r.relevance = 25;
      refs.push(r);
    }
  }

  // 4. Fallback — condition description only when no schedule data was found
  if (!refs.length && condition?.description?.trim()) {
    refs.push({
      tag: finishTag || "Spec",
      kind: "condition",
      description: condition.description.trim(),
      manufacturer: "",
      color: "",
      size: "",
      room_name: room,
      source: "Takeoff condition",
      source_sheet: "",
      relevance: 10,
    });
  }

  const ranked = rankRefs(dedupeRefs(refs.filter((r) =>
    r.description || r.manufacturer || r.color || r.size
    || r.kind === "door" || r.kind === "window"
  )), finishTag, room);

  return ranked.slice(0, 4);
}

function shapePolyPx(shape, dims) {
  if (!dims?.w || !dims?.h) return [];
  return (shape.verts_norm || []).map(([nx, ny]) => [nx * dims.w, ny * dims.h]);
}

function pointInShapePx(x, y, shape, dims) {
  const poly = shapePolyPx(shape, dims);
  if (poly.length < 3 || !pointInPoly(x, y, poly)) return false;
  for (const hole of shape.holes_norm || []) {
    const hp = hole.map(([nx, ny]) => [nx * dims.w, ny * dims.h]);
    if (hp.length >= 3 && pointInPoly(x, y, hp)) return false;
  }
  return true;
}

function polyCentroid(poly) {
  if (!poly.length) return [0, 0];
  let sx = 0, sy = 0;
  for (const [x, y] of poly) { sx += x; sy += y; }
  return [sx / poly.length, sy / poly.length];
}

function pointInHolePx(x, y, holeNorm, dims) {
  if (!dims?.w || !dims?.h) return false;
  const hp = holeNorm.map(([nx, ny]) => [nx * dims.w, ny * dims.h]);
  return hp.length >= 3 && pointInPoly(x, y, hp);
}

/** Room label / symbol lookup inside a single hole polygon (wall poché void). */
function detectRoomInHole(holeNorm, sheetId, dims, { planSymbols, roomLabelsBySheet, symbolNotes }) {
  if (!dims?.w || !dims?.h) return "";
  const hp = holeNorm.map(([nx, ny]) => [nx * dims.w, ny * dims.h]);
  if (hp.length < 3) return "";
  const [cx, cy] = polyCentroid(hp);
  const roomLabels = roomLabelsBySheet?.[sheetId] || [];

  let bestLabel = null;
  for (const lbl of roomLabels) {
    if (!pointInPoly(lbl.x, lbl.y, hp)) continue;
    const d = Math.hypot(lbl.x - cx, lbl.y - cy);
    const score = d - lbl.h * 0.15;
    if (!bestLabel || score < bestLabel.score) bestLabel = { text: lbl.text, score };
  }
  if (bestLabel) return bestLabel.text;

  let bestSym = null;
  for (const sym of (planSymbols || []).filter((s) => s.sheet_id === sheetId)) {
    if (!pointInPoly(sym.x, sym.y, hp)) continue;
    const noteKey = symbolNoteKey(sym.sheet_id, sym.tag, sym.x, sym.y);
    const fields = resolveSymbolFields(sym.schedule, symbolNotes?.[noteKey], sym.room_name);
    const room = fields.room_name;
    if (!room) continue;
    const d = Math.hypot(sym.x - cx, sym.y - cy);
    if (!bestSym || d < bestSym.d) bestSym = { room, d };
  }
  return bestSym?.room || "";
}

/** If a wall hole centroid sits inside a traced floor mask, borrow that room name. */
function detectRoomFromFloorMasks(shape, allShapes, dims, ctx) {
  if (!dims?.w || !dims?.h || !allShapes?.length || !shape.holes_norm?.length) return "";
  for (const hole of shape.holes_norm) {
    const hp = hole.map(([nx, ny]) => [nx * dims.w, ny * dims.h]);
    if (hp.length < 3) continue;
    const [cx, cy] = polyCentroid(hp);
    for (const other of allShapes) {
      if (other.id === shape.id || other.sheet_id !== shape.sheet_id || other.measure_role !== "floor_area") continue;
      const op = shapePolyPx(other, dims);
      if (op.length < 3 || !pointInPoly(cx, cy, op)) continue;
      const r = detectRoomName(other, ctx, allShapes);
      if (r) return r;
    }
  }
  return "";
}

export function detectRoomName(shape, ctx, allShapes = null) {
  const assigned = shapeLabelValue(shape);
  if (assigned) return assigned;

  // Panel bitmap may not be ready yet (shapes restored before sheets paint) —
  // skip geometry lookup rather than crash BoqPanel on dims.w.
  const dims = ctx?.panelImgs?.[shape.sheet_id];
  if (!dims?.w || !dims?.h) return "";
  const poly = shapePolyPx(shape, dims);

  // Wall network: room names live inside holes (or on matching floor masks).
  if (shape.measure_role === "wall_area" && shape.holes_norm?.length) {
    for (const hole of shape.holes_norm) {
      const fromHole = detectRoomInHole(hole, shape.sheet_id, dims, ctx);
      if (fromHole) return fromHole;
    }
    const fromFloor = detectRoomFromFloorMasks(shape, allShapes, dims, ctx);
    if (fromFloor) return fromFloor;
  }

  if (poly.length < 3) return "";

  const [cx, cy] = polyCentroid(poly);
  const { planSymbols, roomLabelsBySheet, symbolNotes } = ctx;
  const roomLabels = roomLabelsBySheet[shape.sheet_id] || [];

  let bestLabel = null;
  for (const lbl of roomLabels) {
    if (!pointInShapePx(lbl.x, lbl.y, shape, dims)) continue;
    const d = Math.hypot(lbl.x - cx, lbl.y - cy);
    const score = d - lbl.h * 0.15;
    if (!bestLabel || score < bestLabel.score) bestLabel = { text: lbl.text, score };
  }
  if (bestLabel) return bestLabel.text;

  const syms = (planSymbols || []).filter((s) => s.sheet_id === shape.sheet_id);
  let bestSym = null;
  for (const sym of syms) {
    if (!pointInShapePx(sym.x, sym.y, shape, dims)) continue;
    const noteKey = symbolNoteKey(sym.sheet_id, sym.tag, sym.x, sym.y);
    const fields = resolveSymbolFields(sym.schedule, symbolNotes[noteKey], sym.room_name);
    const room = fields.room_name;
    if (!room) continue;
    const d = Math.hypot(sym.x - cx, sym.y - cy);
    if (!bestSym || d < bestSym.d) bestSym = { room, d };
  }
  if (bestSym) return bestSym.room;

  return "";
}

export function shapeQuantities(shape) {
  const cp = shape.computed || {};
  const role = shape.measure_role;
  let floor_sf = 0, wall_sf = 0, lf = 0, ea = 0;
  switch (role) {
    case "deduct": floor_sf = -(cp.area_sf || 0); break;
    case "floor_area": floor_sf = cp.area_sf || 0; lf = cp.perimeter_lf || 0; break;
    case "surface_area": wall_sf = cp.area_sf || 0; lf = cp.perimeter_lf || 0; break;
    case "wall_area":
      wall_sf = cp.wall_face_sf || cp.area_sf || 0;
      lf = cp.perimeter_lf || 0;
      break;
    case "linear": lf = cp.perimeter_lf || 0; break;
    case "count": ea = cp.count || 1; break;
    default: break;
  }
  return { floor_sf: round2(floor_sf), wall_sf: round2(wall_sf), lf: round2(lf), ea, role };
}

export function primaryQty(row, units) {
  if (row.floor_sf) return { qty: row.floor_sf, unit: areaUnit(units), kind: "floor" };
  if (row.wall_sf) return { qty: row.wall_sf, unit: areaUnit(units), kind: "wall" };
  if (row.lf) return { qty: row.lf, unit: lenUnit(units), kind: "lf" };
  if (row.ea) return { qty: row.ea, unit: "EA", kind: "ea" };
  return { qty: 0, unit: areaUnit(units), kind: "floor" };
}

export function buildShapeRows(shapes, conditions, detectCtx) {
  const byId = new Map(conditions.map((c) => [c.id, c]));
  return shapes
    .filter((s) => Array.isArray(s.verts_norm) && s.verts_norm.length >= (s.measure_role === "count" ? 1 : 3))
    .map((s) => {
      const cond = byId.get(s.condition_id);
      const qty = shapeQuantities(s);
      const room_detected = detectRoomName(s, detectCtx, shapes);
      return {
        shape_id: s.id,
        sheet_id: s.sheet_id,
        condition_id: s.condition_id,
        finish_tag: cond?.finish_tag || "",
        color: cond?.color,
        room_detected,
        schedule_refs: gatherShapeScheduleRefs(s, cond, detectCtx, room_detected),
        ...qty,
      };
    });
}

/** Resolve display BOQ fields for one shape (hover card, filtered panel). */
export function resolveShapeBoq(shape, conditions, detectCtx, boqLines = [], units = "imperial", pricingCtx = null) {
  const rows = buildShapeRows([shape], conditions, detectCtx);
  if (!rows.length) return null;
  const r = rows[0];
  const meta = boqLines.find((l) => l.id === rowKey(shape.id)) || {};
  const pq = primaryQty(r, units);
  const qty = meta.qty_override !== "" && meta.qty_override != null ? Number(meta.qty_override) : pq.qty;
  const primaryRef = r.schedule_refs?.find((x) => x.tag === r.finish_tag) || r.schedule_refs?.[0];
  const autoDesc = primaryRef?.description || "";

  let pricing = {};
  if (pricingCtx?.priceRow) {
    pricing = pricingCtx.priceRow({
      qty,
      unit: meta.unit || pq.unit,
      finish_tag: r.finish_tag,
      description: meta.description || autoDesc,
      waste_pct: conditions.find((c) => c.id === r.condition_id)?.waste_pct,
    });
  }

  return {
    ...r,
    room: meta.room || r.room_detected || "",
    qty,
    unit: meta.unit || pq.unit,
    description: meta.description || autoDesc,
    schedule_refs: r.schedule_refs || [],
    rate: meta.rate_material != null
      ? (Number(meta.rate_material) || 0) + (Number(meta.rate_labour) || 0) + (Number(meta.rate_equipment) || 0) + (Number(meta.rate_sub) || 0)
      : (pricing.rate ?? null),
    amount: meta.amount != null ? Number(meta.amount) : (pricing.amount ?? null),
    currency: pricing.currency || pricingCtx?.currency || "AED",
    priced_from: pricing.priced_from || null,
    material_rate_id: meta.material_rate_id || pricing.material_rate_id || null,
  };
}
