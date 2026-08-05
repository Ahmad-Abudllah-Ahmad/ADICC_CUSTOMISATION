// Plan-symbol extract + cross-sheet match (pure, pdfjs-free).
//
// Reads positioned PDF text tokens (the same {str,x,y,h} shape scheduleParse
// uses) and keeps ONLY short architectural callout marks — door/window tags
// in circles (D06), boxed type marks (T1-08), finish codes on the plan
// (CPT-1). Everything else (notes, dimensions, title-block prose) is dropped.
//
// Cross-sheet link: the same normalized tag on another uploaded sheet is
// attached as a match so hover can show "also on A-102". Schedule/condition
// enrichment fills known fields; blanks stay editable via SymbolNotes.

import { lookupScheduleKb, tagLookupKeys } from "./symbolScheduleKb";

export type SymbolKind = "door" | "window" | "type" | "finish" | "detail";

export type SymbolToken = { str: string; x: number; y: number; h: number; w?: number };

export type SymbolKindInfo = { tag: string; kind: SymbolKind };

/** One extracted mark in image (viewport) px — center + hit box. */
export interface RawPlanSymbol {
  tag: string;
  kind: SymbolKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Hover outline shape — circle for door/SD/GD marks, rect for boxed type marks. */
  outline?: "circle" | "rect";
  /** Room name from nearby PDF text (e.g. "GENERAL STORE-04" above PD1-39). */
  room_name?: string;
}

export interface SymbolMatchRef {
  sheet_id: string;
  x: number;
  y: number;
  kind: SymbolKind;
}

/** Schedule / condition fields shown on hover (any may be empty). */
export interface SymbolScheduleInfo {
  finish_tag?: string;
  description?: string;
  manufacturer?: string;
  style?: string;
  color?: string;
  size?: string;
  remarks?: string;
  fire_rating?: string;
  floors?: string;
  type?: string;
  /** Schedule sheet this row was parsed from (for floating viewer). */
  source_sheet?: string;
  source_title?: string;
  source_bbox?: { x: number; y: number; w: number; h: number };
}

/** User-entered overrides for blank (or incorrect) fields — keyed externally. */
export type SymbolNotes = {
  room_name?: string;
  description?: string;
  manufacturer?: string;
  style?: string;
  color?: string;
  size?: string;
  remarks?: string;
  type?: string;
  fire_rating?: string;
  floors?: string;
};

export interface PlanSymbol extends RawPlanSymbol {
  id: string;
  sheet_id: string;
  matches: SymbolMatchRef[];
  schedule: SymbolScheduleInfo;
}

// Door / window marks (circular tags on plans): D06, D03, W12, SD12 (sliding door)
const DOOR_RE = /^D\d{1,3}[A-Z]?$/;
const SLIDING_DOOR_RE = /^SD\d{1,3}[A-Z]?$/;
const WINDOW_RE = /^W\d{1,3}[A-Z]?$/;
// Boxed type / unit marks: T1-08, PD1-39, 1ST-02 (digit-led unit codes)
const TYPE_RE = /^(?:T\d{1,2}-\d{2}[A-Z]?|[A-Z]{1,3}\d+-\d{2,3}[A-Z]?|\d{1,2}[A-Z]{1,3}-\d{2,3}[A-Z]?)$/;
// Finish codes placed on the plan (not single-letter noise): CPT-1, LVT-2, RB-1
const FINISH_RE = /^[A-Z]{2,4}-[A-Z0-9]{1,4}$/;
// Detail callout bubble bottom (sheet id): A4103, S2101 — letter + 4–5 digits
const DETAIL_RE = /^[A-Z]\d{4,5}$/;
// Title-block sheet numbers to skip when they aren't door-shaped (A003, A-101)
const SHEET_NO_RE = /^[A-Z]{1,3}[-.]?\d{1,3}(\.\d{1,2})?[A-Z]?$/;
// Room / space names printed above a mark (STORE-04, STAIRCASE-1, LIVING ROOM)
const ROOM_NAME_RE = /^(?:[A-Z][A-Z0-9/&.\-']*(?:[ -]+[A-Z0-9/&.\-']+){0,5})$/;

const SKIP = new Set([
  "SCALE", "NORTH", "TRUE", "PLAN", "FLOOR", "LEVEL", "SHEET", "DRAWING",
  "REV", "DATE", "PROJECT", "TITLE", "TYP", "SEE", "NOTE", "NOTES",
  "DETAIL", "SECTION", "ELEVATION", "SIM", "OPP", "DN", "UP",
]);

