// Shared BOQ row detection — used by BoqPanel and canvas hover cards.
import { round2 } from "./totals.js";
import { areaUnit, lenUnit } from "./units";
import { distToSeg, pointInPoly } from "./geometry.js";
import { shapeLabelValue } from "./shapeLabels.js";
import { resolveSymbolFields, symbolNoteKey } from "./planSymbols";
import { lookupScheduleKb, lookupScheduleKbForRoom } from "./symbolScheduleKb";
import { parseOpeningSize, openingsDeductSfLinear, openingsDeductSfFloorPerim } from "./wallOpenings.js";

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

function distToPolyEdgePx(x, y, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const d = distToSeg(x, y, poly[i][0], poly[i][1], poly[j][0], poly[j][1]);
    if (d < best) best = d;
  }
  return best;
}

/** Inside the mask, or within a small pad of its border (door/window marks sit on walls). */
function maskHitKind(x, y, shape, dims, borderPadPx = 32) {
  const poly = shapePolyPx(shape, dims);
  if (poly.length < 2) return null;
  // Open wall runs — door must sit on/near the traced line.
  if (shape.measure_role === "surface_area" || shape.measure_role === "linear") {
    let best = Infinity;
    for (let i = 1; i < poly.length; i++) {
      best = Math.min(best, distToSeg(x, y, poly[i - 1][0], poly[i - 1][1], poly[i][0], poly[i][1]));
    }
    return best <= borderPadPx ? "border" : null;
  }
  if (pointInShapePx(x, y, shape, dims)) return "inside";
  if (poly.length < 3) return null;
  return distToPolyEdgePx(x, y, poly) <= borderPadPx ? "border" : null;
}

function tagsInsideMask(shape, planSymbols, panelImgs) {
  const dims = panelImgs[shape.sheet_id];
  const tags = new Set();
  for (const sym of (planSymbols || []).filter((s) => s.sheet_id === shape.sheet_id)) {
    if (maskHitKind(sym.x, sym.y, shape, dims)) tags.add(sym.tag.toUpperCase());
  }
  return tags;
}

/** Floor label from plan sheet filename (A1105-1st FLOOR PLAN.pdf → 1ST FLOOR). */
export function floorLabelFromSheetId(sheetId) {
  const fn = String(sheetId || "").replace(/^.*[/\\]/, "").toUpperCase();
  const m = fn.match(/(\d+(?:ST|ND|RD|TH))\s*FLOOR/);
  if (m) return `${m[1]} FLOOR`.replace(/\s+/g, " ");
  if (/\b1ST\b/.test(fn)) return "1ST FLOOR";
  if (/2ND[\s\S]{0,8}25TH|TO\s*25TH/.test(fn)) return "2ND FLOOR TO 25TH FLOOR";
  if (/\b2ND\b/.test(fn)) return "2ND FLOOR";
  if (/\b3RD\b/.test(fn)) return "3RD FLOOR";
  if (/\b4TH\b/.test(fn)) return "4TH FLOOR";
  if (/\b5TH\b/.test(fn) && /\b6TH\b/.test(fn)) return "5TH & 6TH FLOOR";
  if (/\b5TH\b/.test(fn)) return "5TH FLOOR";
  if (/\b6TH\b/.test(fn)) return "6TH FLOOR";
  if (/\b7TH\b/.test(fn)) return "7TH FLOOR";
  if (/\b26TH\b/.test(fn)) return "26TH FLOOR";
  if (/\b27TH\b/.test(fn)) return "27TH FLOOR";
  return "";
}

