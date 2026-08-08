// ADICC Volume 4 RAG client — talks to the FastAPI backend via the /rag proxy.

import { parseSheetKey } from "./sheetKey";
import { resolveSymbolFields, symbolNoteKey } from "./planSymbols";
import { detectRoomName, primaryQty, shapeQuantities } from "./boqDetect.js";

/** @typedef {{ id: string, chunk_id: number, doc_path: string, page_no: number, sheet_id?: string|null, sheet_title?: string|null, discipline?: string|null, bbox?: number[]|null, quote: string, source: string, verified: boolean }} Citation */

/** @typedef {{ answer: string, citations: Citation[], abstained: boolean, candidates?: Array<Record<string, unknown>>|null }} QueryResponse */

/** @typedef {{ room: string, matched_room?: string|null, finish_codes: Array<{ category: string, code: string, description: string, material?: string|null }>, citations: Citation[], abstained: boolean }} FinishForRoomResponse */

// Local Vite proxies /rag → 127.0.0.1:8001. Production sets VITE_RAG_URL to the Render RAG service.
const RAG_BASE = (import.meta.env.VITE_RAG_URL || "/rag").replace(/\/$/, "");

function compact(obj) {
  if (obj == null) return undefined;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    const arr = obj.map(compact).filter((v) => v !== undefined);
    return arr.length ? arr : undefined;
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const cv = compact(v);
    if (cv !== undefined && cv !== "") out[k] = cv;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Compact live takeoff + detection context for the RAG / OpenAI chat prompt.
 * Includes masks/cutouts, doors, windows, finish/curtain marks, and schedule fields.
 * @param {{
 *   projectName?: string,
 *   units?: string,
 *   shapes?: any[],
 *   conditions?: any[],
 *   planSymbols?: any[],
 *   symbolNotes?: Record<string, any>,
 *   panelImgs?: Record<string, any>,
 *   roomLabelsBySheet?: Record<string, any>,
 *   scheduleKb?: Map|object|null,
 * }} input
 * @returns {string}
 */
function sheetFileName(sheetId) {
  return String(sheetId || "").replace(/^.*[/\\]/, "") || String(sheetId || "");
}

/** CW / SD / GD mark families from the tag prefix (plan hover marks). */
function tagPrefixFamily(tag) {
  const t = String(tag || "").replace(/[\s_]+/g, "").toUpperCase();
  if (/^CW-?\d/i.test(t) || /^CW\d/i.test(t)) return "cw";
  if (/^SD-?\d/i.test(t) || /^SD\d/i.test(t)) return "sd";
  if (/^GD-?\d/i.test(t) || /^GD\d/i.test(t)) return "gd";
  return null;
}

/** Per-sheet door/window/finish totals — put first so count questions always have data. */
function buildSheetSymbolTotals(planSymbols = []) {
  /** @type {Record<string, any>} */
  const bySheet = {};
  for (const sym of planSymbols || []) {
    const sheet = sym.sheet_id || "";
    if (!bySheet[sheet]) {
      bySheet[sheet] = {
        sheet,
        file: sheetFileName(sheet),
        doors: 0,
        windows: 0,
        finish: 0,
        type: 0,
        detail: 0,
        total_symbols: 0,
        door_tags: {},
        window_tags: {},
        finish_tags: {},
        cw: 0,
        sd: 0,
        gd: 0,
        cw_tags: {},
        sd_tags: {},
        gd_tags: {},
      };
    }
    const row = bySheet[sheet];
    row.total_symbols += 1;
    const kind = sym.kind || "detail";
    if (kind === "door") {
      row.doors += 1;
      row.door_tags[sym.tag] = (row.door_tags[sym.tag] || 0) + 1;
    } else if (kind === "window") {
      row.windows += 1;
      row.window_tags[sym.tag] = (row.window_tags[sym.tag] || 0) + 1;
    } else if (kind === "finish") {
      row.finish += 1;
      row.finish_tags[sym.tag] = (row.finish_tags[sym.tag] || 0) + 1;
    } else if (kind === "type") {
      row.type += 1;
    } else {
      row.detail += 1;
    }
    const fam = tagPrefixFamily(sym.tag);
    if (fam === "cw") {
      row.cw += 1;
      row.cw_tags[sym.tag] = (row.cw_tags[sym.tag] || 0) + 1;
    } else if (fam === "sd") {
      row.sd += 1;
      row.sd_tags[sym.tag] = (row.sd_tags[sym.tag] || 0) + 1;
    } else if (fam === "gd") {
      row.gd += 1;
      row.gd_tags[sym.tag] = (row.gd_tags[sym.tag] || 0) + 1;
    }
  }
  return Object.values(bySheet).map((r) => compact({
    sheet: r.sheet,
    file: r.file,
    doors: r.doors || undefined,
    windows: r.windows || undefined,
    finish_marks: r.finish || undefined,
    type_marks: r.type || undefined,
    detail_marks: r.detail || undefined,
    curtain_cw: r.cw || undefined,
    steel_sliding_sd: r.sd || undefined,
    glass_door_gd: r.gd || undefined,
    total_symbols: r.total_symbols,
    door_tags: Object.keys(r.door_tags).length ? r.door_tags : undefined,
    window_tags: Object.keys(r.window_tags).length ? r.window_tags : undefined,
    finish_tags: Object.keys(r.finish_tags).length ? r.finish_tags : undefined,
    cw_tags: Object.keys(r.cw_tags).length ? r.cw_tags : undefined,
    sd_tags: Object.keys(r.sd_tags).length ? r.sd_tags : undefined,
    gd_tags: Object.keys(r.gd_tags).length ? r.gd_tags : undefined,
  }));
}

/** Net floor / wall SF + mask counts per sheet from live shapes. */
function buildSheetAreaTotals(shapes = [], conditions = []) {
  const condById = Object.fromEntries((conditions || []).map((c) => [c.id, c]));
  /** @type {Record<string, any>} */
  const byFile = {};
  for (const s of shapes || []) {
    const file = sheetFileName(s.sheet_id);
    if (!byFile[file]) {
      byFile[file] = {
        file,
        sheet: s.sheet_id,
        masks: 0,
        cutouts: 0,
        floor_sf: 0,
        wall_sf: 0,
        finishes: {},
      };
    }
    const row = byFile[file];
    if (s.measure_role === "deduct") row.cutouts += 1;
    else row.masks += 1;
    try {
      const q = shapeQuantities(s);
      row.floor_sf += Number(q.floor_sf) || 0;
      row.wall_sf += Number(q.wall_sf) || 0;
    } catch { /* ignore */ }
    const ft = (condById[s.condition_id]?.finish_tag || "").trim();
    if (ft) row.finishes[ft] = (row.finishes[ft] || 0) + 1;
  }
  return Object.values(byFile).map((r) => compact({
    file: r.file,
    sheet: r.sheet,
    masks: r.masks || undefined,
    cutouts: r.cutouts || undefined,
    floor_sf: Math.abs(r.floor_sf) > 0.005 ? Math.round(r.floor_sf * 100) / 100 : undefined,
    wall_sf: Math.abs(r.wall_sf) > 0.005 ? Math.round(r.wall_sf * 100) / 100 : undefined,
    finishes: Object.keys(r.finishes).length ? r.finishes : undefined,
  }));
}

/** Hover-card fields for a plan symbol (schedule-backed; same rows as the canvas card). */
function symbolHoverDetail(sym) {
  const fields = resolveSymbolFields(sym?.schedule || {}, null, sym?.room_name);
  return compact({
    tag: sym.tag,
    kind: sym.kind,
    sheet: sheetFileName(sym.sheet_id),
    room_name: fields.room_name || undefined,
    type: fields.type || undefined,
    description: fields.description || undefined,
    size: fields.size || undefined,
    fire_rating: fields.fire_rating || undefined,
    floors: fields.floors || undefined,
    manufacturer: fields.manufacturer || undefined,
    style: fields.style || undefined,
    color: fields.color || undefined,
    remarks: fields.remarks || undefined,
    finish_tag: fields.finish_tag || undefined,
  });
}

function formatHoverDetailLines(detail) {
  if (!detail) return [];
  const labels = [
    ["tag", "Tag"],
    ["kind", "Kind"],
    ["sheet", "Sheet"],
    ["room_name", "Room name"],
    ["type", "Type"],
    ["description", "Description"],
    ["size", "Size / opening"],
    ["fire_rating", "Fire rating"],
    ["floors", "Floors"],
    ["manufacturer", "Manufacturer"],
    ["style", "Style"],
    ["color", "Color"],
    ["finish_tag", "Finish"],
    ["remarks", "Remarks"],
  ];
  return labels
    .filter(([k]) => detail[k])
    .map(([k, label]) => `${label}: ${detail[k]}`);
}

/** Pick sheets mentioned in the question, else all. */
function matchSheetsFromQuestion(question, sheetTotals) {
  const q = String(question || "").toLowerCase();
  const sheetHint = (q.match(/\ba1\d{3}\b/i) || q.match(/\b[a-z]\d{3,5}\b/i) || [])[0] || "";
  const matched = (sheetTotals || []).filter((r) => {
    const file = String(r.file || "").toLowerCase();
    const sheet = String(r.sheet || "").toLowerCase();
    if (q.includes(file) || q.includes(sheet)) return true;
    if (sheetHint && (file.includes(sheetHint.toLowerCase()) || sheet.includes(sheetHint.toLowerCase()))) return true;
    if (/\b1st\b/.test(q) && /1st/.test(file)) return true;
    if (/\b2nd\b/.test(q) && /2nd/.test(file)) return true;
    return false;
  });
  return { matched, sheetHint, rows: matched.length ? matched : (sheetHint ? [] : (sheetTotals || [])) };
}

/**
 * Short plain-text counts + door hover fields + floor areas for embedding in the question
 * (survives backends that ignore project_context).
 * @param {any[]} planSymbols
 * @param {any[]} shapes
 * @param {any[]} conditions
 */
export function buildLiveCountsSummary(planSymbols = [], shapes = [], conditions = []) {
  const sheetTotals = buildSheetSymbolTotals(planSymbols);
  const areaTotals = buildSheetAreaTotals(shapes, conditions);
  if (!sheetTotals.length && !areaTotals.length) return "";
  const lines = [
    "AUTHORITATIVE LIVE DETECTIONS from the open takeoff canvas.",
    "For door count, CW curtain / SD steel-sliding / GD glass-door counts, door schedule/hover details, window/finish marks, floor area, and mask quantity questions, use these numbers. Do not say unknown when a sheet is listed below.",
  ];
  for (const r of sheetTotals) {
    const parts = [];
    if (r.doors) {
      const tags = r.door_tags
        ? Object.entries(r.door_tags).map(([t, n]) => `${t}=${n}`).join(", ")
        : "";
      parts.push(`${r.doors} doors${tags ? ` (${tags})` : ""}`);
    }
    if (r.curtain_cw) {
      const tags = r.cw_tags
        ? Object.entries(r.cw_tags).map(([t, n]) => `${t}=${n}`).join(", ")
        : "";
      parts.push(`${r.curtain_cw} curtain/CW marks${tags ? ` (${tags})` : ""}`);
    }
    if (r.steel_sliding_sd) {
      const tags = r.sd_tags
        ? Object.entries(r.sd_tags).map(([t, n]) => `${t}=${n}`).join(", ")
        : "";
      parts.push(`${r.steel_sliding_sd} steel/sliding SD doors${tags ? ` (${tags})` : ""}`);
    }
    if (r.glass_door_gd) {
      const tags = r.gd_tags
        ? Object.entries(r.gd_tags).map(([t, n]) => `${t}=${n}`).join(", ")
        : "";
      parts.push(`${r.glass_door_gd} glass GD doors${tags ? ` (${tags})` : ""}`);
    }
    if (r.windows) {
      const tags = r.window_tags
        ? Object.entries(r.window_tags).map(([t, n]) => `${t}=${n}`).join(", ")
        : "";
      parts.push(`${r.windows} windows${tags ? ` (${tags})` : ""}`);
    }
    if (r.finish_marks) {
      const tags = r.finish_tags
        ? Object.entries(r.finish_tags).map(([t, n]) => `${t}=${n}`).join(", ")
        : "";
      parts.push(`${r.finish_marks} finish/curtain marks${tags ? ` (${tags})` : ""}`);
    }
    if (r.type_marks) parts.push(`${r.type_marks} type marks`);
    if (!parts.length) parts.push(`${r.total_symbols} symbols`);
    lines.push(`- ${r.file}: ${parts.join("; ")}`);
  }
  // Compact door hover fields (same as canvas card) so detail questions have data.
  const doorDetails = (planSymbols || [])
    .filter((s) => s.kind === "door")
    .slice(0, 80)
    .map((s) => symbolHoverDetail(s))
    .filter(Boolean);
  if (doorDetails.length) {
    lines.push("Door details (hover-card fields from live detections / schedules):");
    for (const d of doorDetails) {
      const bits = formatHoverDetailLines(d);
      if (bits.length) lines.push(`- ${bits.join("; ")}`);
    }
  }
  for (const m of areaTotals) {
    const fin = m.finishes
      ? Object.entries(m.finishes).map(([t, n]) => `${t}=${n}`).join(", ")
      : "";
    const areaBits = [];
    if (m.floor_sf != null) areaBits.push(`floor area ${m.floor_sf} SF (net of cutouts)`);
    if (m.wall_sf != null) areaBits.push(`wall area ${m.wall_sf} SF`);
    areaBits.push(`${m.masks || 0} masks, ${m.cutouts || 0} cutouts`);
    if (fin) areaBits.push(`finishes ${fin}`);
    lines.push(`- ${m.file} takeoff: ${areaBits.join("; ")}`);
  }
  return lines.join("\n");
}

export function buildProjectChatContext(input = {}) {
  const {
    projectName = "",
    units = "imperial",
    shapes = [],
    conditions = [],
    planSymbols = [],
    symbolNotes = {},
    panelImgs = {},
    roomLabelsBySheet = {},
    scheduleKb = null,
  } = input;
  const condById = Object.fromEntries((conditions || []).map((c) => [c.id, c]));
  const boqCtx = { planSymbols, symbolNotes, panelImgs, roomLabelsBySheet, scheduleKb };
  const sheet_symbol_totals = buildSheetSymbolTotals(planSymbols);

  const masks = [];
  for (const s of (shapes || []).slice(0, 120)) {
    const cond = condById[s.condition_id];
    let room = "";
    try { room = detectRoomName(s, boqCtx, shapes) || ""; } catch { /* ignore */ }
    let qty; let unit;
    try {
      const pq = primaryQty(shapeQuantities(s), units);
      qty = pq?.qty;
      unit = pq?.unit;
    } catch { /* ignore */ }
    masks.push(compact({
      id: s.id,
      sheet: s.sheet_id,
      file: sheetFileName(s.sheet_id),
      role: s.measure_role,
      finish: (cond?.finish_tag || "").trim() || undefined,
      description: (cond?.description || "").trim() || undefined,
      room: room || undefined,
      qty,
      unit,
      holes: Array.isArray(s.holes_norm) && s.holes_norm.length ? s.holes_norm.length : undefined,
    }));
  }

  const kindCounts = {};
  const tagCounts = {};
  for (const sym of planSymbols || []) {
    kindCounts[sym.kind] = (kindCounts[sym.kind] || 0) + 1;
    const tk = `${sym.kind}:${sym.tag}`;
    tagCounts[tk] = (tagCounts[tk] || 0) + 1;
  }

  const symbols = [];
  for (const sym of (planSymbols || []).slice(0, 180)) {
    const nk = symbolNoteKey(sym.sheet_id, sym.tag, sym.x, sym.y);
    const fields = resolveSymbolFields(sym.schedule || {}, symbolNotes?.[nk], sym.room_name);
    symbols.push(compact({
      tag: sym.tag,
      kind: sym.kind,
      sheet: sym.sheet_id,
      file: sheetFileName(sym.sheet_id),
      room: fields.room_name || undefined,
      finish: fields.finish_tag || undefined,
      description: fields.description || undefined,
      manufacturer: fields.manufacturer || undefined,
      style: fields.style || undefined,
      color: fields.color || undefined,
      size: fields.size || undefined,
      type: fields.type || undefined,
      fire_rating: fields.fire_rating || undefined,
      floors: fields.floors || undefined,
      remarks: fields.remarks || undefined,
    }));
  }

  const payload = compact({
    project: projectName || undefined,
    units,
    note: "AUTHORITATIVE live detections. For door counts, CW curtain / SD steel-sliding / GD glass-door counts (sheet_symbol_totals), door hover/schedule details (detected_symbols), floor area (masks_and_takeoffs qty), and window/finish/mask counts, use this payload. Do not say unknown if a sheet or symbol is listed.",
    sheet_symbol_totals,
    symbol_counts_by_kind: kindCounts,
    symbol_tag_counts: Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100)
      .map(([key, count]) => ({ key, count })),
    conditions: (conditions || []).slice(0, 50).map((c) => compact({
      id: c.id,
      finish_tag: c.finish_tag,
      description: c.description,
      waste_pct: c.waste_pct,
      hatch: c.hatch,
    })),
    masks_and_takeoffs: masks,
    detected_symbols: symbols,
  }) || {};

  return JSON.stringify(payload);
}