/** Normalize mark text — fold case/spaces and fix common PDF glyph misreads. */
function normalizeMark(raw: string): string {
  let tag = (raw || "").trim().toUpperCase().replace(/\s+/g, "");
  // A vertical stroke through S (wall line through the circle) reads as $ in some PDFs.
  if (/^\$D\d/.test(tag)) tag = `S${tag.slice(1)}`;
  // A vertical stroke through leading 1 on boxed type marks (1ST-26) reads as | or I.
  if (/^[|Il][A-Z]{2,3}-\d{2,3}[A-Z]?$/.test(tag)) tag = `1${tag.slice(1)}`;
  if (/^1[|Il]([A-Z]{2,3}-\d{2,3}[A-Z]?)$/.test(tag)) tag = `1${tag.slice(2)}`;
  return tag;
}

/** Circle vs rect overlay — D/SD/GD marks are circled on plan; type marks are boxed. */
function symbolOutline(tag: string, kind: SymbolKind): "circle" | "rect" {
  if (kind === "door" || kind === "window" || kind === "detail") return "circle";
  if (kind === "finish" && /^GD-\d/.test(tag)) return "circle";
  if (kind === "type") return "rect";
  return "rect";
}

function tokenW(t: SymbolToken): number {
  return Math.max(t.w || 0, (t.str?.length || 1) * Math.max(6, t.h || 10) * 0.55);
}

function sameMarkLine(a: SymbolToken, b: SymbolToken): boolean {
  const tol = Math.max(a.h || 10, b.h || 10) * 0.95;
  return Math.abs(a.y - b.y) <= tol;
}

/** Horizontal or vertical split runs (rotated GD-02 in a circle, etc.). */
function chainAligned(chain: SymbolToken[]): boolean {
  if (chain.length <= 1) return true;
  const h0 = Math.max(6, chain[0].h || 10);
  const xTol = h0 * 1.15;
  const yTol = h0 * 0.95;

  const horiz = chain.every((t, k) => k === 0 || sameMarkLine(chain[0], t));
  if (horiz) {
    for (let k = 1; k < chain.length; k++) {
      const prev = chain[k - 1], cur = chain[k];
      const gap = cur.x - (prev.x + tokenW(prev));
      const tol = Math.max(prev.h || 10, cur.h || 10) * 3;
      if (gap < -tol * 0.4 || gap > tol) return false;
    }
    return true;
  }

  const vert = chain.every((t, k) => k === 0 || Math.abs(t.x - chain[0].x) <= xTol);
  if (!vert) return false;
  const sorted = [...chain].sort((a, b) => a.y - b.y);
  for (let k = 1; k < sorted.length; k++) {
    const prev = sorted[k - 1], cur = sorted[k];
    const gap = cur.y - prev.y;
    const tol = Math.max(prev.h || 10, cur.h || 10) * 2.8;
    if (gap < -tol * 0.25 || gap > tol) return false;
  }
  return true;
}

function chainJoinOrder(chain: SymbolToken[]): SymbolToken[] {
  const horiz = chain.every((t, k) => k === 0 || sameMarkLine(chain[0], t));
  return horiz ? chain : [...chain].sort((a, b) => a.y - b.y);
}

/** Tight glyph bounds (center x,y + size) from one or more PDF text tokens. */
function boundsFromParts(parts: SymbolToken[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of parts) {
    const h = Math.max(6, p.h || 10);
    const w = tokenW(p);
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y - h);
    x1 = Math.max(x1, p.x + w);
    y1 = Math.max(y1, p.y + h * 0.12);
  }
  const w = Math.max(x1 - x0, 6);
  const h = Math.max(y1 - y0, 6);
  return { x: x0 + w / 2, y: y0 + h / 2, w, h };
}

/** Join split PDF runs into one mark string (GD+02→GD-02, 1+ST-26→1ST-26, SD+12→SD12). */
function joinMarkParts(parts: string[]): string {
  let s = parts[0] || "";
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (/^-\d/.test(p)) s += p;
    else if (/^(SD|D|W)$/i.test(s) && /^\d/.test(p)) s += p;
    else if (/^\d/.test(p) && !s.endsWith("-") && /[A-Z]$/.test(s)) s += `-${p}`;
    else s += p;
  }
  return s.replace(/--+/g, "-");
}