/** Split a concatenated finish description into category sections (schedule fallback). */
function splitFinishDescription(text) {
  const empty = { floor_finish: "", skirting: "", wall_finishes: "", ceiling: "" };
  if (!text?.trim()) return empty;
  const t = text.replace(/\s+/g, " ").trim();

  const skWord = t.search(/\bSKIRTING\b/i);
  const wallWord = t.search(/\bWALL\s+(?:EMULSION|PAINT|FINISH|TILE|CLADDING|VENEER|COVERING)/i);
  const gypsumMatches = [...t.matchAll(/\b(\d+(?:\.\d+)?\s*MM\s+THICK\s+(?:WATER\s*PROOF\s*|REGULAR\s*)?GYPSUM\b)/gi)];
  const lastGypsum = gypsumMatches.length ? gypsumMatches[gypsumMatches.length - 1].index : -1;

  let skirting = "";
  if (skWord >= 0) {
    const before = t.slice(0, skWord);
    const near = before.slice(Math.max(0, before.length - 90));
    const mmAll = [...near.matchAll(/\b\d+\s*MM\b/gi)];
    const start = mmAll.length ? before.length - near.length + mmAll[mmAll.length - 1].index : skWord;
    const end = wallWord >= 0 ? wallWord : (lastGypsum >= 0 ? lastGypsum : t.length);
    skirting = t.slice(start, end).trim();
  }

  let wall_finishes = "";
  if (wallWord >= 0) {
    const end = lastGypsum > wallWord ? lastGypsum : t.length;
    wall_finishes = t.slice(wallWord, end).trim();
  }

  let ceiling = "";
  const wp = gypsumMatches.find((g) => /WATER\s*PROOF/i.test(g[1]));
  if (wp) ceiling = t.slice(wp.index).trim();
  else if (lastGypsum >= 0 && wallWord >= 0 && lastGypsum > wallWord) ceiling = t.slice(lastGypsum).trim();

  let floor_finish = skWord >= 0 ? t.slice(0, skWord).trim() : t;
  floor_finish = floor_finish.replace(/\s+\d{1,2}\.ENT\.[^]*$/i, "").trim();
  floor_finish = floor_finish.replace(/\s*\+\s*\d+(?:\.\d+)?\s*MM\s+THICK\s+REGULAR\s+GYPSUM\b.*$/i, "").trim();
  floor_finish = floor_finish.replace(/\+\s*$/, "").trim();

  return { floor_finish, skirting, wall_finishes, ceiling };
}

function descForFinishTag(kb, tag, room, sheetFloor) {
  if (!tag?.trim() || !kb) return "";
  const hit = lookupScheduleKbForRoom(kb, tag, room, sheetFloor) || lookupScheduleKb(kb, tag);
  return (hit?.description || "").trim();
}