/**
 * True when the RAG/API answer looks accurate enough to keep.
 * Weak / abstained / "unknown count" answers fail so live detections can take over.
 * @param {string} answer
 * @param {boolean} [abstained]
 * @param {string} [question]
 */
export function ragAnswerIsAccurate(answer, abstained = false, question = "") {
  if (abstained) return false;
  const text = String(answer || "").trim();
  if (text.length < 48) return false;
  if (/insufficient|do not specify|does not specify|not specify the total|sources? (are|were) insufficient|cannot determine|could not determine|unable to (find|determine|confirm)|no (clear |specific )?information|not (explicitly )?stated|not available in the (provided )?sources|confidence[\s\S]{0,80}\blow\b/i.test(text)) {
    return false;
  }
  const q = String(question || "");
  if (/\b(total|how many|count|number of|qty|quantity|floor area|wall area|door details?|doors? on)\b/i.test(q)) {
    // Count / area / door-detail questions need concrete facts in the answer body.
    if (!/\b\d+\b/.test(text)) return false;
    if (/does not (include|contain|provide|list|state).{0,60}(total|count|number|quantity|area|door)/i.test(text)) return false;
  }
  return true;
}

/**
 * RAG-first then live fallback. Keeps accurate corpus answers; otherwise uses live detections.
 * @param {string} question
 * @param {{ answer?: string, abstained?: boolean }} result
 * @param {string|null} liveAnswer
 * @returns {{ content: string, usedLive: boolean, abstained: boolean }}
 */