function makePlanSymbol(parts: SymbolToken[], hit: SymbolKindInfo): RawPlanSymbol {
  const b = boundsFromParts(parts);
  const outline = symbolOutline(hit.tag, hit.kind);
  let { w, h } = b;
  if (outline === "circle") {
    const side = Math.max(w, h);
    w = side;
    h = side;
  }
  return { tag: hit.tag, kind: hit.kind, x: b.x, y: b.y, w, h, outline };
}

/** Classify a raw text run as a plan symbol, or null if it isn't one. */
export function classifyPlanSymbol(raw: string): SymbolKindInfo | null {
  const tag = normalizeMark(raw);
  if (!tag || tag.length < 2 || tag.length > 12) return null;
  if (SKIP.has(tag)) return null;
  if (SLIDING_DOOR_RE.test(tag)) return { tag, kind: "door" };
  if (DOOR_RE.test(tag)) return { tag, kind: "door" };
  if (WINDOW_RE.test(tag)) return { tag, kind: "window" };
  if (TYPE_RE.test(tag)) return { tag, kind: "type" };
  if (FINISH_RE.test(tag)) return { tag, kind: "finish" };
  if (DETAIL_RE.test(tag)) return { tag, kind: "detail" };
  // Short sheet numbers (A-101, A003) are not plan marks
  if (SHEET_NO_RE.test(tag) && !DOOR_RE.test(tag) && !WINDOW_RE.test(tag)) return null;
  return null;
}

type MarkCandidate = { parts: SymbolToken[]; tag: string };

/** Join split PDF runs (SD+12, GD+-02, 1+ST-26, D+06, …). */
function collectMarkCandidates(tokens: SymbolToken[]): MarkCandidate[] {
  const sorted = [...tokens].sort((a, b) => a.y - b.y || a.x - b.x);
  const used = new Set<number>();
  const out: MarkCandidate[] = [];

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    let best: MarkCandidate | null = null;

    for (let len = Math.min(4, sorted.length - i); len >= 1; len--) {
      const chain = sorted.slice(i, i + len);
      if (chain.some((_, k) => k > 0 && used.has(i + k))) continue;
      if (len > 1 && !chainAligned(chain)) continue;
      const ordered = chainJoinOrder(chain);
      const parts = ordered.map((t) => normalizeMark(t.str || ""));
      const tag = len === 1 ? parts[0] : joinMarkParts(parts);
      if (!tag || !classifyPlanSymbol(tag)) continue;
      if (!best || len > best.parts.length) best = { parts: ordered, tag };
    }

    if (best) {
      out.push(best);
      for (let k = 0; k < best.parts.length; k++) used.add(i + k);
    }
  }
  return out;
}