/** Finish schedule fields for a floor mask — room + sheet floor scoped. */
export function resolveMaskFinishDetails(row, conditionDescription = "", scheduleKb = null) {
  if (!row) return null;
  const tag = (row.finish_tag || "").trim().toUpperCase();
  const room = row.room || row.room_detected || "";
  const sheetFloor = floorLabelFromSheetId(row.sheet_id);
  const refs = row.schedule_refs || [];
  const finishRef = refs
    .filter((r) => r.tag?.toUpperCase() === tag || r.kind === "finish")
    .sort((a, b) => {
      let sa = a.description ? 40 : 0;
      let sb = b.description ? 40 : 0;
      sa += roomMatchScore(a.room_name || "", room);
      sb += roomMatchScore(b.room_name || "", room);
      if (sheetFloor && a.floors) sa += a.floors.toUpperCase().includes(sheetFloor.split(" ")[0]) ? 25 : 0;
      if (sheetFloor && b.floors) sb += b.floors.toUpperCase().includes(sheetFloor.split(" ")[0]) ? 25 : 0;
      return sb - sa;
    })[0]
    || refs.find((r) => r.description)
    || refs[0];
  const description = row.description || finishRef?.description || conditionDescription || "";
  if (!description && !finishRef && !tag) return null;

  const kbEntry = scheduleKb ? lookupMaskFinish(scheduleKb, tag, room, sheetFloor) : null;
  const skirtingTag = kbEntry?.skirting_tag || finishRef?.skirting_tag || "";
  const wallTag = kbEntry?.wall_tag || finishRef?.wall_tag || "";
  const ceilingTag = kbEntry?.ceiling_tag || finishRef?.ceiling_tag || "";

  let floor_finish = (kbEntry?.description || description).trim();
  let skirting = descForFinishTag(scheduleKb, skirtingTag, room, sheetFloor);
  let wall_finishes = descForFinishTag(scheduleKb, wallTag, room, sheetFloor);
  let ceiling = descForFinishTag(scheduleKb, ceilingTag, room, sheetFloor);

  const needsSplit = description.length > 48
    && (/\bSKIRTING\b/i.test(description) || /\bWALL\b/i.test(description) || /\bGYPSUM\b/i.test(description));
  if (needsSplit && (!skirting || !wall_finishes || !ceiling || floor_finish === description)) {
    const split = splitFinishDescription(description);
    if (split.floor_finish) floor_finish = split.floor_finish;
    if (!skirting && split.skirting) skirting = split.skirting;
    if (!wall_finishes && split.wall_finishes) wall_finishes = split.wall_finishes;
    if (!ceiling && split.ceiling) ceiling = split.ceiling;
  }

  return {
    tag,
    room_name: row.room || row.room_detected || finishRef?.room_name || "",
    type: finishRef?.type || "Finish code",
    description,
    floor_finish,
    skirting,
    wall_finishes,
    ceiling,
    size: finishRef?.size || "",
    fire_rating: finishRef?.fire_rating || "",
    floors: finishRef?.floors || sheetFloor || "",
    manufacturer: finishRef?.manufacturer || "",
    style: finishRef?.style || "",
    color: finishRef?.color || "",
    remarks: finishRef?.remarks || "",
    source: finishRef?.source || finishRef?.source_title || "",
    source_sheet: finishRef?.source_sheet || "",
    source_bbox: finishRef?.source_bbox || null,
  };
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
    fire_rating: entry.fire_rating || "",
    floors: entry.floors || "",
    type: entry.type || "",
    remarks: entry.remarks || "",
    skirting_tag: entry.skirting_tag || "",
    wall_tag: entry.wall_tag || "",
    ceiling_tag: entry.ceiling_tag || "",
    source: entry.source_title || entry.source_sheet || sourceLabel,
    source_sheet: entry.source_sheet || "",
    source_title: entry.source_title || "",
    source_bbox: entry.source_bbox || null,
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
function lookupMaskFinish(kb, finishTag, room, sheetFloor = "") {
  if (!finishTag || !kb) return null;
  const hit = lookupScheduleKbForRoom(kb, finishTag, room, sheetFloor);
  if (hit?.description) return hit;
  if (hit && !room) return hit;

  const tag = finishTag.toUpperCase();
  if (room) {
    for (const e of kbEntriesForRoomStrict(kb, room)) {
      if (e.tag?.toUpperCase() === tag && e.description) return e;
    }
  }

  const global = lookupScheduleKb(kb, tag);
  if (!global) return hit;
  if (global.room_name && room && roomMatchScore(global.room_name, room) < 65) {
    return hit?.description ? hit : null;
  }
  return global.description ? global : (hit || global);
}

/** Search plan marks + schedule PDFs — only data tied to this mask's room, finish, or in-mask marks. */
export function gatherShapeScheduleRefs(shape, condition, detectCtx, roomName = "") {
  const { planSymbols, symbolNotes, panelImgs, scheduleKb } = detectCtx;
  const refs = [];
  const finishTag = (condition?.finish_tag || "").trim().toUpperCase();
  const room = roomName || detectRoomName(shape, detectCtx);
  const sheetFloor = floorLabelFromSheetId(shape.sheet_id);
  const inMaskTags = tagsInsideMask(shape, planSymbols, panelImgs);

  // 1. Primary finish spec — room-scoped finish schedule row for the assigned finish code
  const finishKb = lookupMaskFinish(scheduleKb, finishTag, room, sheetFloor);
  const finishRef = refFromKb(finishKb, "Finish schedule");
  if (finishRef) {
    finishRef.relevance = 60;
    refs.push(finishRef);
  }

  // 2. In-mask + border plan marks with real schedule data (doors/windows sit on walls)
  const dims = panelImgs[shape.sheet_id];
  for (const sym of (planSymbols || []).filter((s) => s.sheet_id === shape.sheet_id)) {
    const hit = maskHitKind(sym.x, sym.y, shape, dims);
    if (!hit) continue;

    const symTag = (sym.tag || "").toUpperCase();
    if (sym.kind === "detail" || sym.kind === "type") continue;
    if (sym.kind === "finish" && symTag === finishTag && finishRef?.description) continue;

    const isOpening = sym.kind === "door" || sym.kind === "window";
    // Border pad is for openings on the wall — don't pull finish marks from the next room.
    if (hit === "border" && !isOpening) continue;

    const noteKey = symbolNoteKey(sym.sheet_id, sym.tag, sym.x, sym.y);
    const fields = resolveSymbolFields(sym.schedule, symbolNotes[noteKey], sym.room_name);
    const kb = (sym.kind === "finish" || symTag === finishTag)
      ? lookupScheduleKbForRoom(scheduleKb, sym.tag, room, sheetFloor)
      : lookupScheduleKb(scheduleKb, sym.tag);
    const kbRef = refFromKb(kb, "Schedule");

    const description = fields.description || kbRef?.description || "";
    const manufacturer = fields.manufacturer || kbRef?.manufacturer || "";
    const size = fields.size || kbRef?.size || "";
    const color = fields.color || kbRef?.color || "";
    const fire_rating = fields.fire_rating || kb?.fire_rating || "";
    const floors = fields.floors || kb?.floors || "";
    const remarks = fields.remarks || "";
    const type = fields.type || "";

    const hasData = !!(description || manufacturer || size || color || fire_rating || floors || remarks || type);
    if (!isOpening && !hasData) continue;
    if (sym.kind === "finish" && symTag !== finishTag && !hasData) continue;

    if (kbRef?.room_name && room && roomMatchScore(kbRef.room_name, room) < 65) continue;

    refs.push({
      tag: sym.tag,
      kind: sym.kind,
      symbol_id: sym.id || "",
      description,
      manufacturer,
      color,
      size,
      fire_rating,
      floors,
      remarks,
      type,
      room_name: fields.room_name || kbRef?.room_name || sym.room_name || "",
      source: kbRef?.source || sym.schedule?.source_title || (hit === "border" ? "Border mark" : "Plan mark"),
      source_sheet: kbRef?.source_sheet || sym.schedule?.source_sheet || "",
      relevance: isOpening ? (hit === "border" ? 38 : 35) : (symTag === finishTag ? 40 : 20),
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
    || r.fire_rating || r.floors || r.remarks || r.type
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

/** Wall traces on the same condition — floor masks inherit their drawn height when condition H is unset. */
function inferWallHeightFromTraces(shape, condition, detectCtx) {
  const condH = Number(condition?.height_ft) || 0;
  let best = 0;
  for (const s of detectCtx?.shapes || []) {
    if (s.id === shape.id || s.sheet_id !== shape.sheet_id || s.condition_id !== shape.condition_id) continue;
    if (s.measure_role !== "surface_area" && s.measure_role !== "wall_area") continue;
    const h = s.height_override === true
      ? Number(s.height_ft) || 0
      : Number(s.height_ft) || condH || 0;
    if (h > best) best = h;
  }
  return best;
}

function wallHeightFt(shape, condition, detectCtx) {
  if (shape.height_override === true) return Number(shape.height_ft) || 0;
  const condH = Number(condition?.height_ft) || 0;
  // Floor masks: perim × condition H (live); never a stale shape.height_ft fallback.
  if (shape.measure_role === "floor_area") {
    return condH > 0 ? condH : inferWallHeightFromTraces(shape, condition, detectCtx);
  }
  return Number(shape.height_ft) || condH || 0;
}

/** Door/window marks inside or on the trace border → opening deduct rows. */
function openingsFromNearbyDoors(shape, detectCtx, borderPadPx = 32) {
  const { planSymbols, symbolNotes, panelImgs } = detectCtx;
  const dims = panelImgs?.[shape.sheet_id];
  if (!dims?.w) return [];
  const out = [];
  const seen = new Set();
  for (const sym of (planSymbols || []).filter((s) => s.sheet_id === shape.sheet_id)) {
    if (sym.kind !== "door" && sym.kind !== "window") continue;
    if (!maskHitKind(sym.x, sym.y, shape, dims, borderPadPx)) continue;
    const tagU = String(sym.tag || "").toUpperCase();
    if (tagU && seen.has(tagU)) continue;
    if (tagU) seen.add(tagU);
    const nk = symbolNoteKey(sym.sheet_id, sym.tag, sym.x, sym.y);
    const fields = resolveSymbolFields(sym.schedule, symbolNotes?.[nk], sym.room_name);
    const parsed = parseOpeningSize(fields.size || sym.schedule?.size || "");
    out.push({
      tag: sym.tag || "",
      kind: sym.kind,
      symbol_id: sym.id || "",
      width_ft: parsed?.width_ft || 3,
      height_ft: parsed?.height_ft || 7,
      source: "plan_mark",
    });
  }
  return out;
}

function mergeOpeningsForBoq(stored = [], nearby = []) {
  const seen = new Set(stored.map((o) => String(o.tag || "").toUpperCase()).filter(Boolean));
  const out = [...stored];
  for (const o of nearby) {
    const tagU = String(o.tag || "").toUpperCase();
    if (tagU && seen.has(tagU)) continue;
    if (tagU) seen.add(tagU);
    out.push(o);
  }
  return out;
}

/** Floor + wall face for BOQ hover — wall deducts doors inside/on the trace. */
export function boqWallFaceMetrics(shape, condition, detectCtx) {
  const cp = shape.computed || {};
  const role = shape.measure_role;
  const h = wallHeightFt(shape, condition, detectCtx);
  const nearby = openingsFromNearbyDoors(shape, detectCtx);
  const stored = shape.openings || [];

  if (role === "surface_area") {
    const lf = cp.perimeter_lf || 0;
    const gross = cp.gross_face_sf || +(lf * h).toFixed(2);
    const openings = mergeOpeningsForBoq(stored, nearby);
    const opening_sf = openingsDeductSfLinear(openings, lf, h);
    const wall_sf = +Math.max(0, gross - opening_sf).toFixed(2);
    return { floor_sf: 0, wall_sf, gross_wall_sf: gross, opening_sf, lf };
  }

  if (role === "wall_area") {
    const openings = mergeOpeningsForBoq(stored, nearby);
    const gross = cp.gross_face_sf || cp.wall_face_sf || 0;
    const lf = cp.perimeter_lf || 0;
    const opening_sf = openings.length
      ? openingsDeductSfLinear(openings, lf || 1, h)
      : (cp.opening_sf || 0);
    const wall_sf = cp.wall_face_sf != null && !stored.length && !nearby.length
      ? (cp.wall_face_sf || cp.area_sf || 0)
      : +Math.max(0, gross - opening_sf).toFixed(2);
    return {
      floor_sf: 0,
      wall_sf,
      gross_wall_sf: gross,
      opening_sf: stored.length || nearby.length ? opening_sf : (cp.opening_sf || 0),
      lf,
    };
  }

  if (role === "floor_area") {
    const lf = cp.perimeter_lf || 0;
    const gross = +(lf * h).toFixed(2);
    const openings = mergeOpeningsForBoq(stored, nearby);
    const opening_sf = openingsDeductSfFloorPerim(openings, lf, h);
    const wall_sf = +Math.max(0, gross - opening_sf).toFixed(2);
    return {
      floor_sf: cp.area_sf || 0,
      wall_sf,
      gross_wall_sf: gross,
      opening_sf,
      lf,
    };
  }

  return {
    floor_sf: cp.area_sf || 0,
    wall_sf: cp.wall_face_sf || cp.area_sf || 0,
    gross_wall_sf: cp.gross_face_sf || 0,
    opening_sf: cp.opening_sf || 0,
    lf: cp.perimeter_lf || 0,
  };
}

export function primaryQty(row, units) {
  if (row.floor_sf) return { qty: row.floor_sf, unit: areaUnit(units), kind: "floor" };
  if (row.wall_sf || row.role === "surface_area" || row.role === "wall_area") {
    return { qty: row.wall_sf || 0, unit: areaUnit(units), kind: "wall" };
  }
  if (row.lf) return { qty: row.lf, unit: lenUnit(units), kind: "lf" };
  if (row.ea) return { qty: row.ea, unit: "EA", kind: "ea" };
  return { qty: 0, unit: areaUnit(units), kind: "floor" };
}

export function buildShapeRows(shapes, conditions, detectCtx) {
  const byId = new Map(conditions.map((c) => [c.id, c]));
  const minVerts = (s) => {
    if (s.measure_role === "count") return 1;
    if (s.measure_role === "surface_area" || s.measure_role === "linear") return 2;
    return 3;
  };
  return shapes
    .filter((s) => Array.isArray(s.verts_norm) && s.verts_norm.length >= minVerts(s))
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
  const cond = conditions.find((c) => c.id === shape.condition_id);
  const face = boqWallFaceMetrics(shape, cond, detectCtx);
  const meta = boqLines.find((l) => l.id === rowKey(shape.id)) || {};
  const displayRow = {
    ...r,
    floor_sf: face.floor_sf || r.floor_sf,
    wall_sf: face.wall_sf,
    lf: face.lf || r.lf,
  };
  const pq = primaryQty(displayRow, units);
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
    ...displayRow,
    role: r.role || shape.measure_role,
    gross_wall_sf: face.gross_wall_sf || 0,
    opening_sf: face.opening_sf || 0,
    room: meta.room || r.room_detected || "",
    qty,
    unit: meta.unit || pq.unit,
    description: meta.description || autoDesc,
    schedule_refs: r.schedule_refs || [],
    finish_details: resolveMaskFinishDetails({
      ...r,
      ...displayRow,
      room: meta.room || r.room_detected || "",
      description: meta.description || autoDesc,
    }, cond?.description || "", detectCtx?.scheduleKb),
    rate: meta.rate_material != null
      ? (Number(meta.rate_material) || 0) + (Number(meta.rate_labour) || 0) + (Number(meta.rate_equipment) || 0) + (Number(meta.rate_sub) || 0)
      : (pricing.rate ?? null),
    amount: meta.amount != null ? Number(meta.amount) : (pricing.amount ?? null),
    currency: pricing.currency || pricingCtx?.currency || "AED",
    priced_from: pricing.priced_from || null,
    material_rate_id: meta.material_rate_id || pricing.material_rate_id || null,
  };
}
