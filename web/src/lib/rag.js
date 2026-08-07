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
  }
  return Object.values(bySheet).map((r) => compact({
    sheet: r.sheet,
    file: r.file,
    doors: r.doors || undefined,
    windows: r.windows || undefined,
    finish_marks: r.finish || undefined,
    type_marks: r.type || undefined,
    detail_marks: r.detail || undefined,
    total_symbols: r.total_symbols,
    door_tags: Object.keys(r.door_tags).length ? r.door_tags : undefined,
    window_tags: Object.keys(r.window_tags).length ? r.window_tags : undefined,
    finish_tags: Object.keys(r.finish_tags).length ? r.finish_tags : undefined,
  }));
}

/**
 * Short plain-text counts for embedding in the question (survives backends that ignore project_context).
 * @param {any[]} planSymbols
 * @param {any[]} shapes
 * @param {any[]} conditions
 */
export function buildLiveCountsSummary(planSymbols = [], shapes = [], conditions = []) {
  const sheetTotals = buildSheetSymbolTotals(planSymbols);
  if (!sheetTotals.length && !(shapes || []).length) return "";
  const lines = [
    "AUTHORITATIVE LIVE DETECTIONS from the open takeoff canvas.",
    "For door, window, curtain/finish mark, and mask quantity questions, use these numbers. Do not say the total is unknown when a sheet is listed below.",
  ];
  for (const r of sheetTotals) {
    const parts = [];
    if (r.doors) {
      const tags = r.door_tags
        ? Object.entries(r.door_tags).map(([t, n]) => `${t}=${n}`).join(", ")
        : "";
      parts.push(`${r.doors} doors${tags ? ` (${tags})` : ""}`);
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
  const condById = Object.fromEntries((conditions || []).map((c) => [c.id, c]));
  const maskBySheet = {};
  for (const s of shapes || []) {
    const file = sheetFileName(s.sheet_id);
    if (!maskBySheet[file]) maskBySheet[file] = { masks: 0, cutouts: 0, finishes: {} };
    if (s.measure_role === "deduct") maskBySheet[file].cutouts += 1;
    else maskBySheet[file].masks += 1;
    const ft = (condById[s.condition_id]?.finish_tag || "").trim();
    if (ft) maskBySheet[file].finishes[ft] = (maskBySheet[file].finishes[ft] || 0) + 1;
  }
  for (const [file, m] of Object.entries(maskBySheet)) {
    const fin = Object.entries(m.finishes).map(([t, n]) => `${t}=${n}`).join(", ");
    lines.push(`- ${file} takeoff: ${m.masks} masks, ${m.cutouts} cutouts${fin ? `; finishes ${fin}` : ""}`);
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
    note: "AUTHORITATIVE live detections. For door/window/finish/mask counts, use sheet_symbol_totals. Do not say unknown if a sheet is listed.",
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
  if (/\b(total|how many|count|number of|qty|quantity)\b/i.test(q)) {
    // Count questions need a concrete number in the answer body.
    if (!/\b\d+\b/.test(text)) return false;
    if (/does not (include|contain|provide|list|state).{0,60}(total|count|number|quantity)/i.test(text)) return false;
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
 * Deterministic answer for door/window/symbol total questions from live detections.
 * Returns null when the question is not a count query or no matching sheet data exists.
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
  const wantsMasks = /\b(mask|takeoff|cutout)\b/.test(q);
  // Only for clear quantity questions — leave spec/detail Qs to RAG + API.
  const wantsCount = /\b(total|how many|count|number of|qty|quantity)\b/.test(q);
  if (!wantsCount || !(wantsDoors || wantsWindows || wantsFinish || wantsMasks)) return null;

  const sheetTotals = buildSheetSymbolTotals(planSymbols);
  if (!sheetTotals.length && !(shapes || []).length) return null;

  const sheetHint = (q.match(/\ba1\d{3}\b/i) || q.match(/\b[a-z]\d{3,5}\b/i) || [])[0] || "";
  const matched = sheetTotals.filter((r) => {
    const file = String(r.file || "").toLowerCase();
    const sheet = String(r.sheet || "").toLowerCase();
    if (q.includes(file) || q.includes(sheet)) return true;
    if (sheetHint && (file.includes(sheetHint) || sheet.includes(sheetHint))) return true;
    if (/\b1st\b/.test(q) && /1st/.test(file)) return true;
    if (/\b2nd\b/.test(q) && /2nd/.test(file)) return true;
    return false;
  });
  const rows = matched.length ? matched : (sheetHint ? [] : sheetTotals);
  if (!rows.length && (wantsDoors || wantsWindows || wantsFinish)) return null;

  const focus = rows.length ? rows : sheetTotals;
  const titleSheet = matched.length === 1 ? matched[0].file : (matched.length ? "matching sheets" : "open project sheets");
  const lines = [
    `TITLE: ${wantsDoors ? "Door" : wantsWindows ? "Window" : wantsFinish ? "Finish mark" : "Takeoff"} totals for ${titleSheet}`,
    "",
    "SECTION: Summary",
    "The drawings corpus did not provide a reliable quantity for this question. Totals below are taken from live plan symbol detection on the open takeoff.",
    "",
    "SECTION: Quantities",
  ];

  for (const r of focus) {
    if (wantsDoors) {
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
    if (wantsFinish) {
      const tagList = r.finish_tags
        ? Object.entries(r.finish_tags).sort((a, b) => a[0].localeCompare(b[0])).map(([t, n]) => `${t}: ${n}`).join(", ")
        : "";
      lines.push(
        `${r.file}: ${r.finish_marks || 0} finish or curtain marks total`
        + (tagList ? `. Breakdown by tag: ${tagList}.` : "."),
      );
    }
  }

  if (wantsMasks && (shapes || []).length) {
    lines.push("", "SECTION: Takeoff masks");
    const byFile = {};
    for (const s of shapes) {
      const file = sheetFileName(s.sheet_id);
      if (matched.length && !matched.some((m) => sheetFileName(m.sheet).toLowerCase() === file.toLowerCase())) {
        if (sheetHint && !file.toLowerCase().includes(String(sheetHint).toLowerCase())) continue;
      }
      if (!byFile[file]) byFile[file] = { masks: 0, cutouts: 0 };
      if (s.measure_role === "deduct") byFile[file].cutouts += 1;
      else byFile[file].masks += 1;
    }
    for (const [file, m] of Object.entries(byFile)) {
      lines.push(`${file}: ${m.masks} masks and ${m.cutouts} cutouts.`);
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