/** True if a text run looks like a room / space name (not a code mark). */
export function looksLikeRoomName(raw: string): boolean {
  const s = (raw || "").trim().replace(/\s+/g, " ").toUpperCase();
  if (!s || s.length < 3 || s.length > 48) return false;
  if (classifyPlanSymbol(s)) return false;
  if (SKIP.has(s)) return false;
  if (/^\d+(\.\d+)?["']?$/.test(s)) return false;           // dimension
  if (/^\d{1,2}[A-Z]?$/.test(s)) return false;               // lone room number / detail #
  if (!ROOM_NAME_RE.test(s)) return false;
  // Prefer names that carry a letter word (STORE, GENERAL, LIVING…) —
  // pure digit-hyphen codes are marks, not names.
  if (!/[A-Z]{2,}/.test(s)) return false;
  return true;
}

/** Stable id for persistence of manual notes (sheet + tag + rounded anchor). */
export function symbolNoteKey(sheet_id: string, tag: string, x: number, y: number): string {
  return `${sheet_id}::${tag}::${Math.round(x)}::${Math.round(y)}`;
}

/**
 * Extract plan symbols from positioned text tokens.
 * Dedupes near-duplicate glyphs of the same tag (PDF often double-draws).
 * Attaches a nearby room name printed above the mark when present.
 */
export function extractPlanSymbols(tokens: SymbolToken[]): RawPlanSymbol[] {
  const toks = (tokens || []).filter((t) => (t.str || "").trim());
  const out: RawPlanSymbol[] = [];
  for (const c of collectMarkCandidates(toks)) {
    const hit = classifyPlanSymbol(c.tag);
    if (!hit) continue;
    out.push(makePlanSymbol(c.parts, hit));
  }
  const deduped = dedupeNearby(out);
  return attachRoomNames(deduped, toks);
}

/** Pair each mark with the closest room-name label sitting above it.
 *  Detail bubbles also pick up the callout number (top half: "4") as "DETAIL 4". */
function attachRoomNames(syms: RawPlanSymbol[], tokens: SymbolToken[]): RawPlanSymbol[] {
  // Candidate name runs — whole token strings that look like room names.
  const names: Array<{ text: string; x: number; y: number; h: number; w: number }> = [];
  const detailNos: Array<{ text: string; x: number; y: number; h: number; w: number }> = [];
  for (const t of tokens) {
    const text = (t.str || "").trim().replace(/\s+/g, " ").toUpperCase();
    const h = Math.max(6, t.h || 10);
    if (/^\d{1,2}$/.test(text)) {
      const w = Math.max(h, t.w || h);
      detailNos.push({ text, x: t.x + w * 0.5, y: t.y - h * 0.35, h, w });
      continue;
    }
    if (!looksLikeRoomName(text)) continue;
    const w = Math.max(h, t.w || text.length * h * 0.55);
    names.push({ text, x: t.x + w * 0.5, y: t.y - h * 0.35, h, w });
  }
  // Also merge stacked name lines (GENERAL + STORE-04 → GENERAL STORE-04)
  // when two name tokens sit on consecutive lines above the same x band.
  const mergedNames = mergeStackedRoomNames(names);

  return syms.map((s) => {
    let best: { text: string; score: number } | null = null;
    for (const n of mergedNames) {
      // Name must sit ABOVE the mark (smaller y) and within a tight band.
      const dy = s.y - n.y;                       // >0 ⇒ name is above
      if (dy < s.h * 0.15 || dy > Math.max(s.h, n.h) * 5.5) continue;
      const dx = Math.abs(s.x - n.x);
      const maxDx = Math.max(s.w, n.w) * 0.85 + s.h * 1.2;
      if (dx > maxDx) continue;
      // Prefer closer vertically, then horizontally.
      const score = dy + dx * 0.35;
      if (!best || score < best.score) best = { text: n.text, score };
    }
    if (best) return { ...s, room_name: best.text };
    // Detail callout: pair sheet id (A4103) with the number in the top half
    if (s.kind === "detail") {
      let bestNo: { text: string; score: number } | null = null;
      for (const n of detailNos) {
        const dy = s.y - n.y;
        if (dy < s.h * 0.05 || dy > s.h * 2.8) continue;
        const dx = Math.abs(s.x - n.x);
        if (dx > s.w * 0.75) continue;
        const score = dy + dx * 0.5;
        if (!bestNo || score < bestNo.score) bestNo = { text: n.text, score };
      }
      if (bestNo) return { ...s, room_name: `DETAIL ${bestNo.text}` };
    }
    return s;
  });
}

/** Join two room-name lines that stack (GENERAL above STORE-04). */
function mergeStackedRoomNames(
  names: Array<{ text: string; x: number; y: number; h: number; w: number }>,
): Array<{ text: string; x: number; y: number; h: number; w: number }> {
  if (names.length < 2) return names;
  const sorted = [...names].sort((a, b) => a.y - b.y || a.x - b.x);
  const used = new Set<number>();
  const out: typeof names = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const a = sorted[i];
    let joined = a;
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      const b = sorted[j];
      const dy = b.y - joined.y;
      if (dy < joined.h * 0.4 || dy > joined.h * 2.2) continue;
      if (Math.abs(b.x - joined.x) > Math.max(joined.w, b.w) * 0.7) continue;
      // b is the lower line — combine "GENERAL" + "STORE-04"
      joined = {
        text: `${joined.text} ${b.text}`.replace(/\s+/g, " ").trim(),
        x: (joined.x + b.x) / 2,
        y: (joined.y + b.y) / 2,
        h: joined.h + dy,
        w: Math.max(joined.w, b.w),
      };
      used.add(j);
    }
    out.push(joined);
    // Keep the original single-line names too (STORE-04 alone still matches)
    if (joined.text !== a.text) out.push(a);
  }
  return out;
}

/** Room / space labels printed on the plan (GYM, GENERAL STORE-04, …). */
export type RoomLabel = { text: string; x: number; y: number; h: number; w: number };