export function resolveChatAnswer(question, result, liveAnswer = null) {
  const apiAnswer = String(result?.answer || "").trim();
  if (ragAnswerIsAccurate(apiAnswer, !!result?.abstained, question)) {
    return { content: apiAnswer, usedLive: false, abstained: false };
  }
  if (liveAnswer) {
    return { content: String(liveAnswer).trim(), usedLive: true, abstained: false };
  }
  return {
    content: apiAnswer || "TITLE: Unable to answer\n\nSECTION: Result\nNo accurate answer was found in the drawings corpus or live takeoff detections.\n\nSECTION: Confidence\nLow.",
    usedLive: false,
    abstained: !!result?.abstained || !apiAnswer,
  };
}

/**
 * Deterministic answer for door/window totals, door hover-card details, and floor-area
 * questions from live detections. Returns null when the question does not match or no data.
 * @param {string} question
 * @param {any[]} planSymbols
 * @param {any[]} [shapes]
 * @param {any[]} [conditions]
 * @returns {string|null}
 */
export function answerFromLiveDetections(question, planSymbols = [], shapes = [], conditions = []) {
  const q = String(question || "").toLowerCase();
  const wantsDoors = /\bdoors?\b/.test(q);
  const wantsWindows = /\bwindows?\b/.test(q);
  const wantsFinish = /\b(finish|curtain)\b/.test(q);
  const wantsCW = /\b(cw|curtain\s*walls?|curtains?)\b/.test(q);
  const wantsSD = /\b(sd|steel\s*doors?|sliding\s*doors?|steal\s*doors?)\b/.test(q);
  const wantsGD = /\b(gd|glass\s*doors?)\b/.test(q);
  const wantsMarkFamily = wantsCW || wantsSD || wantsGD;
  const wantsMasks = /\b(masks?|takeoffs?|cutouts?)\b/.test(q);
  const explicitFloorArea = /\bfloor\s*(area|sf|takeoff|mask)\b|\bfloor\b.{0,24}\b(area|sf|square\s*feet)\b|\b(area|sf)\b.{0,24}\bfloor\b|\bsquare\s*feet\b|\bsq\.?\s*fts?\b/.test(q);
  const wantsWallArea = /\bwall\s*(area|sf|takeoff)\b|\b(how much|total)\b.{0,40}\bwalls?\b/.test(q);
  const wantsCount = /\b(total|how many|count|number of|qty|quantity|are there)\b/.test(q)
    || (wantsDoors && /\b(on the (floor )?plan|floor plan|detected|live)\b/.test(q))
    || (wantsWindows && /\b(on the (floor )?plan|floor plan)\b/.test(q))
    || (wantsMarkFamily && /\b(on the (floor )?plan|floor plan|detected|live|marks?)\b/.test(q));
  // Don't treat "doors on the 1st floor" as a floor-area question.
  const wantsFloorArea = explicitFloorArea && !(wantsCount && (wantsDoors || wantsWindows || wantsFinish || wantsMarkFamily) && !/\bfloor\s*(area|sf)\b/.test(q));
  const wantsDoorDetails = (wantsDoors || wantsMarkFamily) && (
    /\b(detail|details|spec|specs|schedule|size|opening|fire|rating|manufacturer|style|color|hover|describe|description|fields?)\b/.test(q)
    || (!wantsCount && /\b(about|tell me|what is|what's|info|room|type|width|height)\b/.test(q))
  );
  const tagFromQ = (String(question || "").match(/\b((?:CW|GD|SD|D|W|F)[-\s]?\d{1,4}[A-Za-z]?)\b/i) || [])[0] || "";
  const wantsTagDetail = !!tagFromQ && !wantsCount;

  const sheetTotals = buildSheetSymbolTotals(planSymbols);
  const areaTotals = buildSheetAreaTotals(shapes, conditions);
  if (!sheetTotals.length && !areaTotals.length && !(planSymbols || []).length) return null;

  const { matched, sheetHint, rows } = matchSheetsFromQuestion(question, sheetTotals.length ? sheetTotals : areaTotals);
  const focusSheets = rows.length ? rows : (sheetTotals.length ? sheetTotals : areaTotals);
  const fileSet = new Set(focusSheets.map((r) => String(r.file || "").toLowerCase()));
  const sheetMatchesSym = (sym) => {
    if (!matched.length && !sheetHint) return true;
    const file = sheetFileName(sym.sheet_id).toLowerCase();
    const sheet = String(sym.sheet_id || "").toLowerCase();
    if (fileSet.has(file)) return true;
    if (sheetHint && (file.includes(String(sheetHint).toLowerCase()) || sheet.includes(String(sheetHint).toLowerCase()))) return true;
    return false;
  };
  const matchesFamilyAsk = (sym) => {
    const fam = tagPrefixFamily(sym.tag);
    if (wantsCW && fam === "cw") return true;
    if (wantsSD && fam === "sd") return true;
    if (wantsGD && fam === "gd") return true;
    return false;
  };

  // —— Door / CW / SD / GD hover-card details ——
  if (wantsDoorDetails || wantsTagDetail) {
    let symbols = (planSymbols || []).filter((s) => wantsTagDetail || s.kind === "door" || s.kind === "window" || s.kind === "finish");
    if (tagFromQ) {
      const norm = tagFromQ.replace(/\s+/g, "").toUpperCase();
      symbols = (planSymbols || []).filter((s) => String(s.tag || "").replace(/\s+/g, "").toUpperCase() === norm
        || String(s.tag || "").replace(/\s+/g, "").toUpperCase().includes(norm));
    } else if (wantsMarkFamily) {
      symbols = (planSymbols || []).filter(matchesFamilyAsk);
    } else if (wantsDoors) {
      symbols = symbols.filter((s) => s.kind === "door");
    }
    symbols = symbols.filter(sheetMatchesSym);
    if (!symbols.length && (wantsDoorDetails || wantsTagDetail)) {
      // Fall through to counts if we only wanted tags that aren't present.
      if (!wantsCount && !wantsFloorArea) return null;
    } else if (symbols.length) {
      const familyTitle = wantsCW ? "Curtain/CW" : wantsSD ? "Steel/sliding SD" : wantsGD ? "Glass GD" : "Door";
      const titleSheet = matched.length === 1 ? matched[0].file : (tagFromQ ? tagFromQ.toUpperCase() : `detected ${familyTitle.toLowerCase()} marks`);
      const lines = [
        `TITLE: ${familyTitle} details for ${titleSheet}`,
        "",
        "SECTION: Summary",
        "These fields match the plan-symbol hover card on the takeoff canvas (schedule-backed where available).",
        "",
        "SECTION: Details",
      ];
      const cap = tagFromQ ? 12 : 40;
      for (const sym of symbols.slice(0, cap)) {
        const detail = symbolHoverDetail(sym);
        const bits = formatHoverDetailLines(detail);
        lines.push(bits.length ? bits.join(" · ") : `${sym.tag} (${sym.kind}) on ${sheetFileName(sym.sheet_id)}`);
      }
      if (symbols.length > cap) lines.push(`…and ${symbols.length - cap} more.`);
      if (wantsCount && (wantsDoors || wantsMarkFamily)) {
        lines.push("", "SECTION: Count");
        if (wantsMarkFamily) {
          lines.push(`Total matching CW/SD/GD marks in scope: ${symbols.length}.`);
        } else {
          const doorSyms = (planSymbols || []).filter((s) => s.kind === "door" && sheetMatchesSym(s));
          lines.push(`Total doors in scope: ${doorSyms.length}.`);
        }
      }
      lines.push("", "SECTION: Confidence");
      lines.push("High for live detections. Schedule fields appear when the door/window/finish schedule PDF matched this mark.");
      return lines.join("\n");
    }
  }

  // —— Floor / wall area ——
  if (wantsFloorArea || wantsWallArea) {
    let areas = areaTotals.slice();
    if (matched.length || sheetHint) {
      areas = areaTotals.filter((r) => {
        const file = String(r.file || "").toLowerCase();
        if (fileSet.has(file)) return true;
        if (sheetHint && file.includes(String(sheetHint).toLowerCase())) return true;
        return false;
      });
    }
    if (!areas.length && (shapes || []).length) areas = areaTotals;
    if (!areas.length) return null;
    const titleSheet = matched.length === 1 ? matched[0].file : (matched.length ? "matching sheets" : "open project sheets");
    const lines = [
      `TITLE: ${wantsFloorArea ? "Floor" : "Wall"} area for ${titleSheet}`,
      "",
      "SECTION: Summary",
      "Areas below come from live takeoff masks on the open canvas (floor masks net of cutouts).",
      "",
      "SECTION: Areas",
    ];
    let sumFloor = 0;
    let sumWall = 0;
    for (const r of areas) {
      const bits = [];
      if (wantsFloorArea && r.floor_sf != null) {
        bits.push(`floor area ${r.floor_sf} SF`);
        sumFloor += Number(r.floor_sf) || 0;
      }
      if (wantsWallArea && r.wall_sf != null) {
        bits.push(`wall area ${r.wall_sf} SF`);
        sumWall += Number(r.wall_sf) || 0;
      }
      if (!bits.length && wantsFloorArea) bits.push(`floor area ${r.floor_sf ?? 0} SF`);
      bits.push(`${r.masks || 0} masks, ${r.cutouts || 0} cutouts`);
      lines.push(`${r.file}: ${bits.join("; ")}.`);
    }
    if (areas.length > 1) {
      lines.push("", "SECTION: Totals");
      if (wantsFloorArea) lines.push(`Combined net floor area: ${Math.round(sumFloor * 100) / 100} SF.`);
      if (wantsWallArea) lines.push(`Combined wall area: ${Math.round(sumWall * 100) / 100} SF.`);
    }
    // Per-mask breakdown (room / finish / qty) when available
    const condById = Object.fromEntries((conditions || []).map((c) => [c.id, c]));
    const maskLines = [];
    for (const s of (shapes || []).slice(0, 80)) {
      const file = sheetFileName(s.sheet_id);
      if ((matched.length || sheetHint) && !fileSet.has(file.toLowerCase())
        && !(sheetHint && file.toLowerCase().includes(String(sheetHint).toLowerCase()))) continue;
      if (wantsFloorArea && s.measure_role !== "floor_area" && s.measure_role !== "deduct") continue;
      if (wantsWallArea && !wantsFloorArea && s.measure_role !== "wall_area" && s.measure_role !== "surface_area") continue;
      let room = "";
      try { room = detectRoomName(s, { planSymbols, shapes }, shapes) || ""; } catch { /* ignore */ }
      let qtyText = "";
      try {
        const pq = primaryQty(shapeQuantities(s), "imperial");
        if (pq) qtyText = `${pq.qty} ${pq.unit}`;
      } catch { /* ignore */ }
      const fin = (condById[s.condition_id]?.finish_tag || "").trim();
      maskLines.push(
        `${file}: ${s.measure_role}${room ? ` · ${room}` : ""}${fin ? ` · ${fin}` : ""}${qtyText ? ` · ${qtyText}` : ""}`,
      );
    }
    if (maskLines.length) {
      lines.push("", "SECTION: Masks");
      lines.push(...maskLines);
    }
    lines.push("", "SECTION: Confidence");
    lines.push("High for live takeoff quantities on the open canvas.");
    return lines.join("\n");
  }

  // —— Quantity / count questions ——
  // Prefer CW / SD / GD family asks over generic door/finish totals.
  const specificDoorFamily = wantsSD || wantsGD;
  const genericDoors = wantsDoors && !specificDoorFamily;
  const genericFinish = wantsFinish && !wantsCW;
  if (!wantsCount || !(genericDoors || wantsWindows || genericFinish || wantsMasks || wantsMarkFamily)) return null;
  if (!rows.length && (genericDoors || wantsWindows || genericFinish || wantsMarkFamily)) return null;

  const focus = focusSheets;
  const titleSheet = matched.length === 1 ? matched[0].file : (matched.length ? "matching sheets" : "open project sheets");
  const titleKind = wantsCW ? "Curtain/CW"
    : wantsSD ? "Steel/sliding SD door"
    : wantsGD ? "Glass GD door"
    : genericDoors ? "Door"
    : wantsWindows ? "Window"
    : genericFinish ? "Finish mark"
    : "Takeoff";
  const lines = [
    `TITLE: ${titleKind} totals for ${titleSheet}`,
    "",
    "SECTION: Summary",
    "The drawings corpus did not provide a reliable quantity for this question. Totals below are taken from live plan symbol detection on the open takeoff.",
    "",
    "SECTION: Quantities",
  ];

  for (const r of focus) {
    if (wantsCW) {
      const tagList = r.cw_tags
        ? Object.entries(r.cw_tags).sort((a, b) => a[0].localeCompare(b[0])).map(([t, n]) => `${t}: ${n}`).join(", ")
        : "";
      lines.push(
        `${r.file}: ${r.curtain_cw || 0} curtain/CW marks total`
        + (tagList ? `. Breakdown by tag: ${tagList}.` : "."),
      );
    }
    if (wantsSD) {
      const tagList = r.sd_tags
        ? Object.entries(r.sd_tags).sort((a, b) => a[0].localeCompare(b[0])).map(([t, n]) => `${t}: ${n}`).join(", ")
        : "";
      lines.push(
        `${r.file}: ${r.steel_sliding_sd || 0} steel/sliding SD doors total`
        + (tagList ? `. Breakdown by tag: ${tagList}.` : "."),
      );
    }
    if (wantsGD) {
      const tagList = r.gd_tags
        ? Object.entries(r.gd_tags).sort((a, b) => a[0].localeCompare(b[0])).map(([t, n]) => `${t}: ${n}`).join(", ")
        : "";
      lines.push(
        `${r.file}: ${r.glass_door_gd || 0} glass GD doors total`
        + (tagList ? `. Breakdown by tag: ${tagList}.` : "."),
      );
    }
    if (genericDoors) {
      const tagList = r.door_tags
        ? Object.entries(r.door_tags).sort((a, b) => a[0].localeCompare(b[0])).map(([t, n]) => `${t}: ${n}`).join(", ")
        : "";
      lines.push(
        `${r.file}: ${r.doors || 0} doors total`
        + (tagList ? `. Breakdown by tag: ${tagList}.` : "."),
      );
    }
    if (wantsWindows) {
      const tagList = r.window_tags
        ? Object.entries(r.window_tags).sort((a, b) => a[0].localeCompare(b[0])).map(([t, n]) => `${t}: ${n}`).join(", ")
        : "";
      lines.push(
        `${r.file}: ${r.windows || 0} windows total`
        + (tagList ? `. Breakdown by tag: ${tagList}.` : "."),
      );
    }
    if (genericFinish) {
      const tagList = r.finish_tags
        ? Object.entries(r.finish_tags).sort((a, b) => a[0].localeCompare(b[0])).map(([t, n]) => `${t}: ${n}`).join(", ")
        : "";
      lines.push(
        `${r.file}: ${r.finish_marks || 0} finish or curtain marks total`
        + (tagList ? `. Breakdown by tag: ${tagList}.` : "."),
      );
    }
  }

  if (wantsCW && focus.length > 1) {
    lines.push(`Combined curtain/CW total across listed sheets: ${focus.reduce((n, r) => n + (Number(r.curtain_cw) || 0), 0)}.`);
  }
  if (wantsSD && focus.length > 1) {
    lines.push(`Combined steel/sliding SD total across listed sheets: ${focus.reduce((n, r) => n + (Number(r.steel_sliding_sd) || 0), 0)}.`);
  }
  if (wantsGD && focus.length > 1) {
    lines.push(`Combined glass GD total across listed sheets: ${focus.reduce((n, r) => n + (Number(r.glass_door_gd) || 0), 0)}.`);
  }
  if (genericDoors && focus.length > 1) {
    const doorTotal = focus.reduce((n, r) => n + (Number(r.doors) || 0), 0);
    lines.push(`Combined door total across listed sheets: ${doorTotal}.`);
  }
  if (wantsWindows && focus.length > 1) {
    const windowTotal = focus.reduce((n, r) => n + (Number(r.windows) || 0), 0);
    lines.push(`Combined window total across listed sheets: ${windowTotal}.`);
  }

  if (wantsMasks && (shapes || []).length) {
    lines.push("", "SECTION: Takeoff masks");
    for (const r of buildSheetAreaTotals(shapes, conditions)) {
      if ((matched.length || sheetHint) && !fileSet.has(String(r.file || "").toLowerCase())
        && !(sheetHint && String(r.file || "").toLowerCase().includes(String(sheetHint).toLowerCase()))) continue;
      lines.push(`${r.file}: ${r.masks || 0} masks and ${r.cutouts || 0} cutouts`
        + (r.floor_sf != null ? `; net floor area ${r.floor_sf} SF` : "")
        + ".");
    }
  }

  lines.push("", "SECTION: Confidence");
  lines.push("High for these quantities. Values come from live detection on the open canvas after the drawings corpus lacked a usable count.");
  return lines.join("\n");
}

/**
 * @param {string} question
 * @param {{ projectContext?: string, liveSummary?: string }} [opts]
 * @returns {Promise<QueryResponse>}
 */
export async function queryChat(question, opts = {}) {
  const ctx = (opts.projectContext || "").trim();
  const liveSummary = (opts.liveSummary || "").trim();
  // Embed live counts in the query so quantity answers work even if the
  // remote RAG service ignores optional project_context.
  const query = liveSummary
    ? `${question.trim()}\n\n${liveSummary}`
    : question;
  const body = { query };
  if (ctx) body.project_context = ctx;
  const response = await fetch(`${RAG_BASE}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Query failed: ${response.status}`);
  return response.json();
}

/**
 * Stream a query answer via SSE (events: answer, citations, done).
 * @param {string} question
 * @param {{ onAnswer?: (answer: string) => void, onCitations?: (citations: Citation[]) => void, onDone?: () => void, onError?: (err: Error) => void, projectContext?: string }} handlers
 */
export async function queryChatStream(question, handlers = {}) {
  const body = { query: question };
  const ctx = (handlers.projectContext || "").trim();
  if (ctx) body.project_context = ctx;
  const response = await fetch(`${RAG_BASE}/query/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Stream query failed: ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      try {
        const payload = JSON.parse(line.slice(5).trim());
        if (payload.type === "answer") handlers.onAnswer?.(payload.answer);
        if (payload.type === "citations") handlers.onCitations?.(payload.citations);
        if (payload.type === "done") handlers.onDone?.();
      } catch {
        /* ignore malformed SSE chunks */
      }
    }
  }
  handlers.onDone?.();
}

/** @param {number} chunkId */
export function citationImageUrl(chunkId) {
  return `${RAG_BASE}/citation/${chunkId}/image`;
}

/**
 * URL that serves the original source file (PDF opens in browser; Word/Excel download → OS app).
 * @param {{ chunk_id?: number, doc_path?: string, page_no?: number }} citation
 * @param {{ download?: boolean }} [opts]
 */
export function citationFileUrl(citation, opts = {}) {
  if (citation?.chunk_id > 0) {
    const q = opts.download ? "?download=true" : "";
    return `${RAG_BASE}/citation/${citation.chunk_id}/file${q}`;
  }
  if (citation?.doc_path) {
    const q = new URLSearchParams({ path: citation.doc_path });
    if (opts.download) q.set("download", "true");
    return `${RAG_BASE}/file?${q.toString()}`;
  }
  return null;
}

/**
 * Open the citation's source file.
 * PDFs: fetch → blob URL in a new tab (more reliable than proxy navigation), with #page=N.
 * Word/Excel/etc.: fetch → download so the OS opens the default app.
 * @param {{ chunk_id?: number, doc_path?: string, page_no?: number }} citation
 */
function normPath(p) {
  return (p || "").replace(/\\/g, "/").toLowerCase();
}

function canonSheetId(s) {
  return (s || "").toUpperCase().replace(/[\s.-]/g, "");
}

/**
 * Map a RAG citation to a takeoff sheet key (`file` or `file#page`) if the PDF
 * is already in the project Files list.
 * @param {Citation|{ doc_path?: string, page_no?: number, sheet_id?: string|null }} citation
 * @param {string[]} sheetNames — project sheet file paths (`sheets[].name`)
 * @param {Record<string, string>} [galleryLabels] — sheetKey → title-block id (A1105…)
 * @returns {string|null}
 */
export function sheetKeyForCitation(citation, sheetNames, galleryLabels = {}) {
  if (!citation) return null;
  const pageNo = citation.page_no != null && citation.page_no >= 0 ? citation.page_no + 1 : 1;
  const withPage = (name) => (pageNo > 1 ? `${name}#${pageNo}` : name);

  if (citation.sheet_id) {
    const sid = canonSheetId(citation.sheet_id);
    for (const [key, label] of Object.entries(galleryLabels)) {
      if (!label) continue;
      const lbl = canonSheetId(label);
      if (lbl === sid || lbl.includes(sid) || sid.includes(lbl)) {
        const { file } = parseSheetKey(key);
        if (sheetNames.includes(file)) return withPage(file);
      }
    }
    for (const name of sheetNames) {
      const base = canonSheetId(name.split("/").pop() || "");
      if (base.includes(sid)) return withPage(name);
    }
  }

  const docPath = normPath(citation.doc_path);
  if (docPath) {
    for (const name of sheetNames) {
      const n = normPath(name);
      if (n === docPath || docPath.endsWith(n) || n.endsWith(docPath)) return withPage(name);
    }
    const base = docPath.split("/").pop();
    if (base) {
      for (const name of sheetNames) {
        const nameBase = normPath(name.split("/").pop());
        if (nameBase === base) return withPage(name);
      }
    }
  }
  return null;
}

export async function openCitationFile(citation) {

  const url = citationFileUrl(citation);
  if (!url) throw new Error("No file path on this citation");

  const path = (citation.doc_path || "").toLowerCase();
  const isPdf = path.endsWith(".pdf");
  const name = (citation.doc_path || "document").replace(/^.*[/\\]/, "") || "document";

  const response = await fetch(url);
  if (!response.ok) {
    let detail = `Could not open file (${response.status})`;
    try {
      const body = await response.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch { /* ignore */ }
    throw new Error(detail);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  if (isPdf) {
    const page = citation.page_no != null && citation.page_no >= 0 ? `#page=${citation.page_no + 1}` : "";
    const win = window.open(objectUrl + page, "_blank", "noopener,noreferrer");
    if (!win) {
      // Popup blocked — fall back to download
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = name;
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    return;
  }

  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

/**
 * Deterministic room → finish schedule lookup (no LLM).
 * @param {string} room
 * @returns {Promise<FinishForRoomResponse>}
 */
export async function finishForRoom(room) {
  const response = await fetch(`${RAG_BASE}/finish-for-room`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room }),
  });
  if (!response.ok) throw new Error(`finish-for-room failed: ${response.status}`);
  return response.json();
}