/** Extract positioned room-name labels from PDF text tokens (for BOQ room detection). */
export function extractRoomLabels(tokens: SymbolToken[]): RoomLabel[] {
  const names: RoomLabel[] = [];
  for (const t of tokens || []) {
    const text = (t.str || "").trim().replace(/\s+/g, " ").toUpperCase();
    if (!looksLikeRoomName(text)) continue;
    const h = Math.max(6, t.h || 10);
    const w = Math.max(h, t.w || text.length * h * 0.55);
    names.push({ text, x: t.x + w * 0.5, y: t.y - h * 0.35, h, w });
  }
  return mergeStackedRoomNames(names);
}

/** Drop the weaker of two same-tag marks within ~1.2× glyph size. */
function dedupeNearby(syms: RawPlanSymbol[]): RawPlanSymbol[] {
  const sorted = [...syms].sort((a, b) => a.tag.localeCompare(b.tag) || a.y - b.y || a.x - b.x);
  const kept: RawPlanSymbol[] = [];
  for (const s of sorted) {
    const near = kept.find((k) =>
      k.tag === s.tag
      && Math.hypot(k.x - s.x, k.y - s.y) < Math.max(k.h, s.h) * 1.2);
    if (near) {
      // Prefer the larger glyph (more likely the callout, not a tiny leader)
      if (s.w * s.h > near.w * near.h) {
        near.x = s.x; near.y = s.y; near.w = s.w; near.h = s.h; near.kind = s.kind;
        if (s.room_name) near.room_name = s.room_name;
      } else if (s.room_name && !near.room_name) {
        near.room_name = s.room_name;
      }
      continue;
    }
    kept.push({ ...s });
  }
  return kept;
}

/** Attach sheet ids and stable ids; link same-tag marks across sheets. */
export function buildPlanSymbolIndex(
  bySheet: Record<string, RawPlanSymbol[]>,
): PlanSymbol[] {
  const flat: PlanSymbol[] = [];
  for (const [sheet_id, list] of Object.entries(bySheet || {})) {
    (list || []).forEach((s, i) => {
      flat.push({
        ...s,
        id: `${sheet_id}::${s.tag}::${i}`,
        sheet_id,
        matches: [],
        schedule: {},
      });
    });
  }
  const byTag = new Map<string, PlanSymbol[]>();
  for (const s of flat) {
    const arr = byTag.get(s.tag) || [];
    arr.push(s);
    byTag.set(s.tag, arr);
  }
  for (const s of flat) {
    s.matches = (byTag.get(s.tag) || [])
      .filter((o) => o.id !== s.id)
      .map((o) => ({ sheet_id: o.sheet_id, x: o.x, y: o.y, kind: o.kind }));
  }
  return flat;
}

type CondLike = {
  finish_tag?: string;
  name?: string;
  description?: string;
  materials?: Array<{ name?: string; manufacturer?: string }>;
};
type RowLike = {
  finish_tag?: string;
  description?: string;
  manufacturer?: string;
  style?: string;
  spec_color?: string;
  size?: string;
  remarks?: string;
};

/** Optional KB row from symbolScheduleKb (door/finish schedule sheets). */
export type KbRowLike = {
  tag?: string;
  room_name?: string;
  description?: string;
  manufacturer?: string;
  style?: string;
  color?: string;
  size?: string;
  remarks?: string;
  fire_rating?: string;
  floors?: string;
  type?: string;
  source_sheet?: string;
  source_title?: string;
  source_bbox?: { x: number; y: number; w: number; h: number };
};

function kbForTag(kb: KbRowLike[] | Map<string, KbRowLike> | undefined, tag: string): KbRowLike | undefined {
  if (!kb || !tag) return undefined;
  // Same key variants as lookupScheduleKb (D01/D-1, CW-06/CW06, …) so hover
  // enrichment matches schedule-PDF rows the BOQ path already resolves.
  if (kb instanceof Map) {
    return (lookupScheduleKb(kb, tag) as KbRowLike | null) || undefined;
  }
  for (const k of tagLookupKeys(tag)) {
    const hit = kb.find((e) => (e.tag || "").toUpperCase() === k.toUpperCase());
    if (hit) return hit;
  }
  return undefined;
}

/** Fill schedule fields from imported schedule rows, project KB, and/or conditions. */
export function enrichSymbolsWithSchedule(
  symbols: PlanSymbol[],
  opts: { conditions?: CondLike[]; rows?: RowLike[]; kb?: KbRowLike[] | Map<string, KbRowLike> } = {},
): PlanSymbol[] {
  const rowBy = new Map<string, RowLike>();
  for (const r of opts.rows || []) {
    const t = (r.finish_tag || "").trim().toUpperCase();
    if (t) rowBy.set(t, r);
  }
  const condBy = new Map<string, CondLike>();
  for (const c of opts.conditions || []) {
    const t = (c.finish_tag || "").trim().toUpperCase();
    if (t) condBy.set(t, c);
  }
  return symbols.map((s) => {
    const row = rowBy.get(s.tag);
    const cond = condBy.get(s.tag);
    const kb = kbForTag(opts.kb, s.tag);
    const mat0 = cond?.materials?.[0];
    const schedule: SymbolScheduleInfo = {
      finish_tag: row?.finish_tag || cond?.finish_tag || (s.kind === "finish" ? s.tag : undefined),
      description: row?.description || kb?.description || cond?.description || cond?.name || undefined,
      manufacturer: row?.manufacturer || kb?.manufacturer || mat0?.manufacturer || undefined,
      style: row?.style || kb?.style || mat0?.name || undefined,
      color: row?.spec_color || kb?.color || undefined,
      size: row?.size || kb?.size || undefined,
      remarks: row?.remarks || kb?.remarks || undefined,
      fire_rating: kb?.fire_rating || undefined,
      floors: kb?.floors || undefined,
      type: kb?.type || undefined,
      source_sheet: kb?.source_sheet || undefined,
      source_title: kb?.source_title || undefined,
      source_bbox: kb?.source_bbox || undefined,
    };
    // Prefer KB room for door/window (schedule is source of truth); plan label otherwise
    const room_name = (s.kind === "door" || s.kind === "window")
      ? (kb?.room_name || s.room_name)
      : (s.room_name || kb?.room_name);
    // Drop empty keys so the UI can treat missing as "enter manually"
    for (const k of Object.keys(schedule) as (keyof SymbolScheduleInfo)[]) {
      if (k === "source_bbox") {
        if (!schedule.source_bbox) delete schedule.source_bbox;
        continue;
      }
      if (!schedule[k] || !String(schedule[k]).trim()) delete schedule[k];
    }
    return room_name && room_name !== s.room_name
      ? { ...s, room_name, schedule }
      : { ...s, schedule };
  });
}

/** Merge schedule + manual notes for display (manual wins on non-empty). */
export function resolveSymbolFields(
  schedule: SymbolScheduleInfo,
  notes?: SymbolNotes | null,
  roomName?: string | null,
): Required<SymbolNotes> & { finish_tag: string } {
  const n = notes || {};
  const pick = (a?: string, b?: string, c?: string) =>
    (a && String(a).trim()) || (b && String(b).trim()) || (c && String(c).trim()) || "";
  return {
    finish_tag: pick(schedule.finish_tag),
    room_name: pick(n.room_name, roomName || undefined),
    description: pick(n.description, schedule.description),
    manufacturer: pick(n.manufacturer, schedule.manufacturer),
    style: pick(n.style, schedule.style),
    color: pick(n.color, schedule.color),
    size: pick(n.size, schedule.size),
    remarks: pick(n.remarks, schedule.remarks),
    type: pick(n.type, schedule.type),
    fire_rating: pick(n.fire_rating, schedule.fire_rating),
    floors: pick(n.floors, schedule.floors),
  };
}

/** Hit-test a point against symbol boxes (image px, panel-local). */
export function hitPlanSymbol(
  symbols: PlanSymbol[],
  sheet_id: string,
  x: number,
  y: number,
  pad = 2,
): PlanSymbol | null {
  let best: PlanSymbol | null = null;
  let bestD = Infinity;
  for (const s of symbols) {
    if (s.sheet_id !== sheet_id) continue;
    const hw = s.w / 2 + pad, hh = s.h / 2 + pad;
    if (x < s.x - hw || x > s.x + hw || y < s.y - hh || y > s.y + hh) continue;
    const d = Math.hypot(x - s.x, y - s.y);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

export const SYMBOL_KIND_LABEL: Record<SymbolKind, string> = {
  door: "Door mark",
  window: "Window mark",
  type: "Type mark",
  finish: "Finish code",
  detail: "Detail callout",
};
